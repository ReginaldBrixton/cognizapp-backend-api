import { Elysia, t } from "elysia";
import { createHash } from "node:crypto";

import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { paystackService } from "../../lib/paystack";
import { normalizePublicCallbackUrl } from "../../lib/site-url";
import { cache } from "../../lib/cache";
import { resolveAuth, type AuthContext } from "../auth/middleware";
import { workspaceRepository } from "../workspace/repository";

const MOBILE_MONEY_ATTEMPT_TTL_SECONDS = 5 * 60;

const DEFAULT_SUBSCRIPTION_PLANS = [
  {
    id: "free",
    name: "Free",
    description: "AI entry point for casual users testing CognizApp.",
    monthlyPrice: 0,
    yearlyPrice: 0,
    currency: "GHS",
    analysisLimitMonthly: 10,
    workspaceLimit: 1,
    storageQuotaBytes: 1073741824,
    supportDiscountPercent: 0,
    monthlySupportCredit: 0,
    priorityLevel: 0,
    displayOrder: 0,
    features: {
      aiChat: true,
      basicAnalysis: true,
      basicProjectOrganization: true,
      supportRequests: true,
    },
  },
  {
    id: "scholar_pro",
    name: "Scholar Pro",
    description:
      "Academic workspace for students, thesis work, and research projects.",
    monthlyPrice: 99,
    yearlyPrice: 999,
    currency: "GHS",
    analysisLimitMonthly: 250,
    workspaceLimit: 5,
    storageQuotaBytes: 53687091200,
    supportDiscountPercent: 10,
    monthlySupportCredit: 0,
    priorityLevel: 1,
    displayOrder: 1,
    features: {
      aiChat: true,
      advancedAnalysis: true,
      projects: true,
      collections: true,
      documents: true,
      slides: true,
      spreadsheets: true,
      notes: true,
      tasks: true,
      supportRequests: true,
      fileUploads: true,
      automations: "basic",
    },
  },
  {
    id: "research_max",
    name: "Research Max",
    description:
      "Premium academic operating system with priority support and credits.",
    monthlyPrice: 249,
    yearlyPrice: 2490,
    currency: "GHS",
    analysisLimitMonthly: 1000,
    workspaceLimit: 20,
    storageQuotaBytes: 214748364800,
    supportDiscountPercent: 20,
    monthlySupportCredit: 100,
    priorityLevel: 2,
    displayOrder: 2,
    features: {
      aiChat: true,
      advancedAnalysis: true,
      projects: true,
      collections: true,
      documents: true,
      slides: true,
      spreadsheets: true,
      notes: true,
      tasks: true,
      supportRequests: true,
      fileUploads: true,
      automations: "advanced",
      collaboration: true,
      premiumExports: true,
      earlyAccess: true,
      prioritySupport: true,
    },
  },
] as const;

let defaultPlansPromise: Promise<void> | null = null;

const PLAN_ID_ALIASES: Record<string, string> = {
  free: "free",
  scholar: "scholar_pro",
  scholarpro: "scholar_pro",
  "scholar-pro": "scholar_pro",
  scholar_pro: "scholar_pro",
  pro: "scholar_pro",
  research: "research_max",
  researchmax: "research_max",
  "research-max": "research_max",
  research_max: "research_max",
  max: "research_max",
};

function normalizeSubscriptionPlanId(value: string) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  const dashed = raw.replace(/\s+/g, "-");
  const underscored = raw.replace(/[\s-]+/g, "_");
  const compact = raw.replace(/[\s_-]+/g, "");

  return (
    PLAN_ID_ALIASES[raw] ??
    PLAN_ID_ALIASES[dashed] ??
    PLAN_ID_ALIASES[underscored] ??
    PLAN_ID_ALIASES[compact] ??
    underscored
  );
}

function toCamel(row: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
      value,
    ]),
  );
}

function periodEnd(cycle: string) {
  const end = new Date();
  if (cycle === "yearly") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

function paystackIntervalForCycle(cycle: string) {
  return cycle === "yearly" ? "annually" : "monthly";
}

function parsePaystackDate(value: unknown) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value * 1000);
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventHash(payload: Record<string, any>) {
  const event = String(payload.event ?? "");
  const data = payload.data ?? {};
  const identity = [
    event,
    data.reference,
    data.id,
    data.invoice_code,
    data.subscription?.subscription_code,
    data.subscription_code,
    data.customer?.customer_code,
    data.paid_at,
    data.createdAt,
  ]
    .filter(Boolean)
    .join(":");
  return createHash("sha256")
    .update(identity || JSON.stringify(payload))
    .digest("hex");
}

async function ensureDefaultSubscriptionPlans() {
  if (defaultPlansPromise) {
    return defaultPlansPromise;
  }

  defaultPlansPromise ??= (async () => {
    const db = getDb();

    for (const plan of DEFAULT_SUBSCRIPTION_PLANS) {
      await db`
        INSERT INTO subscription_plans (
          id, name, description, monthly_price, yearly_price, currency,
          analysis_limit_monthly, workspace_limit, storage_quota_bytes,
          support_discount_percent, monthly_support_credit, priority_level,
          features, display_order, is_active
        )
        VALUES (
          ${plan.id}, ${plan.name}, ${plan.description},
          ${plan.monthlyPrice}, ${plan.yearlyPrice}, ${plan.currency},
          ${plan.analysisLimitMonthly}, ${plan.workspaceLimit}, ${plan.storageQuotaBytes},
          ${plan.supportDiscountPercent}, ${plan.monthlySupportCredit}, ${plan.priorityLevel},
          ${db.json(plan.features)}, ${plan.displayOrder}, TRUE
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          monthly_price = EXCLUDED.monthly_price,
          yearly_price = EXCLUDED.yearly_price,
          currency = EXCLUDED.currency,
          analysis_limit_monthly = EXCLUDED.analysis_limit_monthly,
          workspace_limit = EXCLUDED.workspace_limit,
          storage_quota_bytes = EXCLUDED.storage_quota_bytes,
          support_discount_percent = EXCLUDED.support_discount_percent,
          monthly_support_credit = EXCLUDED.monthly_support_credit,
          priority_level = EXCLUDED.priority_level,
          features = EXCLUDED.features,
          display_order = EXCLUDED.display_order,
          is_active = TRUE,
          updated_at = NOW()
      `;
    }

    await cache.deletePattern("billing:plans:*");
  })().catch((error) => {
    defaultPlansPromise = null;
    throw error;
  });

  return defaultPlansPromise;
}

async function resolveWorkspace(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
) {
  const db = getDb();
  if (requestedWorkspaceId) {
    const workspace = await workspaceRepository.getById(requestedWorkspaceId);
    if (!workspace)
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    if (
      workspace.ownerUid === auth.userId ||
      (await workspaceRepository.getMember(requestedWorkspaceId, auth.userId))
    ) {
      return workspace;
    }
    throw new HttpError(403, "forbidden", "Access denied to this workspace");
  }

  const [workspace] = await db`
    SELECT *
    FROM workspaces
    WHERE owner_uid = ${auth.userId} AND deleted_at IS NULL
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;
  if (!workspace)
    throw new HttpError(
      404,
      "workspace_not_found",
      "No workspace found for this account",
    );
  return {
    id: String(workspace.id),
    ownerUid: String(workspace.owner_uid),
    name: String(workspace.name),
  };
}

async function getSubscription(workspaceId: string) {
  const [subscription] = await getDb()`
    SELECT s.*, p.name AS plan_name, p.description AS plan_description,
      p.monthly_price, p.yearly_price, p.analysis_limit_monthly,
      p.workspace_limit, p.storage_quota_bytes, p.support_discount_percent,
      p.monthly_support_credit, p.priority_level, p.features
    FROM workspace_subscriptions s
    INNER JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return subscription;
}

async function ensurePaystackPlanCode(
  plan: Record<string, any>,
  cycle: "monthly" | "yearly",
  forceNew = false,
) {
  const existing =
    cycle === "yearly"
      ? plan.paystack_yearly_plan_code
      : plan.paystack_monthly_plan_code;
  if (existing && !forceNew) return String(existing);

  const amount = Number(
    cycle === "yearly" ? plan.yearly_price : plan.monthly_price,
  );
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(
      400,
      "invalid_plan_amount",
      "Paid plans must have a valid recurring amount",
    );
  }

  const interval = paystackIntervalForCycle(cycle);
  const response = await paystackService.createPlan({
    name: `${plan.name} ${cycle === "yearly" ? "Yearly" : "Monthly"}`,
    amount,
    currency: String(plan.currency ?? "GHS"),
    interval,
    description: String(plan.description ?? ""),
  });
  const planCode = String(
    (response.data as Record<string, any> | undefined)?.plan_code ?? "",
  );
  if (!planCode) {
    throw new HttpError(
      502,
      "payment_plan_missing",
      "Payment checkout did not return a recurring plan code",
    );
  }

  const db = getDb();
  await db`
    UPDATE subscription_plans
    SET ${db(cycle === "yearly" ? "paystack_yearly_plan_code" : "paystack_monthly_plan_code")} = ${planCode},
      updated_at = NOW()
    WHERE id = ${plan.id}
  `;
  await cache.deletePattern("billing:plans:*");
  return planCode;
}

async function clearPaystackPlanCode(
  planId: string,
  cycle: "monthly" | "yearly",
) {
  const db = getDb();
  await db`
    UPDATE subscription_plans
    SET ${db(cycle === "yearly" ? "paystack_yearly_plan_code" : "paystack_monthly_plan_code")} = NULL,
      updated_at = NOW()
    WHERE id = ${planId}
  `;
  await cache.deletePattern("billing:plans:*");
}

function providerMessage(value: unknown) {
  return String(value ?? "").replace(/paystack/gi, "payment");
}

function providerCode(value: string) {
  return value.replace(/^paystack_/, "payment_");
}

function providerDetails(details: unknown) {
  if (!details || typeof details !== "object") return details;
  const normalized = { ...(details as Record<string, unknown>) };
  if (typeof normalized.message === "string") {
    normalized.message = providerMessage(normalized.message);
  }
  return normalized;
}

function isMissingProviderPlan(error: unknown) {
  if (!(error instanceof HttpError)) return false;
  const details = error.details as { message?: unknown } | undefined;
  const message = `${error.message} ${details?.message ?? ""}`.toLowerCase();
  return (
    error.status === 404 &&
    error.code === "paystack_request_failed" &&
    message.includes("plan")
  );
}

function canFallbackToOneTimeCheckout(error: unknown) {
  if (!(error instanceof HttpError)) return false;
  if (error.code !== "paystack_request_failed") return false;
  return [400, 404, 422].includes(error.status);
}

async function syncBillingReadModel(input: {
  workspaceId: string;
  ownerUid: string;
  planId: string;
  status: string;
  billingCycle: string;
  customerCode?: string | null;
  subscriptionCode?: string | null;
  emailToken?: string | null;
  reference?: string | null;
  currentPeriodEnd?: Date | null;
  nextPaymentAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
}) {
  const db = getDb();
  await db`
    UPDATE workspaces
    SET plan = ${input.planId}, updated_at = NOW()
    WHERE id = ${input.workspaceId}::uuid
  `;

  try {
    await workspaceRepository.ensureWorkspaceSettings(
      input.workspaceId,
      input.ownerUid,
    );
    await db`
    UPDATE workspace_settings
    SET billing = COALESCE(billing, '{}'::jsonb) || jsonb_build_object(
        'plan', ${input.planId}::text,
        'status', ${input.status}::text,
        'billingCycle', ${input.billingCycle}::text,
        'subscriptionId', ${input.subscriptionCode ?? null}::text,
        'emailToken', ${input.emailToken ?? null}::text,
        'customerId', ${input.customerCode ?? null}::text,
        'billingEmail', COALESCE(billing->>'billingEmail', NULL::text),
        'currency', 'GHS',
        'currentPeriodEnd', ${input.currentPeriodEnd?.toISOString() ?? null}::text,
        'nextPaymentAt', ${input.nextPaymentAt?.toISOString() ?? null}::text,
        'lastPaymentReference', ${input.reference ?? null}::text,
        'cancelAtPeriodEnd', ${input.cancelAtPeriodEnd ?? false}::boolean,
        'billingAddress', COALESCE(billing->'billingAddress', '{}'::jsonb)
      ),
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND deleted_at IS NULL
  `;
  } catch (error) {
    console.warn("[billing] workspace settings read-model sync failed", {
      workspaceId: input.workspaceId,
      planId: input.planId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function activateSubscriptionFromReference(
  reference: string,
  auth?: AuthContext,
) {
  const db = getDb();
  const [transaction] = await db`
    SELECT pt.*, p.monthly_price, p.yearly_price
    FROM paystack_transactions pt
    LEFT JOIN subscription_plans p ON p.id = pt.plan_id
    WHERE pt.provider = 'paystack' AND pt.provider_reference = ${reference}
    LIMIT 1
  `;
  if (!transaction)
    throw new HttpError(
      404,
      "transaction_not_found",
      "Payment transaction not found",
    );
  if (auth && transaction.user_key_id !== auth.userId) {
    throw new HttpError(
      403,
      "forbidden",
      "This payment belongs to another account",
    );
  }

  const verification = await paystackService.verifyTransaction(reference);
  const data = (verification.data ?? {}) as Record<string, any>;
  const paid = String(data.status ?? "").toLowerCase() === "success";
  const expectedAmount = Number(transaction.amount ?? 0);
  const paidAmount = Math.round(Number(data.amount ?? 0)) / 100;
  const expectedCurrency = String(transaction.currency ?? "GHS").toUpperCase();
  const paidCurrency = String(data.currency ?? "").toUpperCase();

  if (!paid) {
    return {
      transaction: toCamel(transaction),
      paystack: verification,
      activated: false,
    };
  }
  if (
    Math.abs(paidAmount - expectedAmount) > 0.01 ||
    paidCurrency !== expectedCurrency
  ) {
    throw new HttpError(
      400,
      "payment_mismatch",
      "Payment amount or currency does not match the subscription checkout",
    );
  }

  const cycle = String(transaction.billing_cycle ?? "monthly");
  const end = periodEnd(cycle);
  const customer = data.customer as Record<string, any> | undefined;
  const authorization = data.authorization as Record<string, any> | undefined;
  const subscriptionData = data.subscription as Record<string, any> | undefined;
  const planData = data.plan as Record<string, any> | undefined;
  const subscriptionCode =
    subscriptionData?.subscription_code ??
    data.subscription_code ??
    planData?.subscription_code ??
    null;

  const [updatedTransaction] = await db`
    UPDATE paystack_transactions
    SET status = 'verified',
      provider_transaction_id = ${data.id ? String(data.id) : null},
      paystack_subscription_code = ${subscriptionCode ? String(subscriptionCode) : null},
      authorization_code = ${authorization?.authorization_code ? String(authorization.authorization_code) : null},
      channel = ${data.channel ? String(data.channel) : null},
      gateway_response = ${data.gateway_response ? String(data.gateway_response) : null},
      verified_payload = ${db.json(data)},
      verified_at = NOW(),
      updated_at = NOW()
    WHERE id = ${transaction.id}
    RETURNING *
  `;

  const [subscription] = await db`
    INSERT INTO workspace_subscriptions (
      workspace_id, owner_uid, plan_id, status, billing_cycle, currency,
      current_period_start, current_period_end, paystack_customer_code,
      paystack_subscription_code, last_payment_reference, metadata
    )
    VALUES (
      ${transaction.workspace_id}, ${transaction.user_key_id}, ${transaction.plan_id},
      'active', ${cycle}, ${transaction.currency}, NOW(), ${end},
      ${customer?.customer_code ? String(customer.customer_code) : null},
      ${subscriptionCode ? String(subscriptionCode) : null},
      ${reference}, ${db.json({ source: "paystack" })}
    )
    ON CONFLICT (workspace_id) DO UPDATE SET
      owner_uid = EXCLUDED.owner_uid,
      plan_id = EXCLUDED.plan_id,
      status = 'active',
      billing_cycle = EXCLUDED.billing_cycle,
      currency = EXCLUDED.currency,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      paystack_customer_code = COALESCE(EXCLUDED.paystack_customer_code, workspace_subscriptions.paystack_customer_code),
      paystack_subscription_code = COALESCE(EXCLUDED.paystack_subscription_code, workspace_subscriptions.paystack_subscription_code),
      last_payment_reference = EXCLUDED.last_payment_reference,
      updated_at = NOW()
    RETURNING *
  `;

  await syncBillingReadModel({
    workspaceId: String(subscription.workspace_id),
    ownerUid: String(subscription.owner_uid),
    planId: String(subscription.plan_id),
    status: String(subscription.status),
    billingCycle: String(subscription.billing_cycle),
    customerCode: subscription.paystack_customer_code
      ? String(subscription.paystack_customer_code)
      : null,
    subscriptionCode: subscription.paystack_subscription_code
      ? String(subscription.paystack_subscription_code)
      : null,
    reference,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end)
      : end,
  });

  return {
    transaction: toCamel(updatedTransaction),
    subscription: toCamel(subscription),
    paystack: verification,
    activated: true,
  };
}

async function recordRecurringChargeFromWebhook(
  data: Record<string, any>,
  eventType: string,
) {
  const db = getDb();
  const reference = data.reference ? String(data.reference) : null;
  const subscriptionCode =
    data.subscription?.subscription_code ??
    data.subscription_code ??
    data.subscription?.code ??
    null;
  if (!reference || !subscriptionCode) return null;

  const [subscription] = await db`
    UPDATE workspace_subscriptions
    SET status = 'active',
      current_period_start = COALESCE(${parsePaystackDate(data.period_start ?? data.paid_at ?? data.created_at)}, current_period_start, NOW()),
      current_period_end = COALESCE(
        ${parsePaystackDate(data.period_end ?? data.next_payment_date)},
        CASE WHEN billing_cycle = 'yearly' THEN NOW() + INTERVAL '1 year' ELSE NOW() + INTERVAL '1 month' END
      ),
      next_payment_at = COALESCE(
        ${parsePaystackDate(data.next_payment_date ?? data.period_end)},
        CASE WHEN billing_cycle = 'yearly' THEN NOW() + INTERVAL '1 year' ELSE NOW() + INTERVAL '1 month' END
      ),
      last_payment_reference = ${reference},
      grace_period_ends_at = NULL,
      updated_at = NOW()
    WHERE paystack_subscription_code = ${String(subscriptionCode)}
    RETURNING *
  `;
  if (!subscription) return null;

  const authorization = data.authorization as Record<string, any> | undefined;
  await db`
    INSERT INTO paystack_transactions (
      workspace_id, user_key_id, purpose, plan_id, billing_cycle, amount, currency,
      provider_reference, provider_transaction_id, paystack_subscription_code,
      authorization_code, channel, gateway_response, status, verified_payload,
      verified_at, metadata
    )
    VALUES (
      ${subscription.workspace_id}, ${subscription.owner_uid}, 'subscription_renewal',
      ${subscription.plan_id}, ${subscription.billing_cycle},
      ${Math.round(Number(data.amount ?? 0)) / 100}, ${String(data.currency ?? subscription.currency ?? "GHS")},
      ${reference}, ${data.id ? String(data.id) : null}, ${String(subscriptionCode)},
      ${authorization?.authorization_code ? String(authorization.authorization_code) : null},
      ${data.channel ? String(data.channel) : null},
      ${data.gateway_response ? String(data.gateway_response) : null},
      'verified', ${db.json(data)}, NOW(), ${db.json({ eventType, source: "paystack.webhook" })}
    )
    ON CONFLICT (provider, provider_reference) DO UPDATE SET
      status = 'verified',
      plan_id = EXCLUDED.plan_id,
      billing_cycle = EXCLUDED.billing_cycle,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      provider_transaction_id = EXCLUDED.provider_transaction_id,
      paystack_subscription_code = EXCLUDED.paystack_subscription_code,
      authorization_code = COALESCE(EXCLUDED.authorization_code, paystack_transactions.authorization_code),
      channel = COALESCE(EXCLUDED.channel, paystack_transactions.channel),
      gateway_response = COALESCE(EXCLUDED.gateway_response, paystack_transactions.gateway_response),
      verified_payload = EXCLUDED.verified_payload,
      verified_at = NOW(),
      updated_at = NOW()
  `;

  await syncBillingReadModel({
    workspaceId: String(subscription.workspace_id),
    ownerUid: String(subscription.owner_uid),
    planId: String(subscription.plan_id),
    status: String(subscription.status),
    billingCycle: String(subscription.billing_cycle),
    customerCode: subscription.paystack_customer_code
      ? String(subscription.paystack_customer_code)
      : null,
    subscriptionCode: subscription.paystack_subscription_code
      ? String(subscription.paystack_subscription_code)
      : null,
    emailToken: subscription.paystack_email_token
      ? String(subscription.paystack_email_token)
      : null,
    reference,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end)
      : null,
    nextPaymentAt: subscription.next_payment_at
      ? new Date(subscription.next_payment_at)
      : null,
  });

  return subscription;
}

async function processBillingWebhook(payload: Record<string, any>) {
  const db = getDb();
  const data = (payload.data ?? {}) as Record<string, any>;
  const eventType = String(payload.event ?? "");
  const reference = data.reference ? String(data.reference) : null;
  const subscriptionCode =
    data.subscription?.subscription_code ??
    data.subscription_code ??
    data.subscription?.code ??
    null;
  const invoiceCode = data.invoice_code ? String(data.invoice_code) : null;
  const hash = eventHash(payload);

  const [webhookEvent] = await db`
    INSERT INTO paystack_webhook_events (
      event_hash, event_type, provider_reference, paystack_subscription_code,
      paystack_invoice_code, payload
    )
    VALUES (
      ${hash}, ${eventType}, ${reference}, ${subscriptionCode ? String(subscriptionCode) : null},
      ${invoiceCode}, ${db.json(payload)}
    )
    ON CONFLICT (event_hash) DO NOTHING
    RETURNING *
  `;
  if (!webhookEvent) return { duplicate: true };

  if (eventType === "charge.success" && reference) {
    const [knownTransaction] = await db`
      SELECT id
      FROM paystack_transactions
      WHERE provider = 'paystack' AND provider_reference = ${reference}
      LIMIT 1
    `;
    if (knownTransaction) {
      await activateSubscriptionFromReference(reference);
    } else {
      await recordRecurringChargeFromWebhook(data, eventType);
    }
  }

  if (eventType === "subscription.create") {
    const metadata = (data.metadata ?? {}) as Record<string, any>;
    const workspaceId =
      metadata.workspaceId ?? data.plan?.metadata?.workspaceId;
    const planId = metadata.planId;
    const customerCode = data.customer?.customer_code ?? data.customer_code;
    const current = parsePaystackDate(data.createdAt) ?? new Date();
    const nextPaymentAt = parsePaystackDate(
      data.next_payment_date ?? data.nextPaymentDate,
    );
    if (workspaceId && planId) {
      const [subscription] = await db`
        INSERT INTO workspace_subscriptions (
          workspace_id, owner_uid, plan_id, status, billing_cycle, currency,
          current_period_start, current_period_end, next_payment_at,
          paystack_customer_code, paystack_subscription_code, paystack_email_token,
          metadata
        )
        SELECT
          w.id, w.owner_uid, ${String(planId)},
          'active', ${String(metadata.billingCycle ?? "monthly")}, ${String(data.currency ?? "GHS")},
          ${current}, ${nextPaymentAt ?? null}, ${nextPaymentAt ?? null},
          ${customerCode ? String(customerCode) : null},
          ${subscriptionCode ? String(subscriptionCode) : null},
          ${data.email_token ? String(data.email_token) : null},
          ${db.json({ source: "paystack.subscription.create" })}
        FROM workspaces w
        WHERE w.id = ${workspaceId}::uuid
        ON CONFLICT (workspace_id) DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          status = 'active',
          billing_cycle = EXCLUDED.billing_cycle,
          currency = EXCLUDED.currency,
          next_payment_at = COALESCE(EXCLUDED.next_payment_at, workspace_subscriptions.next_payment_at),
          paystack_customer_code = COALESCE(EXCLUDED.paystack_customer_code, workspace_subscriptions.paystack_customer_code),
          paystack_subscription_code = COALESCE(EXCLUDED.paystack_subscription_code, workspace_subscriptions.paystack_subscription_code),
          paystack_email_token = COALESCE(EXCLUDED.paystack_email_token, workspace_subscriptions.paystack_email_token),
          updated_at = NOW()
        RETURNING *
      `;
      await syncBillingReadModel({
        workspaceId: String(subscription.workspace_id),
        ownerUid: String(subscription.owner_uid),
        planId: String(subscription.plan_id),
        status: String(subscription.status),
        billingCycle: String(subscription.billing_cycle),
        customerCode: subscription.paystack_customer_code
          ? String(subscription.paystack_customer_code)
          : null,
        subscriptionCode: subscription.paystack_subscription_code
          ? String(subscription.paystack_subscription_code)
          : null,
        emailToken: subscription.paystack_email_token
          ? String(subscription.paystack_email_token)
          : null,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end)
          : null,
        nextPaymentAt: subscription.next_payment_at
          ? new Date(subscription.next_payment_at)
          : null,
      });
    }
  }

  if (
    eventType === "invoice.create" ||
    eventType === "invoice.update" ||
    eventType === "invoice.payment_failed"
  ) {
    const periodStart = parsePaystackDate(data.period_start);
    const periodEndValue = parsePaystackDate(data.period_end);
    const paid =
      data.paid === true ||
      String(data.status ?? "").toLowerCase() === "success";
    const status =
      eventType === "invoice.payment_failed"
        ? "past_due"
        : paid
          ? "active"
          : "pending";
    const effectiveSubscriptionCode = subscriptionCode
      ? String(subscriptionCode)
      : null;

    if (reference || invoiceCode) {
      await db`
        INSERT INTO paystack_transactions (
          workspace_id, user_key_id, purpose, amount, currency, provider_reference,
          paystack_subscription_code, paystack_invoice_code, status, gateway_response,
          verified_payload, verified_at, metadata
        )
        SELECT workspace_id, owner_uid, 'subscription_renewal',
          ${Math.round(Number(data.amount ?? 0)) / 100}, ${String(data.currency ?? "GHS")},
          ${reference ?? invoiceCode}, ${effectiveSubscriptionCode}, ${invoiceCode},
          ${paid ? "verified" : "failed"}, ${data.description ? String(data.description) : null},
          ${db.json(data)}, ${paid ? new Date() : null}, ${db.json({ eventType })}
        FROM workspace_subscriptions
        WHERE paystack_subscription_code = ${effectiveSubscriptionCode}
        LIMIT 1
        ON CONFLICT (provider, provider_reference) DO UPDATE SET
          status = EXCLUDED.status,
          gateway_response = EXCLUDED.gateway_response,
          verified_payload = EXCLUDED.verified_payload,
          verified_at = COALESCE(EXCLUDED.verified_at, paystack_transactions.verified_at),
          updated_at = NOW()
      `;
    }

    const [subscription] = await db`
      UPDATE workspace_subscriptions
      SET status = ${status},
        current_period_start = COALESCE(${periodStart}, current_period_start),
        current_period_end = CASE WHEN ${paid} THEN COALESCE(${periodEndValue}, current_period_end) ELSE current_period_end END,
        next_payment_at = CASE WHEN ${paid} THEN COALESCE(${periodEndValue}, next_payment_at) ELSE next_payment_at END,
        grace_period_ends_at = CASE WHEN ${status} = 'past_due' THEN NOW() + INTERVAL '7 days' ELSE NULL END,
        last_payment_reference = COALESCE(${reference}, last_payment_reference),
        updated_at = NOW()
      WHERE paystack_subscription_code = ${effectiveSubscriptionCode}
      RETURNING *
    `;
    if (subscription) {
      await syncBillingReadModel({
        workspaceId: String(subscription.workspace_id),
        ownerUid: String(subscription.owner_uid),
        planId: String(subscription.plan_id),
        status: String(subscription.status),
        billingCycle: String(subscription.billing_cycle),
        customerCode: subscription.paystack_customer_code
          ? String(subscription.paystack_customer_code)
          : null,
        subscriptionCode: subscription.paystack_subscription_code
          ? String(subscription.paystack_subscription_code)
          : null,
        emailToken: subscription.paystack_email_token
          ? String(subscription.paystack_email_token)
          : null,
        reference,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end)
          : null,
        nextPaymentAt: subscription.next_payment_at
          ? new Date(subscription.next_payment_at)
          : null,
      });
    }
  }

  if (
    eventType === "subscription.not_renew" ||
    eventType === "subscription.disable"
  ) {
    const status =
      eventType === "subscription.disable" ? "cancelled" : "active";
    const [subscription] = await db`
      UPDATE workspace_subscriptions
      SET status = ${status},
        cancel_at_period_end = TRUE,
        updated_at = NOW()
      WHERE paystack_subscription_code = ${subscriptionCode ? String(subscriptionCode) : null}
      RETURNING *
    `;
    if (subscription) {
      await syncBillingReadModel({
        workspaceId: String(subscription.workspace_id),
        ownerUid: String(subscription.owner_uid),
        planId: String(subscription.plan_id),
        status: String(subscription.status),
        billingCycle: String(subscription.billing_cycle),
        customerCode: subscription.paystack_customer_code
          ? String(subscription.paystack_customer_code)
          : null,
        subscriptionCode: subscription.paystack_subscription_code
          ? String(subscription.paystack_subscription_code)
          : null,
        emailToken: subscription.paystack_email_token
          ? String(subscription.paystack_email_token)
          : null,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end)
          : null,
        nextPaymentAt: subscription.next_payment_at
          ? new Date(subscription.next_payment_at)
          : null,
        cancelAtPeriodEnd: true,
      });
    }
  }

  await db`
    UPDATE paystack_webhook_events
    SET processed_at = NOW()
    WHERE event_hash = ${hash}
  `;

  return { duplicate: false };
}

export const billingRoutes = new Elysia({
  prefix: "/api/billing",
  tags: ["billing"],
})
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(
        providerMessage(error.message),
        providerCode(error.code),
        providerDetails(error.details),
      );
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })
  .get("/plans", async () => {
    await ensureDefaultSubscriptionPlans();
    const plans = await cache.rememberJson(
      "billing:plans:active:v1",
      300,
      async () => {
        const rows = await getDb()`
        SELECT *
        FROM subscription_plans
        WHERE is_active = TRUE
        ORDER BY display_order ASC
      `;
        return rows.map(toCamel);
      },
    );
    return ok({ data: plans });
  })
  .get(
    "/subscription",
    async ({ headers, query }) => {
      const auth = await resolveAuth(headers);
      const workspace = await resolveWorkspace(
        auth,
        String(query.workspaceId ?? query.workspace_id ?? query.id ?? "") ||
        null,
      );
      const subscription = await getSubscription(String(workspace.id));
      if (!subscription) {
        throw new HttpError(
          404,
          "subscription_not_found",
          "Subscription not found",
        );
      }
      await syncBillingReadModel({
        workspaceId: String(subscription.workspace_id),
        ownerUid: String(subscription.owner_uid),
        planId: String(subscription.plan_id),
        status: String(subscription.status),
        billingCycle: String(subscription.billing_cycle),
        customerCode: subscription.paystack_customer_code
          ? String(subscription.paystack_customer_code)
          : null,
        subscriptionCode: subscription.paystack_subscription_code
          ? String(subscription.paystack_subscription_code)
          : null,
        emailToken: subscription.paystack_email_token
          ? String(subscription.paystack_email_token)
          : null,
        reference: subscription.last_payment_reference
          ? String(subscription.last_payment_reference)
          : null,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end)
          : null,
        nextPaymentAt: subscription.next_payment_at
          ? new Date(subscription.next_payment_at)
          : null,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      });
      return ok({
        data: toCamel(subscription),
        workspaceId: String(workspace.id),
      });
    },
    {
      query: t.Object({
        workspaceId: t.Optional(t.String()),
        workspace_id: t.Optional(t.String()),
        id: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/subscription/cancel",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const workspace = await resolveWorkspace(auth, body.workspaceId ?? null);
      if (String(workspace.ownerUid) !== auth.userId) {
        throw new HttpError(
          403,
          "owner_required",
          "Only the workspace owner can cancel this subscription",
        );
      }

      const subscription = await getSubscription(String(workspace.id));
      if (!subscription) {
        throw new HttpError(
          404,
          "subscription_not_found",
          "Subscription not found",
        );
      }

      const subscriptionCode = subscription.paystack_subscription_code
        ? String(subscription.paystack_subscription_code)
        : null;
      const emailToken = subscription.paystack_email_token
        ? String(subscription.paystack_email_token)
        : null;
      let providerCancellation: Record<string, unknown> | null = null;

      if (
        subscriptionCode &&
        emailToken &&
        subscription.cancel_at_period_end !== true
      ) {
        try {
          providerCancellation = await paystackService.disableSubscription({
            code: subscriptionCode,
            token: emailToken,
          });
        } catch (error) {
          throw new HttpError(
            502,
            "subscription_cancel_provider_failed",
            "Unable to confirm subscription cancellation with the payment provider. Please try again.",
            providerDetails(error instanceof HttpError ? error.details : error),
          );
        }
      }

      const [updatedSubscription] = await db`
        UPDATE workspace_subscriptions
        SET cancel_at_period_end = TRUE,
          status = CASE WHEN status IN ('cancelled', 'expired') THEN status ELSE 'active' END,
          updated_at = NOW()
        WHERE workspace_id = ${String(workspace.id)}::uuid
        RETURNING *
      `;

      await syncBillingReadModel({
        workspaceId: String(updatedSubscription.workspace_id),
        ownerUid: String(updatedSubscription.owner_uid),
        planId: String(updatedSubscription.plan_id),
        status: String(updatedSubscription.status),
        billingCycle: String(updatedSubscription.billing_cycle),
        customerCode: updatedSubscription.paystack_customer_code
          ? String(updatedSubscription.paystack_customer_code)
          : null,
        subscriptionCode: updatedSubscription.paystack_subscription_code
          ? String(updatedSubscription.paystack_subscription_code)
          : null,
        emailToken: updatedSubscription.paystack_email_token
          ? String(updatedSubscription.paystack_email_token)
          : null,
        reference: updatedSubscription.last_payment_reference
          ? String(updatedSubscription.last_payment_reference)
          : null,
        currentPeriodEnd: updatedSubscription.current_period_end
          ? new Date(updatedSubscription.current_period_end)
          : null,
        nextPaymentAt: updatedSubscription.next_payment_at
          ? new Date(updatedSubscription.next_payment_at)
          : null,
        cancelAtPeriodEnd: true,
      });

      return ok({
        data: toCamel(updatedSubscription),
        providerCancellation,
        message:
          "Subscription renewal has been cancelled. Access remains active until the current paid period ends.",
      });
    },
    {
      body: t.Object({
        workspaceId: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/paystack/checkout",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      await ensureDefaultSubscriptionPlans();
      const workspace = await resolveWorkspace(auth, body.workspaceId ?? null);
      const planId = normalizeSubscriptionPlanId(body.planId);
      const [plan] = await db`
      SELECT * FROM subscription_plans
      WHERE id = ${planId} AND is_active = TRUE
      LIMIT 1
    `;
      if (!plan) {
        throw new HttpError(
          404,
          "plan_not_found",
          "Subscription plan not found",
          {
            requestedPlanId: body.planId,
            normalizedPlanId: planId,
            availablePlanIds: DEFAULT_SUBSCRIPTION_PLANS.map((item) => item.id),
          },
        );
      }
      if (plan.id === "free") {
        throw new HttpError(
          400,
          "free_plan_checkout_not_required",
          "The Free plan does not require checkout",
        );
      }

      const cycle = body.billingCycle ?? "monthly";
      const existingSubscription = await getSubscription(String(workspace.id));
      if (
        existingSubscription &&
        String(existingSubscription.status) === "active" &&
        String(existingSubscription.plan_id) === String(plan.id) &&
        String(existingSubscription.billing_cycle) === cycle &&
        existingSubscription.cancel_at_period_end !== true
      ) {
        throw new HttpError(
          409,
          "subscription_already_active",
          "This workspace is already active on that plan and billing cycle",
        );
      }

      const amount = Number(
        cycle === "yearly" ? plan.yearly_price : plan.monthly_price,
      );
      const reference = paystackService.createReference(
        `sub_${workspace.id}_${plan.id}`,
      );
      const metadata = {
        purpose: "subscription",
        workspaceId: String(workspace.id),
        planId: String(plan.id),
        billingCycle: cycle,
        userId: auth.userId,
      };
      const callbackUrl = normalizePublicCallbackUrl(body.callbackUrl);
      let planCode: string | null = null;
      let recurringCheckout = body.recurring === true;
      let paystack: Awaited<
        ReturnType<typeof paystackService.initializeCheckout>
      >;
      const initializeCheckout = (nextPlanCode: string | null) =>
        paystackService.initializeCheckout({
          email: auth.email,
          amount,
          currency: String(plan.currency ?? "GHS"),
          reference,
          plan: nextPlanCode ?? undefined,
          channels: body.channels ?? ["card", "bank", "mobile_money"],
          callbackUrl,
          metadata: { ...metadata, recurring: Boolean(nextPlanCode) },
        });

      if (recurringCheckout) {
        try {
          planCode = await ensurePaystackPlanCode(plan, cycle);
          paystack = await initializeCheckout(planCode);
        } catch (error) {
          if (isMissingProviderPlan(error)) {
            await clearPaystackPlanCode(String(plan.id), cycle);
            planCode = await ensurePaystackPlanCode(plan, cycle, true);
            try {
              paystack = await initializeCheckout(planCode);
            } catch (retryError) {
              if (!canFallbackToOneTimeCheckout(retryError)) {
                throw retryError;
              }
              recurringCheckout = false;
              planCode = null;
              paystack = await initializeCheckout(null);
            }
          } else if (canFallbackToOneTimeCheckout(error)) {
            recurringCheckout = false;
            planCode = null;
            paystack = await initializeCheckout(null);
          } else {
            throw error;
          }
        }
      } else {
        paystack = await initializeCheckout(null);
      }

      const [transaction] = await db`
      INSERT INTO paystack_transactions (
        workspace_id, user_key_id, purpose, plan_id, billing_cycle,
        amount, currency, provider_reference, status, metadata
      )
      VALUES (
        ${workspace.id}::uuid, ${auth.userId}, 'subscription', ${plan.id}, ${cycle},
        ${amount}, ${plan.currency ?? "GHS"}, ${reference}, 'pending', ${db.json({ ...metadata, paystackPlanCode: planCode, recurring: recurringCheckout })}
      )
      RETURNING *
    `;

      return ok({
        data: toCamel(transaction),
        paystack,
        accessCode:
          (paystack.data as Record<string, unknown> | undefined)?.access_code ??
          null,
        authorizationUrl:
          (paystack.data as Record<string, unknown> | undefined)
            ?.authorization_url ?? null,
        checkoutMode: recurringCheckout ? "recurring" : "one_time",
        message: "Payment checkout initialized",
      });
    },
    {
      body: t.Object({
        workspaceId: t.Optional(t.String()),
        planId: t.String(),
        billingCycle: t.Optional(
          t.Union([t.Literal("monthly"), t.Literal("yearly")]),
        ),
        recurring: t.Optional(t.Boolean()),
        callbackUrl: t.Optional(t.String()),
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
    "/paystack/verify",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const result = await activateSubscriptionFromReference(
        body.reference.trim(),
        auth,
      );
      return ok({
        ...result,
        message: result.activated
          ? "Subscription activated"
          : "Payment is not successful yet",
      });
    },
    {
      body: t.Object({ reference: t.String() }),
    },
  )
  .post(
    "/paystack/mobile-money",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      await ensureDefaultSubscriptionPlans();
      const workspace = await resolveWorkspace(auth, body.workspaceId ?? null);
      const planId = normalizeSubscriptionPlanId(body.planId);
      const [plan] = await db`
        SELECT * FROM subscription_plans
        WHERE id = ${planId} AND is_active = TRUE
        LIMIT 1
      `;
      if (!plan) {
        throw new HttpError(404, "plan_not_found", "Subscription plan not found");
      }
      if (plan.id === "free") {
        throw new HttpError(400, "free_plan_checkout_not_required", "The Free plan does not require checkout");
      }

      const phone = paystackService.normalizeMobileMoneyPhone(String(body.phone ?? ""));
      if (!phone || phone.length < 9) {
        throw new HttpError(400, "invalid_mobile_money_phone", "Enter a valid mobile money phone number");
      }
      const provider = paystackService.normalizeProvider(body.provider);
      const phoneHash = paystackService.hashMobileMoneyPhone(phone);

      const cycle = body.billingCycle ?? "monthly";
      const existingSubscription = await getSubscription(String(workspace.id));
      if (
        existingSubscription &&
        String(existingSubscription.status) === "active" &&
        String(existingSubscription.plan_id) === String(plan.id) &&
        String(existingSubscription.billing_cycle) === cycle &&
        existingSubscription.cancel_at_period_end !== true
      ) {
        throw new HttpError(409, "subscription_already_active", "This workspace is already active on that plan and billing cycle");
      }

      const amount = Number(cycle === "yearly" ? plan.yearly_price : plan.monthly_price);
      const currency = String(plan.currency ?? "GHS");

      // Check for reusable pending transaction (same phone + provider)
      const [pendingTx] = await db`
        SELECT *,
          GREATEST(
            0,
            ${MOBILE_MONEY_ATTEMPT_TTL_SECONDS} - FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)))
          )::int AS expires_in_seconds
        FROM paystack_transactions
        WHERE workspace_id = ${workspace.id}::uuid
          AND user_key_id = ${auth.userId}
          AND plan_id = ${plan.id}
          AND billing_cycle = ${cycle}
          AND provider = 'paystack'
          AND status = 'pending'
          AND verified_at IS NULL
          AND metadata->>'mobileMoneyProvider' = ${provider}
          AND metadata->>'phoneHash' = ${phoneHash}
          AND created_at > NOW() - (${MOBILE_MONEY_ATTEMPT_TTL_SECONDS} || ' seconds')::interval
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (pendingTx) {
        const reference = String(pendingTx.provider_reference);
        const pendingStep = String(pendingTx.metadata?.pendingStep ?? "") === "otp" ? "otp" : "phone_authorization";
        const expiresInSeconds = Math.max(1, Number(pendingTx.expires_in_seconds ?? MOBILE_MONEY_ATTEMPT_TTL_SECONDS));
        return ok({
          data: toCamel(pendingTx),
          reference,
          reused: true,
          expiresInSeconds,
          pendingStep,
          phoneLast4: phone.slice(-4),
          provider,
          chargeStatus: pendingStep === "otp" ? "send_otp" : "pay_offline",
          paystack: {
            status: true,
            message: "Mobile money authorization is already pending",
            data: { reference, status: pendingStep === "otp" ? "send_otp" : "pay_offline" },
          },
          message: "Mobile money authorization is already pending",
        });
      }

      // Cancel stale pending transactions for this workspace+plan+cycle
      await db`
        UPDATE paystack_transactions
        SET status = 'cancelled',
          metadata = COALESCE(metadata, '{}'::jsonb) || ${db.json({
        cancelledAt: new Date().toISOString(),
        cancelledBy: auth.userId,
        cancelReason: "mobile_money_attempt_replaced",
      })}::jsonb,
          updated_at = NOW()
        WHERE workspace_id = ${workspace.id}::uuid
          AND user_key_id = ${auth.userId}
          AND plan_id = ${plan.id}
          AND billing_cycle = ${cycle}
          AND provider = 'paystack'
          AND status = 'pending'
          AND verified_at IS NULL
      `;

      const reference = paystackService.createReference(`sub_${workspace.id}_${plan.id}`);
      const metadata = {
        purpose: "subscription",
        workspaceId: String(workspace.id),
        planId: String(plan.id),
        billingCycle: cycle,
        userId: auth.userId,
        method: "mobile_money",
        mobileMoneyProvider: provider,
        phoneLast4: phone.slice(-4),
        phoneHash,
      };

      console.info("[billing:paystack.mobile_money] initializing", {
        workspaceId: String(workspace.id),
        planId: String(plan.id),
        userId: auth.userId,
        amount,
        currency,
        provider,
      });

      // MTN/AirtelTigo: Use Paystack hosted checkout for the full OTP → PIN flow.
      // The Charge API returns "pay_offline" for MTN/ATL (phone-only auth, no OTP).
      // Hosted checkout supports the OTP code → PIN authorization flow the user expects.
      // Telecel (vod) keeps the Charge API for its voucher code system.
      const useHostedCheckout = provider === "mtn" || provider === "atl";
      const callbackUrl = normalizePublicCallbackUrl(body.callbackUrl ?? "");
      let paystack: Awaited<ReturnType<typeof paystackService.initializeCheckout>>;
      let chargeStatus: string;
      let displayText: string;
      let pendingStep: string;
      let authorizationUrl: string | null = null;
      let accessCode: string | null = null;

      if (useHostedCheckout) {
        paystack = await paystackService.initializeCheckout({
          email: auth.email,
          amount,
          currency,
          reference,
          channels: ["mobile_money"],
          callbackUrl,
          metadata,
        });
        const checkoutData = (paystack.data as Record<string, unknown>) ?? {};
        authorizationUrl = (checkoutData.authorization_url as string) ?? null;
        accessCode = (checkoutData.access_code as string) ?? null;
        chargeStatus = "open_checkout";
        displayText = "Redirecting to Paystack for secure mobile money payment...";
        pendingStep = "hosted_checkout";
      } else {
        paystack = await paystackService.chargeMobileMoney({
          email: auth.email,
          amount,
          currency,
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

      const [transaction] = await db`
        INSERT INTO paystack_transactions (
          workspace_id, user_key_id, purpose, plan_id, billing_cycle,
          amount, currency, provider_reference, status, metadata
        )
        VALUES (
          ${workspace.id}::uuid, ${auth.userId}, 'subscription', ${plan.id}, ${cycle},
          ${amount}, ${currency}, ${reference}, 'pending', ${db.json({ ...metadata, pendingStep })}
        )
        RETURNING *
      `;

      console.info("[billing:paystack.mobile_money] Charge response", {
        reference,
        status: chargeStatus,
        displayText,
        provider,
      });

      return ok({
        data: toCamel(transaction),
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
        workspaceId: t.Optional(t.String()),
        planId: t.String(),
        billingCycle: t.Optional(t.Union([t.Literal("monthly"), t.Literal("yearly")])),
        phone: t.String(),
        provider: t.String(),
        callbackUrl: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/paystack/submit-otp",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const reference = String(body.reference ?? "").trim();
      const otp = String(body.otp ?? "").trim();
      if (!reference) {
        throw new HttpError(400, "reference_required", "Payment reference is required");
      }
      if (!otp || otp.length < 4) {
        throw new HttpError(400, "invalid_otp", "Enter the OTP sent to your phone");
      }

      const db = getDb();
      const [transaction] = await db`
        SELECT * FROM paystack_transactions
        WHERE provider = 'paystack' AND provider_reference = ${reference}
          AND user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!transaction) {
        throw new HttpError(404, "transaction_not_found", "Payment transaction not found");
      }

      console.info("[billing:paystack.submit_otp] Submitting OTP", { reference, userId: auth.userId });

      const result = await paystackService.submitOtp({ reference, otp });
      const chargeData = (result.data as Record<string, unknown>) ?? {};
      const chargeStatus = String(chargeData.status ?? "");
      const displayText = String((chargeData as any).display_text ?? "");

      console.info("[billing:paystack.submit_otp] Response", { reference, status: chargeStatus, displayText });

      if (chargeStatus === "pending" || chargeStatus === "pay_offline" || chargeStatus === "send_pin") {
        await db`
          UPDATE paystack_transactions
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${db.json({ pendingStep: "phone_authorization" })}::jsonb,
            updated_at = NOW()
          WHERE id = ${transaction.id}
        `;
        return ok({
          data: toCamel(transaction),
          paystack: result,
          status: "awaiting_pin_on_phone",
          message: displayText || "OTP accepted. Complete the PIN authorization on your phone.",
        });
      }

      if (chargeStatus === "success") {
        const activated = await activateSubscriptionFromReference(reference, auth);
        return ok({
          data: toCamel(transaction),
          paystack: result,
          verified: activated.activated,
          message: "Payment successful",
        });
      }

      return ok({
        data: toCamel(transaction),
        paystack: result,
        status: chargeStatus,
        message: result.message || displayText || "Processing payment. Check your phone.",
      });
    },
    {
      body: t.Object({ reference: t.String(), otp: t.String() }),
    },
  )
  .post(
    "/paystack/check",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const reference = String(body.reference ?? "").trim();
      const db = getDb();
      const [transaction] = await db`
        SELECT * FROM paystack_transactions
        WHERE provider = 'paystack' AND provider_reference = ${reference}
          AND user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!transaction) {
        throw new HttpError(404, "transaction_not_found", "Payment transaction not found");
      }

      const paystack = await paystackService.checkCharge(reference);
      const chargeData = (paystack.data ?? {}) as Record<string, any>;
      const chargeStatus = String(chargeData.status ?? "").toLowerCase();

      if (chargeStatus === "success") {
        const activated = await activateSubscriptionFromReference(reference, auth);
        return ok({
          ...activated,
          chargeStatus,
          message: "Payment successful",
        });
      }
      return ok({
        data: toCamel(transaction),
        paystack,
        verified: false,
        chargeStatus,
        message: paystack.message || "Charge status checked",
      });
    },
    {
      body: t.Object({ reference: t.String() }),
    },
  )
  .post(
    "/paystack/cancel",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const reference = String(body.reference ?? "").trim();
      if (!reference) {
        throw new HttpError(400, "reference_required", "Payment reference is required");
      }
      const db = getDb();
      const [transaction] = await db`
        SELECT * FROM paystack_transactions
        WHERE provider = 'paystack' AND provider_reference = ${reference}
          AND user_key_id = ${auth.userId}
          AND status = 'pending'
          AND verified_at IS NULL
        LIMIT 1
      `;
      if (!transaction) {
        throw new HttpError(404, "transaction_not_found", "Pending payment transaction not found");
      }
      await db`
        UPDATE paystack_transactions
        SET status = 'cancelled',
          metadata = COALESCE(metadata, '{}'::jsonb) || ${db.json({
        cancelledAt: new Date().toISOString(),
        cancelledBy: auth.userId,
      })}::jsonb,
          updated_at = NOW()
        WHERE id = ${transaction.id}
      `;
      return ok({
        data: toCamel(transaction),
        message: "Payment cancelled. You can try again.",
      });
    },
    {
      body: t.Object({ reference: t.String() }),
    },
  )
  .post("/paystack/webhook", async ({ request, headers, set }) => {
    const rawBody = await request.text();
    const signature = String(headers["x-paystack-signature"] ?? "");
    if (
      !signature ||
      !paystackService.verifyWebhookSignature(rawBody, signature)
    ) {
      set.status = 401;
      return fail("Invalid payment signature", "invalid_signature");
    }
    const payload = JSON.parse(rawBody) as Record<string, any>;
    const result = await processBillingWebhook(payload);
    return ok({ received: true, ...result });
  });
