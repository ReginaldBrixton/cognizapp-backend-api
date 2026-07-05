/**
 * Paystack payment confirmation helper.
 *
 * Verifies a Paystack transaction, updates the support payment and request
 * status, records the Paystack transaction, accrues referral rewards, and
 * sends email + WhatsApp notifications.
 */

import { getDb } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import { paystackService } from "../../../lib/paystack";
import type { AuthContext } from "../../auth/middleware";
import { DEFAULT_SUPPORT_TIMEZONE } from "../constants";
import { toCamel } from "./clients";
import { roundMoney } from "./payments";
import { addSupportEvent } from "./events";
import { ensureSupportMessageThread } from "./threads";
import { sendSupportEmail, sendSupportWhatsApp } from "./notifications";
import { invalidateSupportCache, invalidateProviderSupportCache } from "./cache";
import { accrueReferralReward } from "./referrals";

export async function confirmSupportPaystackPayment(input: {
	reference: string;
	auth?: AuthContext;
	requestId?: string;
}) {
	const db = getDb();
	const [payment] = await db`
    SELECT p.*, r.user_key_id AS request_user_key_id, r.payment_status AS request_payment_status,
      r.delivery_status, r.currency AS request_currency, r.title AS request_title,
      r.task_id AS request_task_id, r.deadline_at AS request_deadline_at,
      r.whatsapp_number AS request_whatsapp_number,
      c.email AS request_email
    FROM support_payments p
    INNER JOIN support_requests r ON r.id = p.request_id
    LEFT JOIN support_clients c ON c.id = r.client_id
    WHERE COALESCE(p.provider_reference, p.transaction_id) = ${input.reference}
      AND (${input.requestId ?? null}::uuid IS NULL OR p.request_id = ${input.requestId ?? null}::uuid)
    ORDER BY p.created_at DESC
    LIMIT 1
  `;
	if (!payment) throw new HttpError(404, "payment_not_found", "Paystack payment was not found");
	if (input.auth && payment.request_user_key_id !== input.auth.userId) {
		throw new HttpError(403, "forbidden", "This payment belongs to another account");
	}
	if (payment.provider === "paystack" && payment.status === "verified") {
		const [request] = await db`
      SELECT *
      FROM support_requests
      WHERE id = ${payment.request_id}
      LIMIT 1
    `;
		return {
			data: toCamel(payment),
			request: request ? toCamel(request) : null,
			paystack: { status: true, message: "Payment already verified" },
			verified: true,
			idempotent: true,
		};
	}

	const verification = await paystackService.verifyTransaction(input.reference);
	const data = (verification.data ?? {}) as Record<string, any>;
	const paid = String(data.status ?? "").toLowerCase() === "success";
	if (!paid) {
		return { data: toCamel(payment), paystack: verification, verified: false };
	}

	const metadata = (data.metadata ?? {}) as Record<string, any>;
	if (metadata.requestId && String(metadata.requestId) !== String(payment.request_id)) {
		throw new HttpError(
			400,
			"payment_metadata_mismatch",
			"Paystack metadata does not match this support request",
		);
	}
	const expectedAmount = Number(payment.amount ?? 0);
	const paidAmount = Math.round(Number(data.amount ?? 0)) / 100;
	const expectedCurrency = String(
		payment.currency ?? payment.request_currency ?? "GHS",
	).toUpperCase();
	const paidCurrency = String(data.currency ?? "").toUpperCase();
	if (Math.abs(paidAmount - expectedAmount) > 0.01 || paidCurrency !== expectedCurrency) {
		throw new HttpError(
			400,
			"payment_mismatch",
			"Paystack payment amount or currency does not match this support payment",
		);
	}

	const authorization = data.authorization as Record<string, any> | undefined;
	const [updatedPayment] = await db`
    UPDATE support_payments
    SET status = 'verified',
      provider = 'paystack',
      provider_reference = ${input.reference},
      provider_transaction_id = ${data.id ? String(data.id) : null},
      authorization_code = ${authorization?.authorization_code ? String(authorization.authorization_code) : null},
      channel = ${data.channel ? String(data.channel) : null},
      gateway_response = ${data.gateway_response ? String(data.gateway_response) : null},
      verified_payload = ${db.json(data)},
      verified_at = NOW(),
      rejection_reason = NULL,
      updated_at = NOW()
    WHERE id = ${payment.id}
    RETURNING *
  `;
	const [paymentTotals] = await db`
    SELECT
      COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'verified' AND p.provider = 'paystack'), 0)::numeric AS verified_amount,
      COALESCE(MAX(r.final_amount), MAX(r.payment_amount), MAX(r.quoted_amount), 0)::numeric AS total_amount,
      COALESCE(MAX(r.deposit_amount), 0)::numeric AS deposit_amount
    FROM support_payments p
    INNER JOIN support_requests r ON r.id = p.request_id
    WHERE p.request_id = ${payment.request_id}
  `;
	const verifiedAmount = Number(paymentTotals?.verified_amount ?? 0);
	const totalAmount = Number(paymentTotals?.total_amount ?? 0);
	const depositAmount = Number(paymentTotals?.deposit_amount ?? 0);
	const aggregateStatus =
		totalAmount <= 0 || verifiedAmount + 0.005 >= totalAmount
			? "paid"
			: depositAmount > 0 && verifiedAmount + 0.005 >= depositAmount
				? "deposit_paid"
				: "unpaid";
	const unlockDownload = aggregateStatus === "paid";
	await db`
    UPDATE support_deliveries
    SET is_locked = FALSE, unlocked_at = COALESCE(unlocked_at, NOW())
    WHERE request_id = ${payment.request_id} AND ${unlockDownload}
  `;
	const [updated] = await db`
    UPDATE support_requests
    SET payment_status = ${aggregateStatus},
      balance_amount = CASE
        WHEN ${unlockDownload} THEN 0
        ELSE GREATEST(${totalAmount}::numeric - ${verifiedAmount}::numeric, 0)
      END,
      payment_verified_at = NOW(),
      payment_notes = 'Paystack payment verified',
      preview_access = CASE
        WHEN ${unlockDownload} THEN 'clean_final'
        WHEN ${aggregateStatus === "deposit_paid"} THEN 'full_protected'
        ELSE preview_access
      END,
      submitted_at = COALESCE(submitted_at, NOW()),
      delivery_status = CASE
        WHEN ${unlockDownload} AND delivery_status = 'uploaded_locked' THEN 'download_unlocked'
        ELSE delivery_status
      END,
      status = CASE
        WHEN support_requests.status = 'draft' THEN 'submitted'
        ELSE support_requests.status
      END,
      updated_at = NOW()
    WHERE id = ${payment.request_id}
    RETURNING *
  `;
	await ensureSupportMessageThread(
		String(payment.request_id),
		String(payment.request_user_key_id ?? payment.user_key_id),
	);
	await db`
    INSERT INTO paystack_transactions (
      workspace_id, support_request_id, support_payment_id, user_key_id, purpose,
      amount, currency, provider_reference, provider_transaction_id,
      authorization_code, channel, gateway_response, status, verified_payload,
      metadata, verified_at
    )
    SELECT r.workspace_id, ${payment.request_id}, ${payment.id}, ${payment.user_key_id},
      'support_payment', ${payment.amount}, ${payment.currency}, ${input.reference},
      ${data.id ? String(data.id) : null},
      ${authorization?.authorization_code ? String(authorization.authorization_code) : null},
      ${data.channel ? String(data.channel) : null},
      ${data.gateway_response ? String(data.gateway_response) : null},
      'verified', ${db.json(data)}, ${db.json({ paymentType: payment.payment_type })}, NOW()
    FROM support_requests r
    WHERE r.id = ${payment.request_id}
    ON CONFLICT (provider, provider_reference) DO UPDATE SET
      support_payment_id = EXCLUDED.support_payment_id,
      status = 'verified',
      verified_payload = EXCLUDED.verified_payload,
      verified_at = NOW(),
      updated_at = NOW()
  `;

	await addSupportEvent(
		String(payment.request_id),
		(input.auth ??
			({
				actorId: String(payment.user_key_id),
				userId: String(payment.user_key_id),
				email: "",
				role: "system",
				actorType: "system",
				permissions: [],
				sessionId: "",
			}) as AuthContext),
		"payment.paystack_verified",
		"Paystack payment verified",
		{
			paymentId: updatedPayment.id,
			paymentType: updatedPayment.payment_type,
			reference: input.reference,
			paystackStatus: data.status,
			verifiedAmount,
			totalAmount,
			aggregateStatus,
		},
	);

	await accrueReferralReward(updatedPayment);

	const recipient = input.auth?.email ?? String(payment.request_email ?? "");
	if (recipient) {
		const deadlineLabel = payment.request_deadline_at
			? new Date(payment.request_deadline_at).toLocaleString("en-GB", {
					timeZone: DEFAULT_SUPPORT_TIMEZONE,
					dateStyle: "medium",
					timeStyle: "short",
				})
			: "the agreed deadline";
		void sendSupportEmail(
			recipient,
			String(payment.request_user_key_id ?? payment.user_key_id),
			"support.payment.verified",
			"Payment successful for your CognizApp request",
			`We have received your ${String(updatedPayment.payment_type ?? "support")} payment of ${String(updatedPayment.currency ?? payment.request_currency ?? "GHS")} ${Number(updatedPayment.amount ?? 0).toLocaleString()}. Your request "${String(payment.request_title ?? "Support request")}" is confirmed, and you will receive the completed work on or before ${deadlineLabel}.`,
			{
				requestId: String(payment.request_id),
				taskId: String(payment.request_task_id ?? ""),
				paymentId: String(updatedPayment.id),
				paymentType: String(updatedPayment.payment_type ?? ""),
				amount: Number(updatedPayment.amount ?? 0),
				currency: String(updatedPayment.currency ?? payment.request_currency ?? "GHS"),
				deadlineAt: payment.request_deadline_at ?? null,
				actionUrl: `/support/requests/${payment.request_id}`,
			},
		).catch((error) => console.warn("[support:email] Paystack success email failed", error));
		void sendSupportWhatsApp(
			String(payment.request_whatsapp_number ?? ""),
			String(payment.request_user_key_id ?? payment.user_key_id),
			"support.payment.verified",
			"Payment confirmed by CogniZap",
			`We have received your ${String(updatedPayment.payment_type ?? "support")} payment of ${String(updatedPayment.currency ?? payment.request_currency ?? "GHS")} ${Number(updatedPayment.amount ?? 0).toLocaleString()}. Your files and request updates are available in your portal.`,
			{
				requestId: String(payment.request_id),
				taskId: String(payment.request_task_id ?? ""),
				paymentId: String(updatedPayment.id),
				paymentType: String(updatedPayment.payment_type ?? ""),
				amount: Number(updatedPayment.amount ?? 0),
				currency: String(updatedPayment.currency ?? payment.request_currency ?? "GHS"),
				deadlineAt: payment.request_deadline_at ?? null,
				actionUrl: `/support/requests/${payment.request_id}`,
			},
		).catch((error) =>
			console.warn("[support:whatsapp] Paystack success WhatsApp failed", error),
		);
	}

	const cacheUserId = String(payment.request_user_key_id ?? payment.user_key_id ?? "");
	if (cacheUserId) {
		await invalidateSupportCache(cacheUserId);
	}
	await invalidateProviderSupportCache();

	return {
		data: toCamel(updatedPayment),
		request: toCamel(updated),
		paystack: verification,
		verified: true,
	};
}
