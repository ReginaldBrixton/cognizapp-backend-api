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

export const deliveryRoutes = new Elysia()
  .get("/client/requests/:id/deliveries", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const rows = await getDb()`
      SELECT d.*, f.file_name, f.file_type, f.file_size, f.file_url,
        f.storage_provider, f.external_file_id, f.external_file_url,
        f.external_folder_id, f.external_upload_status, f.external_uploaded_at,
        r.payment_status, r.delivery_status
      FROM support_deliveries d
      INNER JOIN support_requests r ON r.id = d.request_id
      INNER JOIN support_files f ON f.id = d.file_id
      WHERE d.request_id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
        AND NOT (COALESCE(d.metadata, '{}'::jsonb) ? 'supersededAt')
      ORDER BY d.created_at DESC
    `;
    return ok({ data: rows.map(redactClientDelivery) });
  })
  .get(
    "/client/requests/:id/download",
    async ({ headers, params, query }) => {
      const auth = await resolveAuth(headers);
      const deliveryId = String(query.deliveryId ?? "").trim();
      const [delivery] = await getDb()`
      SELECT d.*, f.file_name, f.file_type, f.content_base64, f.external_file_id, f.external_file_url,
        r.payment_status, r.delivery_status
      FROM support_deliveries d
      INNER JOIN support_requests r ON r.id = d.request_id
      INNER JOIN support_files f ON f.id = d.file_id
      WHERE d.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
        AND (${deliveryId || null}::uuid IS NULL OR d.id = ${deliveryId || null}::uuid)
      ORDER BY d.created_at DESC
      LIMIT 1
    `;
      if (!delivery)
        throw new HttpError(404, "delivery_not_found", "Delivery not found");
      const isPreviewDelivery = isPreviewSupportDelivery(delivery);
      assertSupportDeliveryDownloadAllowed(delivery);
      await getDb()`UPDATE support_deliveries SET downloaded_at = COALESCE(downloaded_at, NOW()), updated_at = NOW() WHERE id = ${delivery.id}`;
      if (!isPreviewDelivery) {
        await getDb()`UPDATE support_requests SET delivery_status = 'downloaded', updated_at = NOW() WHERE id = ${params.id}::uuid`;
      }
      await addSupportEvent(
        params.id,
        auth,
        isPreviewDelivery ? "delivery.preview_downloaded" : "delivery.downloaded",
        isPreviewDelivery ? "Preview work downloaded" : "Completed work downloaded",
        { deliveryId: delivery.id, deliveryType: delivery.delivery_type ?? "final" },
      );
      if (delivery.external_file_url) {
        return Response.redirect(String(delivery.external_file_url), 302);
      }
      const bytes = Buffer.from(delivery.content_base64 ?? "", "base64");
      return new Response(bytes, {
        headers: {
          "Content-Type": delivery.file_type || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${String(delivery.file_name).replace(/"/g, "")}"`,
        },
      });
    },
    {
      query: t.Object({ deliveryId: t.Optional(t.String()) }),
    },
  )

;
