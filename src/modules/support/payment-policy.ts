import { getDb } from "../../lib/db";

export type SupportRiskTier = "first_time" | "trusted" | "high_risk";

export type SupportPaymentPolicy = {
  version: 1;
  riskTier: SupportRiskTier;
  serviceCategory: string;
  shortWork: boolean;
  urgent: boolean;
  depositPercent: number;
  previewUnlock: "deposit" | "full_payment";
  workStartRequirement: "none" | "deposit" | "full_payment";
  editableDocumentRequired: boolean;
  revisionsAllowed: number;
  reason: string;
  override?: {
    reason: string;
    actorId: string;
    overriddenAt: string;
  };
};

const TIER_DEPOSIT: Record<SupportRiskTier, number> = {
  first_time: 40,
  trusted: 25,
  high_risk: 60,
};

function serviceCategoryOf(request: Record<string, any>) {
  const explicit = String(request.service_category ?? "").trim();
  if (explicit) return explicit;
  const tags = Array.isArray(request.service_tags) ? request.service_tags : [];
  return String(tags[0] ?? "other");
}

export async function classifySupportRisk(
  userKeyId: string,
  clientId?: string | null,
): Promise<SupportRiskTier> {
  const db = getDb();
  if (clientId) {
    const [client] = await db`
      SELECT risk_tier_override
      FROM support_clients
      WHERE id = ${clientId}::uuid
      LIMIT 1
    `;
    if (["first_time", "trusted", "high_risk"].includes(String(client?.risk_tier_override ?? ""))) {
      return client.risk_tier_override as SupportRiskTier;
    }
  }

  const [history] = await db`
    SELECT
      COUNT(*) FILTER (
        WHERE payment_status = 'paid' AND status IN ('completed', 'closed')
      )::int AS completed_paid,
      COUNT(*) FILTER (
        WHERE
          payment_status = 'failed'
          OR (
            status = 'cancelled'
            AND scope_locked_at IS NOT NULL
            AND payment_status NOT IN ('paid', 'refunded')
          )
      )::int AS defaults
    FROM support_requests
    WHERE user_key_id = ${userKeyId}
      AND created_at >= NOW() - INTERVAL '12 months'
  `;

  if (Number(history?.defaults ?? 0) >= 1) return "high_risk";
  if (Number(history?.completed_paid ?? 0) >= 1) return "trusted";
  return "first_time";
}

export function buildSupportPaymentPolicy(
  request: Record<string, any>,
  riskTier: SupportRiskTier,
): SupportPaymentPolicy {
  const serviceCategory = serviceCategoryOf(request);
  const pages = Number(request.pages ?? 0);
  const words = Number(request.word_count ?? request.wordCount ?? 0);
  const shortWork = (pages > 0 && pages <= 5) || (words > 0 && words <= 1500);
  const urgent =
    String(request.priority ?? "").toLowerCase() === "urgent" ||
    Boolean(request.deadline_at && new Date(request.deadline_at).getTime() - Date.now() <= 48 * 60 * 60 * 1000);

  if (shortWork) {
    return {
      version: 1,
      riskTier,
      serviceCategory,
      shortWork,
      urgent,
      depositPercent: 100,
      previewUnlock: "full_payment",
      workStartRequirement: urgent ? "full_payment" : "none",
      editableDocumentRequired: true,
      revisionsAllowed: 2,
      reason: "Short work requires full payment before substantial preview access.",
    };
  }

  const depositPercent = TIER_DEPOSIT[riskTier];
  return {
    version: 1,
    riskTier,
    serviceCategory,
    shortWork,
    urgent,
    depositPercent,
    previewUnlock: "deposit",
    workStartRequirement: urgent ? "deposit" : "none",
    editableDocumentRequired: true,
    revisionsAllowed: 2,
    reason: urgent
      ? `Urgent ${serviceCategory} work requires the ${depositPercent}% tier payment before work starts.`
      : `${serviceCategory} uses the ${riskTier.replace("_", " ")} user payment tier.`,
  };
}

export function canAccessFullProtectedPreview(
  paymentStatus: unknown,
  policy: Record<string, any> | null | undefined,
) {
  const status = String(paymentStatus ?? "");
  if (status === "paid") return true;
  return (
    policy?.previewUnlock !== "full_payment" &&
    ["deposit_paid", "final_payment_required", "final_payment_pending_verification"].includes(status)
  );
}

export function paymentProgressStatus(input: {
  totalAmount: number;
  depositAmount: number;
  verifiedAmount: number;
}) {
  const totalAmount = Math.max(0, input.totalAmount);
  const depositAmount = Math.max(0, Math.min(input.depositAmount, totalAmount));
  const verifiedAmount = Math.max(0, input.verifiedAmount);

  if (totalAmount === 0 || verifiedAmount + 0.005 >= totalAmount) return "paid";
  if (depositAmount > 0 && verifiedAmount + 0.005 >= depositAmount) return "deposit_paid";
  return "unpaid";
}
