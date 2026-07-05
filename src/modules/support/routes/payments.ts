import { Elysia, t } from "elysia";

import { env } from "../../../config/env";
import { cache } from "../../../lib/cache";
import { getDb } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import {
	generateSupportAiResponse,
	getPublicSupportAiModelName,
	getSupportAiModel,
	hashSupportPrompt,
} from "../../../lib/gemini";
import { fail, ok } from "../../../lib/http";
import { paystackService } from "../../../lib/paystack";
import { normalizePublicCallbackUrl } from "../../../lib/site-url";
import {
	checkUploadThingHealth,
	uploadthingConfigured,
} from "../../../lib/uploadthing";
import { resolveAuth, type AuthContext } from "../../auth/middleware";
import { estimateSupportCost, estimateSupportCostLocal } from "../cost-estimation";
import {
	buildSupportPaymentPolicy,
	canAccessFullProtectedPreview,
	classifySupportRisk,
} from "../payment-policy";
import {
	assertPreviewAccess,
	redactImagePreviewPackage,
	redactPreviewAsset,
} from "../preview-service";
import {
	addSupportEvent,
	assertSupportWhatsAppNumber,
	assertClientRequestEditable,
	buildDraftPayload,
	buildPaymentSchedule,
	canSeeProvider,
	confirmSupportPaystackPayment,
	ensureClient,
	ensureRequestStorageReady,
	ensureSupportRequestWorkspace,
	ensureSupportMessageThread,
	ensureSupportWorkspaceLinks,
	generateTaskId,
	getMilestoneFiles,
	invalidateProviderSupportCache,
	invalidateSupportCache,
	paymentAmountForType,
	paymentStatusForSubmittedPayment,
	recordMilestoneFileEvent,
	refreshMilestoneCardMessages,
	refundEligibilityForRequest,
	requestBody,
	roundMoney,
	sendSupportEmail,
	sendSupportWhatsApp,
	storeSupportFileOnUploadThing,
	toCamel,
	verifySupportWorkspaceAccess,
} from "../shared";
import { traceRoute } from "../route-trace";
import { createSupportLogger } from "../logger";
import {
	MAX_SUPPORT_UPLOAD_FILES,
	MAX_SUPPORT_UPLOAD_FILE_BYTES,
	DEFAULT_SUPPORT_TIMEZONE,
	MOBILE_MONEY_ATTEMPT_TTL_SECONDS,
	DELIVERY_PAYMENT_REQUIRED_MESSAGE,
} from "../constants";
import {
	isPreviewSupportDelivery,
	isSupersededSupportDelivery,
	canDownloadSupportDelivery,
	assertSupportDeliveryDownloadAllowed,
	redactClientDelivery,
	decodePreviewImageContent,
} from "../delivery-policy";
import { validateSupportUploads, extensionFor } from "../upload-validation";
import { retryablePaymentStatusAfterCancel } from "../payment-helpers";
import {
	assertProviderCanMutateSupportFile,
	updateSupportMessageFileAttachments,
	createSupportFileActivityMessage,
} from "../file-helpers";
import {
	requestEstimateInput,
	requestEstimateInputFromBody,
	assertAssignmentRequestBody,
	bodyWithAuthoritativeEstimate,
	formatRequestDeadline,
} from "../request-helpers";
import { createRequestAiAcknowledgement } from "../ai-acknowledgement";
import { isRequestBodyParseError } from "../utils";

export const paymentRoutes = new Elysia()
  .post(
    "/client/requests/:id/payment-proof",
    async ({ headers, set }) => {
      await resolveAuth(headers);
      set.status = 410;
      return fail(
        "Manual payment proof is no longer accepted. Use verified Paystack checkout.",
        "paystack_checkout_required",
      );
    },
  )
  .post(
    "/client/requests/:id/payments",
    async ({ headers, set }) => {
      await resolveAuth(headers);
      set.status = 410;
      return fail(
        "Manual payment submission is no longer accepted. Use verified Paystack checkout.",
        "paystack_checkout_required",
      );
    },
  )
  .post(
    "/client/requests/:id/paystack/mobile-money",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const paymentType = body.paymentType ?? "full_payment";
      if (!["deposit", "final_balance", "full_payment"].includes(paymentType)) {
        throw new HttpError(
          400,
          "invalid_payment_type",
          "Payment type must be deposit, final_balance, or full_payment",
        );
      }

      const phone = paystackService.normalizeMobileMoneyPhone(String(body.phone ?? ""));
      if (!phone || phone.length < 9) {
        throw new HttpError(
          400,
          "invalid_mobile_money_phone",
          "Enter a valid mobile money phone number",
        );
      }
      const provider = paystackService.normalizeProvider(body.provider);
      const phoneHash = paystackService.hashMobileMoneyPhone(phone);
      const allowBeforePreviewPayment = body.allowBeforePreviewPayment === true;

      const [supportRequest] = await db`
        SELECT r.*, c.email
        FROM support_requests r
        LEFT JOIN support_clients c ON c.id = r.client_id
        WHERE r.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!supportRequest) {
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      }

      const policy = (supportRequest.payment_policy ?? {}) as Record<string, any>;
      const paymentStatus = String(supportRequest.payment_status ?? "unpaid");
      if (paymentStatus === "paid") {
        throw new HttpError(409, "payment_already_complete", "This request is already fully paid");
      }
      if (paymentType === "deposit" && policy.previewUnlock === "full_payment") {
        throw new HttpError(
          409,
          "full_payment_required",
          "This request requires full payment to unlock the protected preview",
        );
      }
      if (paymentType === "deposit" && paymentStatus === "deposit_paid") {
        throw new HttpError(409, "deposit_already_paid", "The deposit has already been verified");
      }
      if (
        String(supportRequest.preview_status ?? "not_started") !== "ready" &&
        String(policy.workStartRequirement ?? "none") === "none" &&
        !allowBeforePreviewPayment
      ) {
        throw new HttpError(
          409,
          "PREVIEW_NOT_READY",
          "The free protected preview must be ready before payment begins",
        );
      }

      const amount = paymentAmountForType(supportRequest, paymentType);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(
          400,
          "invalid_payment_amount",
          "Payment amount must be greater than zero",
        );
      }
      if (body.amount !== undefined && Math.abs(body.amount - amount) > 0.01) {
        throw new HttpError(
          400,
          "payment_amount_mismatch",
          "The payment amount must match the amount currently due",
        );
      }

      const pendingPayments = await db`
        SELECT p.*, r.payment_status AS request_payment_status, r.deposit_amount, r.final_amount,
          r.payment_amount, r.quoted_amount,
          t.metadata AS transaction_metadata,
          t.metadata->>'mobileMoneyProvider' AS pending_provider,
          t.metadata->>'phoneHash' AS pending_phone_hash,
          t.metadata->>'pendingStep' AS pending_step,
          GREATEST(
            0,
            ${MOBILE_MONEY_ATTEMPT_TTL_SECONDS} - FLOOR(EXTRACT(EPOCH FROM (NOW() - p.created_at)))
          )::int AS expires_in_seconds
        FROM support_payments p
        INNER JOIN support_requests r ON r.id = p.request_id
        LEFT JOIN paystack_transactions t
          ON t.support_payment_id = p.id
          OR (
            t.support_request_id = p.request_id
            AND t.provider_reference = COALESCE(p.provider_reference, p.transaction_id)
          )
        WHERE p.request_id = ${supportRequest.id}
          AND p.user_key_id = ${auth.userId}
          AND p.payment_type = ${paymentType}
          AND p.provider = 'paystack'
          AND p.status = 'paystack_pending'
          AND p.verified_at IS NULL
          AND p.created_at > NOW() - (${MOBILE_MONEY_ATTEMPT_TTL_SECONDS} || ' seconds')::interval
        ORDER BY p.created_at DESC
      `;
      const [pendingPayment] = pendingPayments.filter((payment) => {
        const pendingProvider = String(payment.pending_provider ?? "");
        const pendingPhoneHash = String(payment.pending_phone_hash ?? "");
        return pendingProvider === provider && pendingPhoneHash === phoneHash;
      });
      if (pendingPayment) {
        const reference = String(pendingPayment.provider_reference ?? pendingPayment.transaction_id);
        const rawPendingStep = String(pendingPayment.pending_step ?? "");
        const pendingStep =
          rawPendingStep === "otp"
            ? "otp"
            : rawPendingStep === "hosted_checkout"
              ? "hosted_checkout"
              : "phone_authorization";
        const expiresInSeconds = Math.max(
          1,
          Number(pendingPayment.expires_in_seconds ?? MOBILE_MONEY_ATTEMPT_TTL_SECONDS),
        );
        const isHosted = pendingStep === "hosted_checkout";
        return ok({
          data: toCamel(pendingPayment),
          request: toCamel(supportRequest),
          reference,
          reused: true,
          expiresInSeconds,
          pendingStep,
          phoneLast4: phone.slice(-4),
          provider,
          chargeStatus: isHosted
            ? "open_checkout"
            : pendingStep === "otp"
              ? "send_otp"
              : "pay_offline",
          checkoutMode: isHosted ? "hosted" : "charge",
          paystack: {
            status: true,
            message: "Mobile money authorization is already pending",
            data: {
              reference,
              status: isHosted
                ? "open_checkout"
                : pendingStep === "otp"
                  ? "send_otp"
                  : "pay_offline",
              display_text: isHosted
                ? "Redirecting to Paystack for secure mobile money payment..."
                : pendingStep === "otp"
                  ? "Enter the OTP sent to your phone."
                  : "Approve the payment prompt on your phone.",
            },
          },
          message: "Mobile money authorization is already pending",
        });
      }

      const stalePendingPayments = pendingPayments.filter((payment) => {
        const pendingProvider = String(payment.pending_provider ?? "");
        const pendingPhoneHash = String(payment.pending_phone_hash ?? "");
        return pendingProvider !== provider || pendingPhoneHash !== phoneHash;
      });
      if (stalePendingPayments.length > 0) {
        await db.begin(async (tx) => {
          for (const stalePayment of stalePendingPayments) {
            const staleReference = String(
              stalePayment.provider_reference ?? stalePayment.transaction_id,
            );
            await tx`
              UPDATE support_payments
              SET status = 'cancelled',
                updated_at = NOW()
              WHERE id = ${stalePayment.id}
                AND status = 'paystack_pending'
                AND verified_at IS NULL
            `;
            await tx`
              UPDATE paystack_transactions
              SET status = 'cancelled',
                metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({
              cancelledAt: new Date().toISOString(),
              cancelledBy: auth.userId,
              cancelReason: "mobile_money_attempt_replaced",
              replacedByProvider: provider,
              replacedByPhoneLast4: phone.slice(-4),
            })}::jsonb,
                updated_at = NOW()
              WHERE provider_reference = ${staleReference}
                AND support_request_id = ${supportRequest.id}
                AND status <> 'success'
            `;
          }
          await tx`
            UPDATE support_requests
            SET payment_status = ${retryablePaymentStatusAfterCancel(paymentType, supportRequest)},
              payment_notes = 'Previous mobile money authorization cancelled before starting a new one.',
              payment_transaction_id = NULL,
              updated_at = NOW()
            WHERE id = ${supportRequest.id}
              AND user_key_id = ${auth.userId}
              AND payment_status IN ('pending', 'paystack_pending', 'deposit_pending_verification', 'final_payment_pending_verification')
          `;
        });
      }

      const reference = paystackService.createReference(
        String(supportRequest.task_id ?? supportRequest.id),
      );
      console.info("[support:paystack.mobile_money] initializing", {
        requestId: String(supportRequest.id),
        taskId: String(supportRequest.task_id ?? ""),
        userId: auth.userId,
        paymentType,
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        provider,
      });

      const metadata = {
        requestId: String(supportRequest.id),
        taskId: String(supportRequest.task_id ?? ""),
        userId: auth.userId,
        paymentType,
        method: "mobile_money",
        mobileMoneyProvider: provider,
      };

      // MTN/AirtelTigo: Use Paystack hosted checkout for the full OTP → PIN flow.
      // The Charge API returns "pay_offline" for MTN/ATL (phone-only auth, no OTP).
      // Hosted checkout supports the OTP code → PIN authorization flow the user expects.
      // Telecel (vod) keeps the Charge API for its voucher code system.
      const useHostedCheckout = provider === "mtn" || provider === "atl";
      const callbackUrl = normalizePublicCallbackUrl(
        body.callbackUrl ?? "",
      );
      let paystack: Awaited<ReturnType<typeof paystackService.initializeCheckout>>;
      let chargeStatus: string;
      let displayText: string;
      let pendingStep: string;
      let authorizationUrl: string | null = null;
      let accessCode: string | null = null;

      if (useHostedCheckout) {
        paystack = await paystackService.initializeCheckout({
          email: String(supportRequest.email ?? auth.email),
          amount,
          currency: String(supportRequest.currency ?? "GHS"),
          reference,
          channels: ["mobile_money"],
          callbackUrl,
          metadata,
        });
        const checkoutData = (paystack.data as Record<string, unknown>) ?? {};
        authorizationUrl =
          (checkoutData.authorization_url as string) ?? null;
        accessCode = (checkoutData.access_code as string) ?? null;
        chargeStatus = "open_checkout";
        displayText = "Redirecting to Paystack for secure mobile money payment...";
        pendingStep = "hosted_checkout";
      } else {
        paystack = await paystackService.chargeMobileMoney({
          email: String(supportRequest.email ?? auth.email),
          amount,
          currency: String(supportRequest.currency ?? "GHS"),
          phone,
          provider,
          reference,
          metadata,
        });
        const chargeData = (paystack.data as Record<string, unknown>) ?? {};
        chargeStatus = String(chargeData.status ?? "");
        displayText = String((chargeData as any).display_text ?? paystack.message ?? "");
        pendingStep = chargeStatus === "send_otp" ? "otp" : "phone_authorization";
      }

      const [payment] = await db`
        INSERT INTO support_payments (
          request_id, user_key_id, payment_type, amount, currency, transaction_id,
          provider, provider_reference, status
        )
        VALUES (
          ${supportRequest.id}, ${auth.userId}, ${paymentType}, ${amount},
          ${String(supportRequest.currency ?? "GHS")}, ${reference},
          'paystack', ${reference}, 'paystack_pending'
        )
        RETURNING *
      `;
      await db`
        INSERT INTO paystack_transactions (
          workspace_id, support_request_id, support_payment_id, user_key_id, purpose,
          amount, currency, provider_reference, status, metadata
        )
        VALUES (
          ${supportRequest.workspace_id ?? null}, ${supportRequest.id}, ${payment.id}, ${auth.userId},
          'support_payment', ${amount}, ${String(supportRequest.currency ?? "GHS")},
          ${reference}, 'pending', ${db.json({
        ...metadata,
        phoneLast4: phone.slice(-4),
        phoneHash,
        pendingStep,
      })}
        )
        ON CONFLICT (provider, provider_reference) DO NOTHING
      `;
      const [updated] = await db`
        UPDATE support_requests
        SET payment_transaction_id = ${reference},
          payment_status = ${paymentType === "final_balance" ? "final_payment_pending_verification" : "pending"},
          payment_notes = 'Mobile money authorization sent',
          updated_at = NOW()
        WHERE id = ${supportRequest.id}
        RETURNING *
      `;

      await addSupportEvent(
        updated.id,
        auth,
        "payment.paystack_mobile_money_initialized",
        "Mobile money authorization sent",
        {
          paymentId: payment.id,
          paymentType,
          reference,
          amount,
          provider,
        },
      );
      await invalidateSupportCache(auth.userId);

      console.info("[support:paystack.mobile_money] Charge response", {
        requestId: String(supportRequest.id),
        reference,
        status: chargeStatus,
        displayText,
        provider,
      });

      return ok({
        data: toCamel(payment),
        request: toCamel(updated),
        reference,
        reused: false,
        expiresInSeconds: MOBILE_MONEY_ATTEMPT_TTL_SECONDS,
        pendingStep,
        phoneLast4: phone.slice(-4),
        provider,
        paystack,
        chargeStatus,
        authorizationUrl,
        accessCode,
        checkoutMode: useHostedCheckout ? "hosted" : "charge",
        message: displayText || "Approve the payment prompt on your phone.",
      });
    },
    {
      body: t.Object({
        paymentType: t.Optional(t.String()),
        amount: t.Optional(t.Number()),
        phone: t.String(),
        provider: t.String(),
        idempotencyKey: t.Optional(t.String()),
        allowBeforePreviewPayment: t.Optional(t.Boolean()),
        callbackUrl: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/checkout",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const paymentType = body.paymentType ?? "full_payment";
      const allowBeforePreviewPayment = body.allowBeforePreviewPayment === true;
      if (!["deposit", "final_balance", "full_payment"].includes(paymentType)) {
        throw new HttpError(
          400,
          "invalid_payment_type",
          "Payment type must be deposit, final_balance, or full_payment",
        );
      }
      const [supportRequest] = await db`
      SELECT r.*, c.email
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      WHERE r.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
      if (!supportRequest)
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      const policy = (supportRequest.payment_policy ?? {}) as Record<string, any>;
      const paymentStatus = String(supportRequest.payment_status ?? "unpaid");
      if (paymentStatus === "paid") {
        throw new HttpError(409, "payment_already_complete", "This request is already fully paid");
      }
      if (paymentType === "deposit" && policy.previewUnlock === "full_payment") {
        throw new HttpError(
          409,
          "full_payment_required",
          "This request requires full payment to unlock the protected preview",
        );
      }
      if (paymentType === "deposit" && paymentStatus === "deposit_paid") {
        throw new HttpError(409, "deposit_already_paid", "The deposit has already been verified");
      }
      if (
        String(supportRequest.preview_status ?? "not_started") !== "ready" &&
        String(policy.workStartRequirement ?? "none") === "none" &&
        !allowBeforePreviewPayment
      ) {
        throw new HttpError(
          409,
          "PREVIEW_NOT_READY",
          "The free protected preview must be ready before payment begins",
        );
      }

      const amount = paymentAmountForType(supportRequest, paymentType);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(
          400,
          "invalid_payment_amount",
          "Payment amount must be greater than zero",
        );
      }
      if (body.amount !== undefined && Math.abs(body.amount - amount) > 0.01) {
        throw new HttpError(
          400,
          "payment_amount_mismatch",
          "The payment amount must match the amount currently due",
        );
      }

      const reference = paystackService.createReference(
        String(supportRequest.task_id ?? supportRequest.id),
      );
      const callbackUrl = normalizePublicCallbackUrl(body.callbackUrl);
      console.info("[support:paystack.checkout] initializing", {
        requestId: String(supportRequest.id),
        taskId: String(supportRequest.task_id ?? ""),
        userId: auth.userId,
        paymentType,
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        currentStatus: String(supportRequest.status ?? ""),
        currentPaymentStatus: String(supportRequest.payment_status ?? ""),
        callbackOrigin: (() => {
          try {
            return new URL(callbackUrl).origin;
          } catch {
            return "";
          }
        })(),
      });
      const paystack = await paystackService.initializeCheckout({
        email: String(supportRequest.email ?? auth.email),
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        reference,
        channels: body.channels,
        callbackUrl,
        metadata: {
          requestId: String(supportRequest.id),
          taskId: String(supportRequest.task_id ?? ""),
          userId: auth.userId,
          paymentType,
          callbackUrl,
        },
      });

      const [payment] = await db`
      INSERT INTO support_payments (
        request_id, user_key_id, payment_type, amount, currency, transaction_id,
        provider, provider_reference, status
      )
      VALUES (
        ${supportRequest.id}, ${auth.userId}, ${paymentType}, ${amount},
        ${String(supportRequest.currency ?? "GHS")}, ${reference},
        'paystack', ${reference}, 'paystack_pending'
      )
      RETURNING *
    `;
      await db`
      INSERT INTO paystack_transactions (
        workspace_id, support_request_id, support_payment_id, user_key_id, purpose,
        amount, currency, provider_reference, status, metadata
      )
      VALUES (
        ${supportRequest.workspace_id ?? null}, ${supportRequest.id}, ${payment.id}, ${auth.userId},
        'support_payment', ${amount}, ${String(supportRequest.currency ?? "GHS")},
        ${reference}, 'pending', ${db.json({ paymentType, requestId: String(supportRequest.id) })}
      )
      ON CONFLICT (provider, provider_reference) DO NOTHING
    `;
      const [updated] = await db`
      UPDATE support_requests
      SET payment_transaction_id = ${reference},
        payment_status = ${paymentType === "final_balance" ? "final_payment_pending_verification" : "pending"},
        payment_notes = 'Paystack checkout initialized',
        updated_at = NOW()
      WHERE id = ${supportRequest.id}
      RETURNING *
    `;
      console.info("[support:paystack.checkout] initialized", {
        requestId: String(updated.id),
        paymentId: String(payment.id),
        userId: auth.userId,
        paymentType,
        amount,
        paymentStatus: String(updated.payment_status ?? ""),
        requestStatus: String(updated.status ?? ""),
        providerReference: reference,
        hasAuthorizationUrl: Boolean(
          (paystack.data as Record<string, unknown> | undefined)?.authorization_url,
        ),
      });

      await addSupportEvent(
        updated.id,
        auth,
        "payment.paystack_checkout_initialized",
        "Paystack checkout initialized",
        {
          paymentId: payment.id,
          paymentType,
          reference,
          amount,
        },
      );
      await invalidateSupportCache(auth.userId);
      return ok({
        data: toCamel(payment),
        request: toCamel(updated),
        paystack,
        accessCode:
          (paystack.data as Record<string, unknown> | undefined)?.access_code ??
          null,
        authorizationUrl:
          (paystack.data as Record<string, unknown> | undefined)
            ?.authorization_url ?? null,
        message: paystack.message || "Paystack checkout initialized",
      });
    },
    {
      body: t.Object({
        paymentType: t.Optional(t.String()),
        amount: t.Optional(t.Number()),
        callbackUrl: t.Optional(t.String()),
        allowBeforePreviewPayment: t.Optional(t.Boolean()),
        channels: t.Optional(
          t.Array(
            t.Union([
              t.Literal("card"),
              t.Literal("bank"),
              t.Literal("ussd"),
              t.Literal("qr"),
              t.Literal("mobile_money"),
              t.Literal("bank_transfer"),
              t.Literal("eft"),
            ]),
          ),
        ),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/submit-otp",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const reference = String(body.reference ?? "").trim();
      const otp = String(body.otp ?? "").trim();

      if (!reference) {
        throw new HttpError(400, "reference_required", "Payment reference is required");
      }
      if (!otp || otp.length < 4) {
        throw new HttpError(400, "invalid_otp", "Enter the OTP sent to your phone");
      }

      const [payment] = await db`
        SELECT p.*, r.currency, r.payment_status
        FROM support_payments p
        INNER JOIN support_requests r ON r.id = p.request_id
        WHERE p.request_id = ${params.id}::uuid
          AND r.user_key_id = ${auth.userId}
          AND COALESCE(p.provider_reference, p.transaction_id) = ${reference}
        ORDER BY p.created_at DESC
        LIMIT 1
      `;

      if (!payment) {
        throw new HttpError(404, "payment_not_found", "Payment not found");
      }

      console.info("[support:paystack.submit_otp] Submitting OTP", {
        requestId: params.id,
        reference,
        userId: auth.userId,
      });

      try {
        const result = await paystackService.submitOtp({
          reference,
          otp,
        });

        const chargeData = (result.data as Record<string, unknown>) ?? {};
        const chargeStatus = String(chargeData.status ?? "");
        const displayText = String((chargeData as any).display_text ?? "");

        console.info("[support:paystack.submit_otp] Response", {
          requestId: params.id,
          reference,
          status: chargeStatus,
          displayText,
          message: result.message,
        });

        // After OTP submission, Paystack automatically sends PIN prompt to customer's phone
        // The status will be "pending" or "pay_offline" while waiting for PIN entry on phone
        if (chargeStatus === "pending" || chargeStatus === "pay_offline" || chargeStatus === "send_pin") {
          return ok({
            data: toCamel(payment),
            paystack: result,
            status: "awaiting_pin_on_phone",
            message: displayText || "OTP accepted. Complete the PIN authorization on your phone.",
          });
        }

        // Check if payment completed successfully
        if (chargeStatus === "success") {
          const confirmResult = await confirmSupportPaystackPayment({
            reference,
            auth,
            requestId: params.id,
          });
          await invalidateSupportCache(auth.userId);
          return ok({
            data: toCamel(payment),
            paystack: result,
            verified: confirmResult.verified,
            message: "Payment successful",
          });
        }

        // Failed or unknown status
        return ok({
          data: toCamel(payment),
          paystack: result,
          status: chargeStatus,
          message: result.message || displayText || "Processing payment. Check your phone.",
        });
      } catch (error) {
        console.error("[support:paystack.submit_otp] Error", {
          requestId: params.id,
          reference,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    {
      body: t.Object({
        reference: t.String(),
        otp: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/verify",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reference = body.reference.trim();
      const result = await confirmSupportPaystackPayment({
        reference,
        auth,
        requestId: params.id,
      });
      await invalidateSupportCache(auth.userId);
      return ok({
        ...result,
        message: result.verified
          ? "Paystack payment verified"
          : "Payment is not successful yet",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/cancel",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const reference = String(body.reference ?? "").trim();
      if (!reference) {
        throw new HttpError(400, "payment_reference_required", "Payment reference is required");
      }

      const [payment] = await db`
        SELECT p.*, r.payment_status AS request_payment_status, r.deposit_amount, r.final_amount,
          r.payment_amount, r.quoted_amount
        FROM support_payments p
        INNER JOIN support_requests r ON r.id = p.request_id
        WHERE p.request_id = ${params.id}::uuid
          AND r.user_key_id = ${auth.userId}
          AND COALESCE(p.provider_reference, p.transaction_id) = ${reference}
        ORDER BY p.created_at DESC
        LIMIT 1
      `;
      if (!payment) {
        throw new HttpError(404, "payment_not_found", "Payment checkout was not found");
      }
      if (String(payment.status ?? "") === "verified" || payment.verified_at) {
        throw new HttpError(409, "payment_already_verified", "This payment has already been verified");
      }

      const resetStatus = retryablePaymentStatusAfterCancel(String(payment.payment_type ?? ""), payment);
      const [updatedPayment, updatedRequest] = await db.begin(async (tx) => {
        const [nextPayment] = await tx`
          UPDATE support_payments
          SET status = 'cancelled',
            updated_at = NOW()
          WHERE id = ${payment.id}
            AND status NOT IN ('verified', 'refunded', 'refund_pending')
          RETURNING *
        `;
        const [nextRequest] = await tx`
          UPDATE support_requests
          SET payment_status = ${resetStatus},
            payment_notes = 'Payment checkout cancelled. User can retry.',
            payment_transaction_id = NULL,
            updated_at = NOW()
          WHERE id = ${params.id}::uuid
            AND user_key_id = ${auth.userId}
            AND payment_status IN ('pending', 'paystack_pending', 'deposit_pending_verification', 'final_payment_pending_verification', 'deposit_paid')
          RETURNING *
        `;
        await tx`
          UPDATE paystack_transactions
          SET status = 'cancelled',
            metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({ cancelledAt: new Date().toISOString(), cancelledBy: auth.userId })}::jsonb,
            updated_at = NOW()
          WHERE provider_reference = ${reference}
            AND support_request_id = ${params.id}::uuid
            AND status <> 'success'
        `;
        return [nextPayment, nextRequest];
      });

      await addSupportEvent(
        params.id,
        auth,
        "payment.paystack_checkout_cancelled",
        "Paystack checkout cancelled",
        {
          paymentId: payment.id,
          paymentType: payment.payment_type,
          reference,
          resetStatus,
        },
      );
      await invalidateSupportCache(auth.userId);
      await invalidateProviderSupportCache();
      return ok({
        data: toCamel(updatedPayment ?? payment),
        request: updatedRequest ? toCamel(updatedRequest) : null,
        message: "Payment checkout cancelled. You can try again.",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/refund-requests",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const [payment] = await db`
      SELECT p.*, r.status AS request_status, r.delivery_status, r.payment_status,
        r.user_key_id AS request_user_key_id, r.title AS request_title
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      WHERE p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
        AND p.status = 'verified'
      ORDER BY p.verified_at DESC NULLS LAST, p.created_at DESC
      LIMIT 1
    `;
      if (!payment) {
        throw new HttpError(
          404,
          "payment_not_found",
          "No verified payment was found for this request",
        );
      }

      const enrichedRequest = {
        status: payment.request_status,
        delivery_status: payment.delivery_status,
        refund_reason_category: body.reasonCategory,
      };
      const eligibility = refundEligibilityForRequest(enrichedRequest, payment);
      if (!eligibility.eligible) {
        throw new HttpError(409, "refund_not_eligible", eligibility.reason);
      }

      const paidAmount = Number(payment.amount ?? 0);
      const requestedAmount =
        body.refundType === "partial"
          ? roundMoney(
            Math.min(Number(body.requestedAmount ?? paidAmount), paidAmount),
          )
          : paidAmount;
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        throw new HttpError(
          400,
          "invalid_refund_amount",
          "Refund amount must be greater than zero",
        );
      }

      const [refund] = await db`
      INSERT INTO support_refund_requests (
        request_id, payment_id, user_key_id, refund_type, requested_amount,
        reason, reason_category, user_evidence
      )
      VALUES (
        ${params.id}::uuid, ${payment.id}, ${auth.userId}, ${body.refundType ?? "full"},
        ${requestedAmount}, ${body.reason.trim()}, ${body.reasonCategory ?? "other"},
        ${db.json(body.userEvidence ?? [])}
      )
      RETURNING *
    `;
      await db`
      UPDATE support_payments
      SET refund_status = 'requested',
        refund_amount = ${requestedAmount},
        updated_at = NOW()
      WHERE id = ${payment.id}
    `;
      await addSupportEvent(
        params.id,
        auth,
        "payment.refund_requested",
        "Refund review requested",
        {
          refundId: refund.id,
          paymentId: payment.id,
          refundType: refund.refund_type,
          requestedAmount,
          reasonCategory: refund.reason_category,
        },
      );
      await invalidateSupportCache(auth.userId);
      return ok({ data: toCamel(refund), message: "Refund review requested" });
    },
    {
      body: t.Object({
        refundType: t.Optional(
          t.Union([t.Literal("full"), t.Literal("partial")]),
        ),
        requestedAmount: t.Optional(t.Number()),
        reason: t.String({ minLength: 12 }),
        reasonCategory: t.Optional(
          t.Union([
            t.Literal("quality_issue"),
            t.Literal("scope_mismatch"),
            t.Literal("non_delivery"),
            t.Literal("cancellation"),
            t.Literal("other"),
          ]),
        ),
        userEvidence: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/check",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reference = body.reference.trim();
      const [payment] = await getDb()`
      SELECT p.*
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      WHERE p.transaction_id = ${reference}
        AND p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
      if (!payment)
        throw new HttpError(
          404,
          "payment_not_found",
          "Paystack payment was not found",
        );
      const paystack = await paystackService.checkCharge(reference);
      const chargeData = (paystack.data ?? {}) as Record<string, any>;
      const chargeStatus = String(chargeData.status ?? "").toLowerCase();
      if (chargeStatus === "success") {
        const result = await confirmSupportPaystackPayment({
          reference,
          auth,
          requestId: params.id,
        });
        await invalidateSupportCache(auth.userId);
        return ok({
          ...result,
          chargeStatus,
          message: "Payment successful",
        });
      }
      return ok({
        data: toCamel(payment),
        paystack,
        verified: false,
        chargeStatus,
        message: paystack.message || "Charge status checked",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/submit-pin",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reference = body.reference.trim();
      const [payment] = await getDb()`
      SELECT p.*
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      WHERE p.transaction_id = ${reference}
        AND p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
      if (!payment)
        throw new HttpError(
          404,
          "payment_not_found",
          "Paystack payment was not found",
        );
      const paystack = await paystackService.submitPin({
        reference,
        pin: body.pin.trim(),
      });
      return ok({
        data: toCamel(payment),
        paystack,
        message: paystack.message || "PIN submitted",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
        pin: t.String(),
      }),
    },
  )

;
