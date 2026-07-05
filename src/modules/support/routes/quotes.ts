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

export const quoteRoutes = new Elysia()
  .get("/client/requests/:id/quotes", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const rows = await getDb()`
      SELECT q.*
      FROM support_quotes q
      INNER JOIN support_requests r ON r.id = q.request_id
      WHERE q.request_id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
      ORDER BY q.created_at DESC
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .get("/client/quotes/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const [quote] = await getDb()`
      SELECT q.*
      FROM support_quotes q
      INNER JOIN support_requests r ON r.id = q.request_id
      WHERE q.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!quote) throw new HttpError(404, "quote_not_found", "Quote not found");
    return ok({ data: toCamel(quote) });
  })
  .post("/client/quotes/:id/accept", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [quote] = await db`
      SELECT q.*, r.user_key_id, r.payment_status AS request_payment_status, r.payment_amount, r.deadline_at
      FROM support_quotes q
      INNER JOIN support_requests r ON r.id = q.request_id
      WHERE q.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!quote) throw new HttpError(404, "quote_not_found", "Quote not found");

    const [order] = await db`
      INSERT INTO support_orders (
        request_id, quote_id, client_key_id, provider_key_id, status, payment_status,
        amount_paid, total_amount, currency, due_date, max_revisions, scope
      )
      VALUES (
        ${quote.request_id}, ${quote.id}, ${auth.userId}, ${quote.provider_key_id}, 'pending',
        ${quote.request_payment_status === "paid" ? "paid" : "pending"},
        ${quote.request_payment_status === "paid" ? (quote.payment_amount ?? quote.total_amount) : 0},
        ${quote.total_amount}, ${quote.currency}, ${quote.deadline_at},
        ${(quote.revision_policy as any)?.maxRevisions ?? (quote.revision_policy as any)?.max_revisions ?? 1},
        ${db.json({ lineItems: quote.line_items, deliverables: quote.deliverables, terms: quote.terms })}
      )
      RETURNING *
    `;
    await db`UPDATE support_quotes SET status = 'accepted', updated_at = NOW() WHERE id = ${quote.id}`;
    await db`UPDATE support_quotes SET status = 'rejected', updated_at = NOW() WHERE request_id = ${quote.request_id} AND id <> ${quote.id} AND status = 'sent'`;
    await db`UPDATE support_requests SET status = 'accepted', updated_at = NOW() WHERE id = ${quote.request_id}`;

    return ok({
      data: toCamel(order),
      message: "Quote accepted and order created",
    });
  })
  .post("/client/quotes/:id/decline", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const [quote] = await getDb()`
      UPDATE support_quotes q
      SET status = 'rejected', updated_at = NOW()
      FROM support_requests r
      WHERE q.id = ${params.id}::uuid AND r.id = q.request_id AND r.user_key_id = ${auth.userId}
      RETURNING q.*
    `;
    if (!quote) throw new HttpError(404, "quote_not_found", "Quote not found");
    return ok({ data: toCamel(quote), message: "Quote declined" });
  })

;
