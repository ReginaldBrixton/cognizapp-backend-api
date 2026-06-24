import { randomInt } from "node:crypto";
import { Elysia, t } from "elysia";

import { env } from "../../config/env";
import { cache } from "../../lib/cache";
import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { paystackService } from "../../lib/paystack";
import { resolveAuth } from "../auth/middleware";
import { roundMoney, toCamel } from "../support/shared";

const HOLDING_PERIOD_DAYS = 7;
const MIN_WITHDRAWAL_PESEWAS = 5000;
const COMMISSION_MODEL = "lifetime";

function normalizeReferralCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function generateReferralCode(userId: string) {
  const shortKey = userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase();
  return `COGNI-${shortKey || randomInt(100000, 999999)}`;
}

function pickReferralRateBps() {
  const value = randomInt(1, 101);
  if (value <= 70) return 1000;
  if (value <= 90) return 1500;
  return 2000;
}

function maskEmail(value: string) {
  const [name = "", domain = ""] = value.split("@");
  if (!domain) return value ? `${value.slice(0, 2)}***` : "Referral user";
  return `${name.slice(0, 2)}***@${domain}`;
}

function last4(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.slice(-4) || null;
}

function moneyFromPesewas(value: unknown) {
  return roundMoney(Number(value ?? 0) / 100);
}

async function ensureUserReferralCode(userId: string) {
  const db = getDb();
  const [user] = await db`
    UPDATE auth.users
    SET referral_code = COALESCE(referral_code, ${generateReferralCode(userId)}),
      updated_at = NOW()
    WHERE id = ${userId}::uuid
    RETURNING id, email, referral_code
  `;
  if (!user) throw new HttpError(404, "user_not_found", "User account was not found");
  return user;
}

async function invalidateReferralCache(userId: string) {
  await cache.deletePattern(`referrals:${userId}:*`);
}

async function loadReferralSummary(userId: string) {
  const db = getDb();
  const user = await ensureUserReferralCode(userId);
  const dashboard = await cache.rememberJson(`referrals:${userId}:summary`, 20, async () => {
    const [stats] = await db`
      SELECT
        COUNT(DISTINCT rr.referred_user_id)::int AS total_referrals,
        COALESCE(SUM(CASE
          WHEN rc.status = 'pending' AND rc.available_at > NOW() THEN rc.commission_amount_pesewas
          ELSE 0
        END), 0)::bigint AS pending_pesewas,
        COALESCE(SUM(CASE
          WHEN rc.status = 'available' OR (rc.status = 'pending' AND rc.available_at <= NOW()) THEN rc.commission_amount_pesewas
          ELSE 0
        END), 0)::bigint AS available_pesewas,
        COALESCE(SUM(CASE WHEN rc.status = 'paid' THEN rc.commission_amount_pesewas ELSE 0 END), 0)::bigint AS paid_pesewas,
        COALESCE(SUM(CASE WHEN rc.status NOT IN ('reversed', 'cancelled') THEN rc.amount_paid_pesewas ELSE 0 END), 0)::bigint AS referred_payments_pesewas,
        COALESCE(SUM(CASE WHEN rc.status NOT IN ('reversed', 'cancelled') THEN rc.commission_amount_pesewas ELSE 0 END), 0)::bigint AS lifetime_earned_pesewas
      FROM referral_relationships rr
      LEFT JOIN referral_commissions rc ON rc.relationship_id = rr.id
      WHERE rr.referrer_user_id = ${userId}::uuid
    `;

    const historyRows = await db`
      SELECT
        rr.id,
        rr.referred_user_id,
        rr.commission_rate_bps,
        rr.status,
        rr.created_at,
        u.email,
        COALESCE(SUM(rc.amount_paid_pesewas), 0)::bigint AS total_paid_pesewas,
        COALESCE(SUM(CASE WHEN rc.status NOT IN ('reversed', 'cancelled') THEN rc.commission_amount_pesewas ELSE 0 END), 0)::bigint AS total_earned_pesewas,
        COUNT(rc.id)::int AS commission_count
      FROM referral_relationships rr
      INNER JOIN auth.users u ON u.id = rr.referred_user_id
      LEFT JOIN referral_commissions rc ON rc.relationship_id = rr.id
      WHERE rr.referrer_user_id = ${userId}::uuid
      GROUP BY rr.id, u.email
      ORDER BY rr.created_at DESC
      LIMIT 50
    `;

    const [profile] = await db`
      SELECT id, payout_type, account_name, account_number_last4, bank_code, bank_name,
        currency, paystack_recipient_code, status, created_at, updated_at
      FROM referral_payout_profiles
      WHERE user_id = ${userId}::uuid AND is_default = TRUE AND status = 'active'
      LIMIT 1
    `;

    return {
      totals: {
        referrals: Number(stats?.total_referrals ?? 0),
        pendingPesewas: Number(stats?.pending_pesewas ?? 0),
        availablePesewas: Number(stats?.available_pesewas ?? 0),
        paidPesewas: Number(stats?.paid_pesewas ?? 0),
        referredPaymentsPesewas: Number(stats?.referred_payments_pesewas ?? 0),
        lifetimeEarnedPesewas: Number(stats?.lifetime_earned_pesewas ?? 0),
      },
      history: historyRows.map((row) => ({
        id: String(row.id),
        referredUserId: String(row.referred_user_id),
        referredUser: maskEmail(String(row.email ?? "")),
        rateBps: Number(row.commission_rate_bps ?? 0),
        rateLabel: `${roundMoney(Number(row.commission_rate_bps ?? 0) / 100)}%`,
        status: String(row.status ?? "active"),
        totalPaidPesewas: Number(row.total_paid_pesewas ?? 0),
        totalEarnedPesewas: Number(row.total_earned_pesewas ?? 0),
        commissionCount: Number(row.commission_count ?? 0),
        createdAt: row.created_at,
      })),
      payoutProfile: profile ? toCamel(profile) : null,
    };
  });

  const totals = dashboard.totals;
  return {
    referralCode: user.referral_code,
    referralLinkPath: `/signup?ref=${encodeURIComponent(String(user.referral_code))}`,
    commissionModel: COMMISSION_MODEL,
    holdingPeriodDays: HOLDING_PERIOD_DAYS,
    minimumWithdrawalPesewas: MIN_WITHDRAWAL_PESEWAS,
    totals: {
      ...totals,
      pending: moneyFromPesewas(totals.pendingPesewas),
      available: moneyFromPesewas(totals.availablePesewas),
      paid: moneyFromPesewas(totals.paidPesewas),
      lifetimeEarned: moneyFromPesewas(totals.lifetimeEarnedPesewas),
      referredPayments: moneyFromPesewas(totals.referredPaymentsPesewas),
    },
    history: dashboard.history,
    payoutProfile: dashboard.payoutProfile,
  };
}

export const referralRoutes = new Elysia({ prefix: "/api/referrals", tags: ["referrals"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid referral request body", "invalid_request");
    }
    console.error("[referrals] unhandled route error", {
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: env.isDevelopment && error instanceof Error ? error.stack : undefined,
    });
    set.status = 500;
    return fail("Internal server error", "internal_error");
  })
  .get("/me", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    return ok({ data: await loadReferralSummary(auth.userId) });
  })
  .get("/earnings", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    const data = await loadReferralSummary(auth.userId);
    return ok({ data: data.totals });
  })
  .get("/banks", async ({ headers, query }) => {
    await resolveAuth(headers);
    const currency = String(query.currency ?? "GHS").toUpperCase();
    const type = String(query.type ?? "mobile_money") as "mobile_money" | "ghipss";
    const response = await paystackService.listTransferBanks({ currency, type });
    return ok({ data: response.data ?? [], message: response.message });
  }, {
    query: t.Object({
      currency: t.Optional(t.String()),
      type: t.Optional(t.Union([t.Literal("mobile_money"), t.Literal("ghipss")])),
    }),
  })
  .post("/claim", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    const code = normalizeReferralCode(body.referralCode ?? body.referral_code);
    await ensureUserReferralCode(auth.userId);
    if (!code) return ok({ data: null, message: "No referral code supplied" });

    const db = getDb();
    const [referrer] = await db`
      SELECT id::text AS user_id, email, referral_code
      FROM auth.users
      WHERE upper(referral_code) = ${code}
      UNION ALL
      SELECT u.id::text AS user_id, u.email, sc.referral_code
      FROM support_clients sc
      INNER JOIN auth.users u ON u.id::text = sc.user_key_id
      WHERE upper(sc.referral_code) = ${code}
      LIMIT 1
    `;
    if (!referrer) throw new HttpError(404, "referral_code_not_found", "Referral code was not found");
    if (String(referrer.user_id) === auth.userId) {
      throw new HttpError(400, "self_referral_not_allowed", "You cannot refer yourself");
    }

    const [existing] = await db`
      SELECT *
      FROM referral_relationships
      WHERE referred_user_id = ${auth.userId}::uuid
      LIMIT 1
    `;
    if (existing) {
      return ok({ data: toCamel(existing), message: "Referral relationship already exists" });
    }

    const rateBps = pickReferralRateBps();
    const [relationship] = await db.begin(async (tx) => {
      const [rel] = await tx`
        INSERT INTO referral_relationships (
          referrer_user_id, referred_user_id, referral_code_used, commission_rate_bps,
          commission_model, status, metadata
        )
        VALUES (
          ${String(referrer.user_id)}::uuid, ${auth.userId}::uuid, ${code}, ${rateBps},
          ${COMMISSION_MODEL}, 'active', ${tx.json({ source: "signup_claim" })}
        )
        RETURNING *
      `;
      await tx`
        UPDATE auth.users
        SET referred_by_user_id = COALESCE(referred_by_user_id, ${String(referrer.user_id)}::uuid),
          updated_at = NOW()
        WHERE id = ${auth.userId}::uuid
      `;
      await tx`
        UPDATE support_clients
        SET referred_by_user_key_id = COALESCE(referred_by_user_key_id, ${String(referrer.user_id)}),
          referral_link_code = COALESCE(referral_link_code, ${code}),
          updated_at = NOW()
        WHERE user_key_id = ${auth.userId}
      `;
      return [rel];
    });
    await invalidateReferralCache(String(referrer.user_id));
    await invalidateReferralCache(auth.userId);
    return ok({
      data: toCamel(relationship),
      message: `Referral connected. Your referrer earns ${roundMoney(rateBps / 100)}% on verified payments.`,
    });
  }, {
    body: t.Object({
      referralCode: t.Optional(t.String()),
      referral_code: t.Optional(t.String()),
    }),
  })
  .post("/payout-profile", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const payoutType = String(body.payoutType ?? body.payout_type);
    const currency = String(body.currency ?? "GHS").toUpperCase();
    const accountName = String(body.accountName ?? body.account_name ?? "").trim();
    const accountNumber = String(body.accountNumber ?? body.account_number ?? "").trim();
    const bankCode = String(body.bankCode ?? body.bank_code ?? "").trim().toUpperCase();
    const bankName = String(body.bankName ?? body.bank_name ?? "").trim();
    const authorizationCode = String(body.authorizationCode ?? body.authorization_code ?? "").trim();
    if (!["mobile_money", "ghipss", "authorization"].includes(payoutType)) {
      throw new HttpError(400, "unsupported_payout_type", "Use Mobile Money, bank transfer, or a Paystack authorization recipient");
    }
    if (!accountName) throw new HttpError(400, "account_name_required", "Account name is required");
    if (payoutType === "authorization" && !authorizationCode) {
      throw new HttpError(400, "authorization_code_required", "Use a Paystack authorization code. Do not send raw card numbers.");
    }
    if (payoutType !== "authorization" && (!accountNumber || !bankCode)) {
      throw new HttpError(400, "payout_destination_required", "Account or mobile money number and bank/telco code are required");
    }

    const recipient = await paystackService.createTransferRecipient({
      type: payoutType as "mobile_money" | "ghipss" | "authorization",
      name: accountName,
      accountNumber,
      bankCode,
      currency,
      authorizationCode,
      description: "CogniZap referral payout recipient",
      metadata: { userId: auth.userId, source: "referral_payout_profile" },
    });
    const data = (recipient.data ?? {}) as Record<string, any>;
    await db`
      UPDATE referral_payout_profiles
      SET is_default = FALSE, status = 'disabled', updated_at = NOW()
      WHERE user_id = ${auth.userId}::uuid AND is_default = TRUE
    `;
    const [profile] = await db`
      INSERT INTO referral_payout_profiles (
        user_id, payout_type, account_name, account_number_last4, bank_code, bank_name,
        currency, paystack_recipient_code, paystack_recipient_id, provider_payload, is_default, status
      )
      VALUES (
        ${auth.userId}::uuid, ${payoutType}, ${accountName}, ${last4(accountNumber || authorizationCode)},
        ${bankCode || null}, ${bankName || (data.details as any)?.bank_name || null}, ${currency},
        ${data.recipient_code ? String(data.recipient_code) : null},
        ${data.id ? String(data.id) : null},
        ${db.json({
          paystackDomain: data.domain ?? null,
          recipientType: data.type ?? payoutType,
          active: data.active ?? null,
          details: {
            bankCode: (data.details as any)?.bank_code ?? bankCode ?? null,
            bankName: (data.details as any)?.bank_name ?? bankName ?? null,
            accountName: (data.details as any)?.account_name ?? null,
          },
        })},
        TRUE,
        'active'
      )
      RETURNING id, payout_type, account_name, account_number_last4, bank_code, bank_name,
        currency, paystack_recipient_code, status, created_at, updated_at
    `;
    await invalidateReferralCache(auth.userId);
    return ok({ data: toCamel(profile), message: recipient.message || "Payout profile saved" });
  }, {
    body: t.Object({
      payoutType: t.Optional(t.Union([t.Literal("mobile_money"), t.Literal("ghipss"), t.Literal("authorization")])),
      payout_type: t.Optional(t.Union([t.Literal("mobile_money"), t.Literal("ghipss"), t.Literal("authorization")])),
      accountName: t.Optional(t.String()),
      account_name: t.Optional(t.String()),
      accountNumber: t.Optional(t.String()),
      account_number: t.Optional(t.String()),
      bankCode: t.Optional(t.String()),
      bank_code: t.Optional(t.String()),
      bankName: t.Optional(t.String()),
      bank_name: t.Optional(t.String()),
      authorizationCode: t.Optional(t.String()),
      authorization_code: t.Optional(t.String()),
      currency: t.Optional(t.String()),
    }),
  })
  .post("/withdraw", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [profile] = await db`
      SELECT *
      FROM referral_payout_profiles
      WHERE user_id = ${auth.userId}::uuid AND is_default = TRUE AND status = 'active'
      LIMIT 1
    `;
    if (!profile?.paystack_recipient_code) {
      throw new HttpError(400, "payout_profile_required", "Set up your referral payout destination first");
    }

    const [available] = await db`
      SELECT COALESCE(SUM(commission_amount_pesewas), 0)::bigint AS amount_pesewas
      FROM referral_commissions
      WHERE referrer_user_id = ${auth.userId}::uuid
        AND (status = 'available' OR (status = 'pending' AND available_at <= NOW()))
    `;
    const availablePesewas = Number(available?.amount_pesewas ?? 0);
    const amountPesewas = availablePesewas;
    if (amountPesewas < MIN_WITHDRAWAL_PESEWAS) {
      throw new HttpError(400, "minimum_withdrawal_not_met", "Referral withdrawals require at least GHS 50.00 available");
    }

    const reference = `ref_${auth.userId.replace(/-/g, "").slice(0, 12)}_${Date.now()}`;
    const autoTransfer = Boolean(body.autoTransfer ?? body.auto_transfer);
    let transfer: Record<string, any> | null = null;
    if (autoTransfer) {
      const response = await paystackService.initiateTransfer({
        amount: amountPesewas / 100,
        currency: String(profile.currency ?? "GHS"),
        recipient: String(profile.paystack_recipient_code),
        reference,
        reason: "CogniZap referral payout",
      });
      transfer = response.data ?? null;
    }

    const [payout] = await db`
      INSERT INTO referral_payouts (
        user_id, payout_profile_id, amount_pesewas, currency, payout_method,
        paystack_transfer_code, provider_reference, status, metadata
      )
      VALUES (
        ${auth.userId}::uuid, ${profile.id}, ${amountPesewas}, ${String(profile.currency ?? "GHS")},
        'paystack_transfer',
        ${transfer?.transfer_code ? String(transfer.transfer_code) : null},
        ${reference},
        ${autoTransfer ? "processing" : "requested"},
        ${db.json({ autoTransfer, transferStatus: transfer?.status ?? null })}
      )
      RETURNING *
    `;
    await db`
      UPDATE referral_commissions
      SET status = CASE WHEN ${autoTransfer} THEN 'paid' ELSE 'available' END,
        paid_at = CASE WHEN ${autoTransfer} THEN NOW() ELSE paid_at END,
        updated_at = NOW()
      WHERE referrer_user_id = ${auth.userId}::uuid
        AND (status = 'available' OR (status = 'pending' AND available_at <= NOW()))
    `;
    await invalidateReferralCache(auth.userId);
    return ok({ data: toCamel(payout), transfer, message: autoTransfer ? "Referral payout transfer started" : "Referral payout requested" });
  }, {
    body: t.Object({
      amountPesewas: t.Optional(t.Number()),
      amount_pesewas: t.Optional(t.Number()),
      autoTransfer: t.Optional(t.Boolean()),
      auto_transfer: t.Optional(t.Boolean()),
    }),
  });
