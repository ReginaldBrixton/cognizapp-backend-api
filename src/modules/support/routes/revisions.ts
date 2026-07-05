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

export const revisionRoutes = new Elysia()
  .post(
    "/client/requests/:id/revisions",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const milestoneId = String(body.milestoneId ?? body.milestone_id ?? "").trim();
      const reason = String(body.reason ?? "Other").trim().slice(0, 120) || "Other";

      const [supportRequest] = await db`
        SELECT id, payment_status, payment_policy, revisions_allowed, revisions_used
        FROM support_requests
        WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!supportRequest) {
        console.error('[revision:request] Support request not found', {
          requestId: params.id,
          userId: auth.userId
        });
        throw new HttpError(404, "request_not_found", "Support request not found");
      }
      const [previewPageState] = await db`
        SELECT COUNT(*)::int AS page_count
        FROM support_preview_pages
        WHERE request_id = ${params.id}::uuid
          AND generation_status = 'ready'
      `;
      const canRequestFromImagePreview = Number(previewPageState?.page_count ?? 0) > 0;
      if (
        !canRequestFromImagePreview &&
        !canAccessFullProtectedPreview(supportRequest.payment_status, supportRequest.payment_policy)
      ) {
        throw new HttpError(
          402,
          "REVISION_PAYMENT_REQUIRED",
          "Preview pages are not ready yet. Complete the required payment before requesting revisions against provider files.",
        );
      }
      if (Number(supportRequest.revisions_used ?? 0) >= Number(supportRequest.revisions_allowed ?? 2)) {
        throw new HttpError(
          409,
          "REVISION_LIMIT_REACHED",
          "The two included revision requests have been used. Contact the provider for approval.",
        );
      }

      // Validate milestone if provided
      if (milestoneId) {
        const [milestone] = await db`
          SELECT id, status, submission_round FROM request_milestones
          WHERE id = ${milestoneId}::uuid AND request_id = ${params.id}::uuid
          LIMIT 1
        `;
        if (!milestone) {
          console.error('[revision:request] Milestone not found', {
            milestoneId,
            requestId: params.id
          });
          throw new HttpError(404, "milestone_not_found", "Milestone not found");
        }
      }

      const scopeStatus = body.isNewProject
        ? "new_project_detected"
        : "admin_review_required";

      // Get the current submission round for the milestone
      let revisionRound = 1;
      if (milestoneId) {
        const [ms] = await db`
          SELECT submission_round FROM request_milestones
          WHERE id = ${milestoneId}::uuid LIMIT 1
        `;
        revisionRound = Number(ms?.submission_round ?? 1);
      }

      const [revision] = await db`
        INSERT INTO support_revisions (
          request_id, milestone_id, user_key_id, reason, revision_message, revision_scope_status, status, submission_round
        )
        VALUES (
          ${params.id}::uuid,
          NULLIF(${milestoneId}, '')::uuid,
          ${auth.userId},
          ${reason},
          ${body.message},
          ${scopeStatus},
          'submitted',
          ${revisionRound}
        )
        RETURNING *
      `;
      const thread = await ensureSupportMessageThread(params.id, auth.userId);
      if (thread) {
        const revisionAttachment = {
          kind: "revision_request",
          revisionId: revision.id,
          milestoneId: milestoneId || null,
          reason,
          message: body.message,
          status: revision.status,
          scopeStatus,
          createdAt: revision.created_at,
        };
        const [message] = await db`
          INSERT INTO support_messages (
            thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by
          )
          VALUES (
            ${thread.id}, ${auth.userId}, ${auth.email}, 'client',
            ${`Correction requested: ${reason}\n\n${String(body.message ?? "").trim()}`},
            ${db.json([revisionAttachment] as any)}, ARRAY[${auth.userId}]::TEXT[]
          )
          RETURNING *
        `;
        await db`
          UPDATE support_message_threads
          SET last_message_at = ${message.created_at}, updated_at = NOW()
          WHERE id = ${thread.id}
        `;
        const { broadcastSupportMessage } = await import("../../support-messages/realtime");
        broadcastSupportMessage(String(thread.id), toCamel(message));
      }
      if (milestoneId) {
        const [updatedMilestone] = await db`
          UPDATE request_milestones
          SET status = 'revision_requested',
            revision_count = revision_count + 1,
            user_feedback = ${body.message},
            updated_at = NOW()
          WHERE id = ${milestoneId}::uuid
            AND request_id = ${params.id}::uuid
          RETURNING *
        `;
        if (updatedMilestone) {
          await recordMilestoneFileEvent({
            requestId: params.id,
            milestoneId: String(updatedMilestone.id),
            auth,
            eventType: "revision_requested",
            submissionRound: revisionRound,
            metadata: { revisionId: revision.id, reason, scopeStatus, submissionRound: revisionRound },
          });
          const refreshedMessages = await refreshMilestoneCardMessages(params.id, String(updatedMilestone.id));
          if (refreshedMessages.length > 0) {
            const { broadcastSupportMessageUpdate } = await import("../../support-messages/realtime");
            for (const message of refreshedMessages) {
              broadcastSupportMessageUpdate(String(message.threadId), message);
            }
          }
        }
      }
      await db`
      UPDATE support_requests
      SET status = 'revision_requested',
        delivery_status = 'revision_requested',
        revisions_used = revisions_used + 1,
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
    `;
      await addSupportEvent(
        params.id,
        auth,
        "revision.requested",
        "Revision requested",
        {
          revisionId: revision.id,
          milestoneId: milestoneId || null,
          reason,
          scopeStatus,
        },
      );
      await invalidateSupportCache(auth.userId);
      await invalidateProviderSupportCache();
      return ok({
        data: toCamel(revision),
        message: "Revision request submitted",
      });
    },
    {
      body: t.Object({
        message: t.String(),
        reason: t.Optional(t.String()),
        milestoneId: t.Optional(t.String()),
        milestone_id: t.Optional(t.String()),
        isNewProject: t.Optional(t.Boolean()),
      }),
    },
  )

;
