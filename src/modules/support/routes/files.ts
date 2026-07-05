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
	ALLOWED_SUPPORT_UPLOAD_EXTENSIONS,
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

export const fileRoutes = new Elysia()
  .post("/files/upload", async ({ headers, request }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const form = await request.formData();
    let requestId = String(form.get("requestId") ?? "").trim() || null;
    const threadId = String(form.get("threadId") ?? "").trim() || null;
    const milestoneId = String(form.get("milestoneId") ?? form.get("milestone_id") ?? "").trim();
    const purpose = String(form.get("purpose") ?? "client_upload");
    const submissionRoundRaw = String(form.get("submissionRound") ?? form.get("submission_round") ?? "").trim();
    // Voice note metadata (optional, sent by the voice recorder)
    const voiceNoteDuration = String(form.get("duration") ?? "").trim();
    const isVoiceNote = String(form.get("isVoiceNote") ?? "").trim() === "true";
    const files = form
      .getAll("files")
      .concat(form.getAll("file"))
      .filter((file): file is File => file instanceof File);

    // Determine the submission round for milestone uploads
    let fileSubmissionRound = 1;
    if (milestoneId && submissionRoundRaw) {
      fileSubmissionRound = Math.max(1, Number(submissionRoundRaw) || 1);
    } else if (milestoneId) {
      const [ms] = await db`
        SELECT submission_round FROM request_milestones
        WHERE id = ${milestoneId}::uuid LIMIT 1
      `;
      fileSubmissionRound = Math.max(1, Number(ms?.submission_round ?? 1));
    }

    let existingFileCount = 0;
    let targetUserId = auth.userId;
    if (!requestId && threadId) {
      const [thread] = await db`
        SELECT request_id, user_key_id
        FROM support_message_threads
        WHERE id = ${threadId}::uuid
          AND request_id IS NOT NULL
          AND (${canSeeProvider(auth)} OR user_key_id = ${auth.userId})
        LIMIT 1
      `;
      if (!thread) {
        throw new HttpError(404, "thread_not_found", "Support message thread not found");
      }
      requestId = String(thread.request_id);
      targetUserId = String(thread.user_key_id ?? auth.userId);
    }
    if (requestId) {
      const [supportRequest] = await db`
        SELECT id, user_key_id,
          (
            SELECT COUNT(*)::int
            FROM support_files
            WHERE request_id = support_requests.id
              AND milestone_id IS NULL
          ) AS file_count
        FROM support_requests
        WHERE id = ${requestId}::uuid
          AND (${canSeeProvider(auth)} OR user_key_id = ${auth.userId})
        LIMIT 1
      `;
      if (!supportRequest) {
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      }
      targetUserId = String(supportRequest.user_key_id ?? auth.userId);
      existingFileCount = Number(supportRequest.file_count ?? 0);
    }

    const isMilestoneUpload = milestoneId && purpose === 'milestone_upload';
    const validationErrors = validateSupportUploads(
      files,
      isMilestoneUpload ? 0 : existingFileCount,
    );
    if (validationErrors.length) {
      throw new HttpError(
        400,
        "invalid_upload",
        "Some files could not be uploaded",
        {
          errors: validationErrors,
          allowedExtensions: Array.from(ALLOWED_SUPPORT_UPLOAD_EXTENSIONS),
          maxFiles: MAX_SUPPORT_UPLOAD_FILES,
          maxFileBytes: MAX_SUPPORT_UPLOAD_FILE_BYTES,
        },
      );
    }

    const uploaded = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePurpose = isVoiceNote ? "voice_note" : purpose;
      let row: any;
      try {
        // Try with voice note columns first
        [row] = await db`
          INSERT INTO support_files (
            request_id, milestone_id, user_key_id, file_name, file_url, file_type, file_size, content_base64, purpose, submission_round, is_voice_note, duration_seconds
          )
          VALUES (
            ${requestId}, NULLIF(${milestoneId}, '')::uuid, ${targetUserId}, ${file.name}, '', ${file.type || "application/octet-stream"},
            ${file.size}, ${buffer.toString("base64")}, ${filePurpose}, ${milestoneId ? fileSubmissionRound : 1},
            ${isVoiceNote}, ${voiceNoteDuration ? Math.round(Number(voiceNoteDuration)) || null : null}
          )
          RETURNING *
        `;
      } catch (insertErr: any) {
        // Fallback: insert without voice note columns (migration may not have run yet)
        if (insertErr?.code === "42703") {
          console.warn("[upload] Voice note columns not found, falling back to basic insert");
          [row] = await db`
            INSERT INTO support_files (
              request_id, milestone_id, user_key_id, file_name, file_url, file_type, file_size, content_base64, purpose, submission_round
            )
            VALUES (
              ${requestId}, NULLIF(${milestoneId}, '')::uuid, ${targetUserId}, ${file.name}, '', ${file.type || "application/octet-stream"},
              ${file.size}, ${buffer.toString("base64")}, ${filePurpose}, ${milestoneId ? fileSubmissionRound : 1}
            )
            RETURNING *
          `;
        } else {
          console.error("[upload:insert-error]", {
            message: insertErr?.message,
            code: insertErr?.code,
            detail: insertErr?.detail,
          });
          throw insertErr;
        }
      }
      const fileUrl = `/api/support/files/${row.id}/download`;
      const [updated] = await db`
        UPDATE support_files SET file_url = ${fileUrl} WHERE id = ${row.id} RETURNING *
      `;
      const synced = await storeSupportFileOnUploadThing(updated, file, buffer, auth, purpose);
      if (isMilestoneUpload && requestId && milestoneId) {
        await recordMilestoneFileEvent({
          requestId,
          milestoneId,
          fileId: String(synced.id ?? row.id),
          auth,
          eventType: "uploaded",
          fileName: String(synced.file_name ?? file.name),
          submissionRound: fileSubmissionRound,
          metadata: {
            purpose,
            fileType: synced.file_type ?? file.type,
            fileSize: Number(synced.file_size ?? file.size),
            submissionRound: fileSubmissionRound,
          },
        });
      }
      uploaded.push(toCamel(synced));
    }

    if (isMilestoneUpload && requestId && milestoneId) {
      const refreshedMessages = await refreshMilestoneCardMessages(requestId, milestoneId);
      const { broadcastSupportMessageUpdate } = await import("../../support-messages/realtime");
      for (const message of refreshedMessages) {
        broadcastSupportMessageUpdate(String(message.threadId), message);
      }
    }

    await invalidateSupportCache(targetUserId);
    await invalidateProviderSupportCache();
    return ok({ data: uploaded, message: "Files uploaded" });
  })
  .patch("/files/:id", async ({ headers, params, request }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const form = await request.formData();
    const replacement = form
      .getAll("files")
      .concat(form.getAll("file"))
      .find((file): file is File => file instanceof File);
    if (!replacement) {
      throw new HttpError(400, "file_required", "Choose a replacement file");
    }
    const validationErrors = validateSupportUploads([replacement], 0);
    if (validationErrors.length) {
      throw new HttpError(400, "invalid_upload", "Replacement file is not valid", {
        errors: validationErrors,
        allowedExtensions: Array.from(ALLOWED_SUPPORT_UPLOAD_EXTENSIONS),
        maxFileBytes: MAX_SUPPORT_UPLOAD_FILE_BYTES,
      });
    }

    const [existing] = await db`
      SELECT *
      FROM support_files
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!existing) throw new HttpError(404, "file_not_found", "File not found");
    assertProviderCanMutateSupportFile(auth, existing);

    const previousName = String(existing.file_name ?? "Attachment");
    const buffer = Buffer.from(await replacement.arrayBuffer());
    const fileUrl = `/api/support/files/${existing.id}/download`;
    const [updated] = await db`
      UPDATE support_files
      SET
        file_name = ${replacement.name},
        file_url = ${fileUrl},
        file_type = ${replacement.type || "application/octet-stream"},
        file_size = ${replacement.size},
        content_base64 = ${buffer.toString("base64")},
        storage_provider = 'database',
        external_file_id = NULL,
        external_file_url = NULL,
        external_folder_id = NULL,
        external_upload_status = 'stored_locally',
        external_upload_error = NULL,
        external_uploaded_at = NULL,
        previous_file_name = ${previousName},
        replaced_at = NOW(),
        replaced_by = ${auth.userId},
        updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `;
    const synced = await storeSupportFileOnUploadThing(updated, replacement, buffer, auth, String(existing.purpose ?? "provider_message_upload"));
    const publicFile = toCamel(synced);
    const changedAt = new Date().toISOString();

    await updateSupportMessageFileAttachments(String(existing.id), (item) => ({
      ...item,
      name: synced.file_name,
      label: synced.file_name,
      type: synced.file_type,
      size: Number(synced.file_size ?? 0),
      url: `/api/support/files/${existing.id}/download`,
      externalUrl: null,
      status: "edited",
      editedAt: changedAt,
      previousName,
    }));
    await createSupportFileActivityMessage(
      auth,
      String(existing.request_id),
      `Provider edited file: ${previousName} -> ${synced.file_name}`,
      {
        kind: "file_event",
        action: "edited",
        fileId: String(existing.id),
        name: synced.file_name,
        previousName,
        type: synced.file_type,
        size: Number(synced.file_size ?? 0),
        editedAt: changedAt,
      },
    );
    if (existing.milestone_id) {
      await recordMilestoneFileEvent({
        requestId: String(existing.request_id),
        milestoneId: String(existing.milestone_id),
        fileId: String(existing.id),
        auth,
        eventType: "replaced",
        fileName: String(synced.file_name ?? replacement.name),
        previousFileName: previousName,
        metadata: {
          fileType: synced.file_type,
          fileSize: Number(synced.file_size ?? 0),
        },
      });
      const refreshedMessages = await refreshMilestoneCardMessages(
        String(existing.request_id),
        String(existing.milestone_id),
      );
      const { broadcastSupportMessageUpdate } = await import("../../support-messages/realtime");
      for (const message of refreshedMessages) {
        broadcastSupportMessageUpdate(String(message.threadId), message);
      }
    }
    await invalidateSupportCache(String(existing.user_key_id ?? auth.userId));
    await invalidateProviderSupportCache();
    return ok({ data: publicFile, message: "File replaced" });
  })
  .delete("/files/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [existing] = await db`
      SELECT *
      FROM support_files
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!existing) throw new HttpError(404, "file_not_found", "File not found");
    assertProviderCanMutateSupportFile(auth, existing);

    const deletedAt = new Date().toISOString();
    const fileName = String(existing.file_name ?? "Attachment");
    const [deleted] = await db`
      UPDATE support_files
      SET
        deleted_at = NOW(),
        deleted_by = ${auth.userId},
        file_url = '',
        content_base64 = NULL,
        external_file_url = NULL,
        external_upload_status = 'stored_locally',
        updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `;
    await updateSupportMessageFileAttachments(String(existing.id), (item) => ({
      ...item,
      name: fileName,
      label: fileName,
      url: null,
      externalUrl: null,
      status: "deleted",
      deletedAt,
    }));
    await createSupportFileActivityMessage(
      auth,
      String(existing.request_id),
      `Provider deleted file: ${fileName}`,
      {
        kind: "file_event",
        action: "deleted",
        fileId: String(existing.id),
        name: fileName,
        deletedAt,
      },
    );
    if (existing.milestone_id) {
      await recordMilestoneFileEvent({
        requestId: String(existing.request_id),
        milestoneId: String(existing.milestone_id),
        fileId: String(existing.id),
        auth,
        eventType: "deleted",
        fileName,
      });
      const refreshedMessages = await refreshMilestoneCardMessages(
        String(existing.request_id),
        String(existing.milestone_id),
      );
      const { broadcastSupportMessageUpdate } = await import("../../support-messages/realtime");
      for (const message of refreshedMessages) {
        broadcastSupportMessageUpdate(String(message.threadId), message);
      }
    }
    await invalidateSupportCache(String(existing.user_key_id ?? auth.userId));
    await invalidateProviderSupportCache();
    return ok({ data: toCamel(deleted), message: "File deleted" });
  })
  .get("/files/:id/download", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const provider = canSeeProvider(auth);
    const [file] = provider
      ? await db`SELECT * FROM support_files WHERE id = ${params.id}::uuid LIMIT 1`
      : await db`
          SELECT * FROM support_files
          WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
          LIMIT 1
        `;
    if (!file) throw new HttpError(404, "file_not_found", "File not found");
    if (file.deleted_at) throw new HttpError(410, "file_deleted", "This file has been deleted");
    if (!provider) {
      if (["limited_preview", "full_protected_preview"].includes(String(file.purpose ?? ""))) {
        throw new HttpError(
          403,
          "preview_endpoint_required",
          "Protected previews are available only through the request preview viewer",
        );
      }
      if (String(file.purpose ?? "") === "provider_preview_page") {
        throw new HttpError(
          403,
          "preview_endpoint_required",
          "Preview pages are available only through the request preview viewer",
        );
      }
      const [delivery] = await db`
        SELECT d.*, r.payment_status, r.delivery_status
        FROM support_deliveries d
        INNER JOIN support_requests r ON r.id = d.request_id
        WHERE d.file_id = ${params.id}::uuid
          AND r.user_key_id = ${auth.userId}
        ORDER BY d.created_at DESC
        LIMIT 1
      `;
      if (delivery) {
        assertSupportDeliveryDownloadAllowed(delivery);
      } else if (["admin_clean_pdf", "admin_clean_docx"].includes(String(file.purpose ?? ""))) {
        throw new HttpError(402, "PAYMENT_REQUIRED", DELIVERY_PAYMENT_REQUIRED_MESSAGE);
      } else if (
        ["provider_message_upload", "milestone_upload"].includes(
          String(file.purpose ?? ""),
        )
      ) {
        const [supportRequest] = await db`
          SELECT payment_status, payment_policy
          FROM support_requests
          WHERE id = ${file.request_id}::uuid
            AND user_key_id = ${auth.userId}
          LIMIT 1
        `;
        if (
          !supportRequest ||
          !canAccessFullProtectedPreview(
            supportRequest.payment_status,
            supportRequest.payment_policy,
          )
        ) {
          throw new HttpError(
            402,
            "PAYMENT_REQUIRED",
            "Verify the required request payment to view provider files.",
          );
        }
      }
    }
    if (file.external_file_url) {
      return Response.redirect(String(file.external_file_url), 302);
    }
    const bytes = Buffer.from(file.content_base64 ?? "", "base64");
    return new Response(bytes, {
      headers: {
        "Content-Type": file.file_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${String(file.file_name).replace(/"/g, "")}"`,
      },
    });
  })

;
