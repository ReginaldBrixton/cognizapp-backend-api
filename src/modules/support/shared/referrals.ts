/**
 * Referral reward accrual helper.
 */

import { cache } from "../../../lib/cache";
import { getDb } from "../../../lib/db";
import { toCamel } from "./clients";
import { roundMoney } from "./payments";

export async function accrueReferralReward(payment: Record<string, any>) {
	const paymentId = String(payment.id ?? "");
	const requestId = String(payment.request_id ?? "");
	const paymentAmount = roundMoney(Number(payment.amount ?? 0));
	if (!paymentId || !requestId || paymentAmount <= 0) {
		return null;
	}

	const db = getDb();
	const referredUserId = String(payment.user_key_id ?? "").trim();
	if (referredUserId) {
		const [relationship] = await db`
      SELECT rr.*
      FROM referral_relationships rr
      WHERE rr.referred_user_id = ${referredUserId}::uuid
        AND rr.status = 'active'
      LIMIT 1
    `.catch((error) => {
			console.warn("[support:referral] Failed to query referral relationship", {
				referredUserId,
				message: error instanceof Error ? error.message : String(error),
			});
			return [] as any[];
		});
		if (relationship?.id && String(relationship.referrer_user_id) !== referredUserId) {
			const amountPaidPesewas = Math.round(paymentAmount * 100);
			const rateBps = Number(relationship.commission_rate_bps ?? 1000);
			const commissionPesewas = Math.floor((amountPaidPesewas * rateBps) / 10000);
			const [commission] = await db`
        INSERT INTO referral_commissions (
          relationship_id, referrer_user_id, referred_user_id, support_payment_id, request_id,
          amount_paid_pesewas, commission_rate_bps, commission_amount_pesewas,
          currency, status, available_at, metadata
        )
        VALUES (
          ${relationship.id}, ${String(relationship.referrer_user_id)}::uuid, ${referredUserId}::uuid,
          ${paymentId}::uuid, ${requestId}::uuid, ${amountPaidPesewas}, ${rateBps}, ${commissionPesewas},
          ${String(payment.currency ?? "GHS")}, 'pending',
          COALESCE(${payment.verified_at ?? null}::timestamptz, NOW()) + INTERVAL '7 days',
          ${db.json({ paymentType: payment.payment_type ?? null, source: "support_payment_verified" })}
        )
        ON CONFLICT (support_payment_id) DO NOTHING
        RETURNING *
      `;
			if (commission) {
				const commissionAmount = roundMoney(commissionPesewas / 100);
				await db`
          INSERT INTO support_wallet_transactions (
            user_key_id, transaction_type, amount, currency, status, request_id,
            payment_id, description, metadata
          )
          VALUES (
            ${String(relationship.referrer_user_id)}, 'referral_commission', ${commissionAmount},
            ${String(payment.currency ?? "GHS")}, 'pending', ${requestId}::uuid,
            ${paymentId}::uuid, 'Referral commission from verified support payment',
            ${db.json({
							referralRelationshipId: String(relationship.id),
							referralCommissionId: String(commission.id),
							referredUserId,
							rateBps,
						})}
          )
        `;
				await db`
          UPDATE support_clients
          SET pending_wallet_balance = pending_wallet_balance + ${commissionAmount},
            updated_at = NOW()
          WHERE user_key_id = ${String(relationship.referrer_user_id)}
        `;
				await cache.deletePattern(`referrals:${String(relationship.referrer_user_id)}:*`);
				return { commission: toCamel(commission), relationship: toCamel(relationship) };
			}
			return null;
		}
	}

	const [referral] = await db`
    SELECT sr.*, sc.user_key_id AS referrer_user_key_id, sc.payout_preferences AS referrer_payout_preferences
    FROM support_referrals sr
    LEFT JOIN support_clients sc ON sc.referral_code = sr.referral_code
    WHERE sr.request_id = ${requestId}::uuid
      AND COALESCE(sr.reward_status, 'pending') != 'cancelled'
    LIMIT 1
  `;
	if (!referral?.referrer_user_key_id) {
		return null;
	}
	if (
		String(referral.referrer_user_key_id) ===
		String(referral.referred_user_key_id ?? payment.user_key_id ?? "")
	) {
		return null;
	}

	const rewardPercent = Number(referral.reward_percent ?? 10);
	const rewardAmount = roundMoney(paymentAmount * (rewardPercent / 100));
	const payoutPreferences =
		referral.payout_preferences && Object.keys(referral.payout_preferences).length
			? referral.payout_preferences
			: (referral.referrer_payout_preferences ?? {});

	const [event] = await db`
    INSERT INTO support_referral_reward_events (
      referral_id, request_id, payment_id, referrer_user_key_id, referred_user_key_id,
      payment_amount, reward_percent, reward_amount, currency, status, payout_preferences
    )
    VALUES (
      ${referral.id}, ${requestId}::uuid, ${paymentId}::uuid, ${String(referral.referrer_user_key_id)},
      ${String(referral.referred_user_key_id ?? payment.user_key_id ?? "")}, ${paymentAmount}, ${rewardPercent},
      ${rewardAmount}, ${String(payment.currency ?? referral.currency ?? "GHS")}, 'earned',
      ${db.json(payoutPreferences as any)}
    )
    ON CONFLICT (payment_id) DO NOTHING
    RETURNING *
  `;
	if (!event) {
		return null;
	}

	const [updatedReferral] = await db`
    UPDATE support_referrals
    SET source_user_key_id = COALESCE(source_user_key_id, ${String(referral.referrer_user_key_id)}),
      reward_amount = COALESCE(reward_amount, 0) + ${rewardAmount},
      currency = ${String(payment.currency ?? referral.currency ?? "GHS")},
      reward_status = 'earned',
      payout_preferences = CASE
        WHEN payout_preferences = '{}'::jsonb THEN ${db.json(payoutPreferences as any)}
        ELSE payout_preferences
      END,
      last_payment_id = ${paymentId}::uuid,
      last_rewarded_at = NOW(),
      updated_at = NOW()
    WHERE id = ${referral.id}
    RETURNING *
  `;
	return { event: toCamel(event), referral: toCamel(updatedReferral) };
}
