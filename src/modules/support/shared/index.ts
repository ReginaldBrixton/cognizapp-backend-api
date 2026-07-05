/**
 * Barrel re-export for all shared support helpers.
 *
 * This file preserves backward compatibility: existing imports from
 * `"./shared"` or `"../support/shared"` continue to work after the split
 * into focused sub-modules.
 *
 * When adding new shared helpers, place them in the appropriate sub-module
 * and re-export here.
 */

export { requestBody } from "./clients";
export { toCamel } from "./clients";
export { cleanSupportWhatsAppNumber } from "./clients";
export { assertSupportWhatsAppNumber } from "./clients";
export { ensureClient } from "./clients";
export { generateTaskId } from "./clients";
export { canSeeProvider } from "./clients";
export { requirePermission } from "./clients";

export { rememberSupportJson } from "./cache";
export { invalidateSupportCache } from "./cache";
export { invalidateProviderSupportCache } from "./cache";
export { PROVIDER_DASHBOARD_CACHE_SECONDS } from "./cache";
export { supportMemoryCache } from "./cache";

export { addSupportEvent } from "./events";

export { ensureSupportMessageThread } from "./threads";
export { completeSupportMessageThreads } from "./threads";

export { sendSupportEmail } from "./notifications";
export { sendSupportWhatsApp } from "./notifications";
export { createSupportNotification } from "./notifications";

export { verifySupportWorkspaceAccess } from "./workspace";
export { ensureSupportRequestWorkspace } from "./workspace";
export { ensureSupportWorkspaceLinks } from "./workspace";

export { getMilestoneFiles } from "./milestones";
export { recordMilestoneFileEvent } from "./milestones";
export { buildMilestoneCardAttachment } from "./milestones";
export { refreshMilestoneCardMessages } from "./milestones";
export { getMilestoneHistory } from "./milestones";
export { getMilestoneSubmissionRound } from "./milestones";
export { incrementMilestoneSubmissionRound } from "./milestones";

export { ensureRequestStorageReady } from "./files";
export { storeSupportFileOnUploadThing } from "./files";

export { roundMoney } from "./payments";
export { calculatePaymentAmount } from "./payments";
export { buildPaymentSchedule } from "./payments";
export { assertClientRequestEditable } from "./payments";
export { buildDraftPayload } from "./payments";
export { paymentStatusForSubmittedPayment } from "./payments";
export { paymentStatusForVerifiedPayment } from "./payments";
export { paymentAmountForType } from "./payments";
export { refundEligibilityForRequest } from "./payments";

export { accrueReferralReward } from "./referrals";

export { confirmSupportPaystackPayment } from "./paystack";
