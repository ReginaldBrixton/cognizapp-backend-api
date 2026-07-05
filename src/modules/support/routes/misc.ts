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

export const miscRoutes = new Elysia()
  .post(
    "/cost-estimate",
    async ({ headers, body }) => {
      await resolveAuth(headers);
      const estimate = await estimateSupportCost(body);
      return ok({ data: estimate, message: "Cost estimate ready" });
    },
    {
      body: t.Record(t.String(), t.Any()),
    },
  )
  .get("/uploadthing/status", async ({ headers }) => {
    await resolveAuth(headers);
    const health = await checkUploadThingHealth();
    return ok({
      data: health,
      message: health.healthy
        ? "UploadThing storage is reachable"
        : "UploadThing storage needs attention",
    });
  })
  .get("/notifications/status", async ({ headers }) => {
    await resolveAuth(headers);
    return ok({
      data: {
        emailConfigured: Boolean(
          env.n8nGmailSendWebhookUrl,
        ),
        gmailConfigured: Boolean(env.n8nGmailSendWebhookUrl),
        whatsappConfigured: Boolean(
          env.wahaBaseUrl && env.wahaApiKey,
        ),
        uploadthingConfigured: uploadthingConfigured(),
      },
      message: "Support integration status ready",
    });
  })
  .get("/paystack/config", () =>
    ok({
      mode: paystackService.getMode(),
      hostedCheckoutChannels: "dashboard_enabled",
      message:
        "Mobile money payments are started from the CogniZap payment dialog. Card and bank checkout remains available as a secure fallback.",
    }),
  )
  .post("/paystack/webhook", async ({ request, headers, set }) => {
    const rawBody = await request.text();
    const signature = String(headers["x-paystack-signature"] ?? "");
    if (
      !signature ||
      !paystackService.verifyWebhookSignature(rawBody, signature)
    ) {
      set.status = 401;
      return fail("Invalid Paystack signature", "invalid_signature");
    }
    const payload = JSON.parse(rawBody) as Record<string, any>;
    const reference = String(payload?.data?.reference ?? "");
    if (payload.event === "charge.success" && reference) {
      await confirmSupportPaystackPayment({ reference });
    }
    return ok({ received: true });
  })
  .get("/payment-settings", async () => {
    const db = getDb();
    const settings = await db`
      SELECT provider, account_name, account_number, currency, instructions, display_order
      FROM support_payment_settings
      WHERE is_active = true
      ORDER BY display_order ASC, created_at ASC
    `;

    return ok({
      data: settings.map(s => ({
        provider: s.provider,
        accountName: s.account_name,
        paymentTarget: s.account_number,
        currency: s.currency,
        instructions: s.instructions,
        displayOrder: s.display_order,
      }))
    });
  })

;
