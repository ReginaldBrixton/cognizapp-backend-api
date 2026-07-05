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

export const previewRoutes = new Elysia()
  .get("/client/requests/:id/previews", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const previewPages = await getDb()`
      SELECT p.*, f.file_name, f.file_type, f.file_size
      FROM support_preview_pages p
      INNER JOIN support_requests r ON r.id = p.request_id
      INNER JOIN support_files f ON f.id = p.file_id
      WHERE p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
        AND p.generation_status = 'ready'
      ORDER BY p.page_number ASC
    `;
    if (previewPages.length > 0) {
      return ok({ data: [redactImagePreviewPackage(previewPages)] });
    }
    const rows = await getDb()`
      SELECT a.*, r.payment_status, r.payment_policy,
        CASE
          WHEN a.asset_type = 'limited_preview' THEN TRUE
          WHEN r.payment_status = 'paid' THEN TRUE
          WHEN COALESCE(r.payment_policy->>'previewUnlock', 'deposit') <> 'full_payment'
            AND r.payment_status IN ('deposit_paid', 'final_payment_required', 'final_payment_pending_verification') THEN TRUE
          ELSE FALSE
        END AS can_view
      FROM support_preview_assets a
      INNER JOIN support_requests r ON r.id = a.request_id
      WHERE a.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      ORDER BY CASE a.asset_type WHEN 'limited_preview' THEN 1 ELSE 2 END
    `;
    return ok({ data: rows.map(redactPreviewAsset) });
  })
  .get("/client/requests/:id/preview-pages/:pageId/content", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const [page] = await getDb()`
      SELECT p.*, f.file_name, f.file_type, f.content_base64
      FROM support_preview_pages p
      INNER JOIN support_requests r ON r.id = p.request_id
      INNER JOIN support_files f ON f.id = p.file_id
      WHERE p.id = ${params.pageId}::uuid
        AND p.request_id = ${params.id}::uuid
        AND p.generation_status = 'ready'
        AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!page) throw new HttpError(404, "preview_page_not_found", "Preview page not found");
    const { bytes, mime } = decodePreviewImageContent(page);
    return new Response(bytes, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="${String(page.file_name).replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  })
  .get("/client/requests/:id/previews/:previewId/content", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const [asset] = await getDb()`
      SELECT a.*, f.file_name, f.content_base64,
        r.payment_status, r.payment_policy
      FROM support_preview_assets a
      INNER JOIN support_requests r ON r.id = a.request_id
      INNER JOIN support_files f ON f.id = a.file_id
      WHERE a.id = ${params.previewId}::uuid
        AND a.request_id = ${params.id}::uuid
        AND a.generation_status = 'ready'
        AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!asset) throw new HttpError(404, "preview_not_found", "Protected preview not found");
    assertPreviewAccess(asset);
    const bytes = Buffer.from(String(asset.content_base64 ?? ""), "base64");
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${String(asset.file_name).replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      },
    });
  })

;
