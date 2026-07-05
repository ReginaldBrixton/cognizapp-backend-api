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

export const milestoneRoutes = new Elysia()
  .get("/client/requests/:id/milestones", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [request] = await db`
      SELECT id
      FROM support_requests
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");

    const [table] = await db`SELECT to_regclass('app.request_milestones') AS regclass`;
    if (!table?.regclass) return ok({ data: [] });

    const rows = await db`
      SELECT m.*,
        COALESCE((
          SELECT COUNT(*)::int
          FROM support_files f
          WHERE f.milestone_id = m.id
        ), 0) AS file_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM support_revisions rv
          WHERE rv.milestone_id = m.id
        ), 0) AS revision_request_count,
        latest_revision.reason AS latest_revision_reason,
        latest_revision.revision_message AS latest_revision_message,
        latest_revision.status AS latest_revision_status,
        latest_revision.created_at AS latest_revision_at
      FROM request_milestones m
      LEFT JOIN LATERAL (
        SELECT rv.reason, rv.revision_message, rv.status, rv.created_at
        FROM support_revisions rv
        WHERE rv.milestone_id = m.id
        ORDER BY rv.created_at DESC
        LIMIT 1
      ) latest_revision ON TRUE
      WHERE m.request_id = ${params.id}::uuid
      ORDER BY COALESCE(m.due_at, m.created_at), m.created_at
    `;
    const data = await Promise.all(rows.map(async (row) => ({
      ...toCamel(row),
      files: await getMilestoneFiles(String(row.id)),
    })));
    return ok({ data });
  })
  .post("/client/requests/:id/milestones/:milestoneId/accept", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();

    // Debug: check if milestone exists first
    const [existingMilestone] = await db`
      SELECT m.*, r.user_key_id
      FROM request_milestones m
      INNER JOIN support_requests r ON r.id = m.request_id
      WHERE m.id = ${params.milestoneId}::uuid
        AND r.id = ${params.id}::uuid
      LIMIT 1
    `;

    if (!existingMilestone) {
      console.error('[milestone:accept] Milestone not found', {
        milestoneId: params.milestoneId,
        requestId: params.id,
        userId: auth.userId
      });
      throw new HttpError(404, "milestone_not_found", "Milestone not found");
    }

    if (existingMilestone.user_key_id !== auth.userId) {
      console.error('[milestone:accept] User not authorized', {
        milestoneOwnerId: existingMilestone.user_key_id,
        userId: auth.userId
      });
      throw new HttpError(403, "forbidden", "You don't have permission to accept this milestone");
    }

    if (!['submitted', 'revision_requested', 'active'].includes(existingMilestone.status)) {
      console.error('[milestone:accept] Invalid status', {
        status: existingMilestone.status,
        milestoneId: params.milestoneId
      });
      throw new HttpError(400, "invalid_status", `Milestone cannot be accepted from status: ${existingMilestone.status}`);
    }

    const [milestone] = await db`
      UPDATE request_milestones
      SET status = 'approved',
        approved_at = COALESCE(approved_at, NOW()),
        updated_at = NOW()
      WHERE id = ${params.milestoneId}::uuid
      RETURNING *
    `;

    if (!milestone) throw new HttpError(500, "update_failed", "Failed to update milestone");

    await addSupportEvent(params.id, auth, "milestone.approved", "Milestone approved", {
      milestoneId: milestone.id,
      title: milestone.title,
    });
    await recordMilestoneFileEvent({
      requestId: params.id,
      milestoneId: String(milestone.id),
      auth,
      eventType: "accepted",
      metadata: { title: milestone.title },
    });
    const refreshedMessages = await refreshMilestoneCardMessages(params.id, String(milestone.id));
    if (refreshedMessages.length > 0) {
      const { broadcastSupportMessageUpdate } = await import("../../support-messages/realtime");
      for (const message of refreshedMessages) {
        broadcastSupportMessageUpdate(String(message.threadId), message);
      }
    }
    await invalidateSupportCache(auth.userId);
    await invalidateProviderSupportCache();
    return ok({ data: toCamel(milestone), message: "Milestone accepted" });
  })
  .get("/client/requests/:id/milestones/:milestoneId", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [row] = await db`
      SELECT m.*,
        COALESCE((
          SELECT COUNT(*)::int
          FROM support_files f
          WHERE f.milestone_id = m.id
        ), 0) AS file_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM support_revisions rv
          WHERE rv.milestone_id = m.id
        ), 0) AS revision_request_count,
        latest_revision.reason AS latest_revision_reason,
        latest_revision.revision_message AS latest_revision_message,
        latest_revision.status AS latest_revision_status,
        latest_revision.created_at AS latest_revision_at
      FROM request_milestones m
      INNER JOIN support_requests r ON r.id = m.request_id
      LEFT JOIN LATERAL (
        SELECT rv.reason, rv.revision_message, rv.status, rv.created_at
        FROM support_revisions rv
        WHERE rv.milestone_id = m.id
        ORDER BY rv.created_at DESC
        LIMIT 1
      ) latest_revision ON TRUE
      WHERE m.id = ${params.milestoneId}::uuid
        AND m.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!row) throw new HttpError(404, "milestone_not_found", "Milestone not found");
    const data = {
      ...toCamel(row),
      files: await getMilestoneFiles(String(row.id)),
    };
    return ok({ data });
  })
  .get("/client/requests/:id/milestones/:milestoneId/history", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [row] = await db`
      SELECT m.id
      FROM request_milestones m
      INNER JOIN support_requests r ON r.id = m.request_id
      WHERE m.id = ${params.milestoneId}::uuid
        AND m.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!row) throw new HttpError(404, "milestone_not_found", "Milestone not found");
    const { getMilestoneHistory } = await import("../shared");
    const history = await getMilestoneHistory(String(params.milestoneId));
    return ok({ data: history });
  })

;
