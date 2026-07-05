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

export const codesRoutes = new Elysia()
  .post(
    "/client/codes/validate",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const discountCode = String(body.discountCode ?? "").trim().toUpperCase();
      const referralCode = String(body.referralCode ?? "").trim().toUpperCase();
      const amount = roundMoney(Number(body.amount ?? 0));
      const serviceTags = Array.isArray(body.serviceTags) ? body.serviceTags.map(String) : [];

      let discount: Record<string, unknown> | null = null;
      let discountError: string | null = null;
      if (discountCode) {
        const [row] = await db`
          SELECT dc.*,
            (
              SELECT COUNT(*)::int
              FROM support_discount_redemptions dr
              INNER JOIN support_requests sr ON sr.id = dr.request_id
              WHERE dr.discount_code_id = dc.id
                AND dr.status = 'redeemed'
                AND sr.submitted_at IS NOT NULL
            ) AS effective_redemption_count
          FROM support_discount_codes dc
          WHERE upper(dc.code) = ${discountCode}
          LIMIT 1
        `;
        if (!row) {
          discountError = "Invalid discount code.";
        } else if (String(row.status) !== "active") {
          discountError = "This discount code is not active.";
        } else if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
          discountError = "This discount code has expired.";
        } else if (Number(row.effective_redemption_count ?? 0) >= Number(row.max_redemptions ?? 1)) {
          discountError = "This discount code has already been used.";
        } else if (Number(row.minimum_amount ?? 0) > 0 && amount < Number(row.minimum_amount ?? 0)) {
          discountError = "This request does not meet the minimum amount for that discount code.";
        } else if (
          Array.isArray(row.eligible_service_tags) &&
          row.eligible_service_tags.length > 0 &&
          !serviceTags.some((tag) => row.eligible_service_tags.includes(tag))
        ) {
          discountError = "This discount code does not apply to the selected service.";
        } else {
          const discountPercent = Number(row.discount_percent ?? 0);
          const discountAmount = roundMoney(amount * (discountPercent / 100));
          discount = {
            ...toCamel(row),
            valid: true,
            discountAmount,
            finalAmount: roundMoney(Math.max(amount - discountAmount, 0)),
          };
        }
      }

      let referral: Record<string, unknown> | null = null;
      let referralError: string | null = null;
      if (referralCode) {
        const [row] = await db`
          SELECT sc.user_key_id, sc.email, sc.full_name, sc.referral_code
          FROM support_clients sc
          WHERE upper(sc.referral_code) = ${referralCode}
            AND sc.user_key_id != ${auth.userId}
          UNION ALL
          SELECT u.id::text AS user_key_id, u.email, COALESCE(u.full_name, u.display_name, u.email) AS full_name, u.referral_code
          FROM auth.users u
          WHERE upper(u.referral_code) = ${referralCode}
            AND u.id::text != ${auth.userId}
          LIMIT 1
        `;
        if (!row) {
          referralError = "Referral code was not found.";
        } else {
          referral = { ...toCamel(row), valid: true, rewardPercent: 10 };
        }
      }

      const discountAmount = Number(discount?.discountAmount ?? 0);
      return ok({
        data: {
          discount,
          discountError,
          referral,
          referralError,
          originalAmount: amount,
          finalAmount: roundMoney(Math.max(amount - discountAmount, 0)),
        },
      });
    },
    {
      body: t.Object({
        discountCode: t.Optional(t.String()),
        referralCode: t.Optional(t.String()),
        amount: t.Number(),
        serviceTags: t.Optional(t.Array(t.String())),
      }),
    },
  )

;
