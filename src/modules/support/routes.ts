import { Elysia, t } from "elysia";

import { env } from "../../config/env";
import { cache } from "../../lib/cache";
import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import {
  generateSupportAiResponse,
  getPublicSupportAiModelName,
  getSupportAiModel,
  hashSupportPrompt,
} from "../../lib/gemini";
import { fail, ok } from "../../lib/http";
import { paystackService } from "../../lib/paystack";
import { normalizePublicCallbackUrl } from "../../lib/site-url";
import {
  checkUploadThingHealth,
  uploadthingConfigured,
} from "../../lib/uploadthing";
import { resolveAuth, type AuthContext } from "../auth/middleware";
import { estimateSupportCost, estimateSupportCostLocal } from "./cost-estimation";
import {
  buildSupportPaymentPolicy,
  canAccessFullProtectedPreview,
  classifySupportRisk,
} from "./payment-policy";
import {
  assertPreviewAccess,
  redactImagePreviewPackage,
  redactPreviewAsset,
} from "./preview-service";
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
} from "./shared";

const MAX_SUPPORT_UPLOAD_FILES = 10;
const MAX_SUPPORT_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_SUPPORT_TIMEZONE = "Africa/Accra";
const MOBILE_MONEY_ATTEMPT_TTL_SECONDS = 5 * 60;
const DELIVERY_PAYMENT_REQUIRED_MESSAGE = "Final payment must be verified before this delivery can be downloaded.";
const ALLOWED_SUPPORT_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/zip",
  "application/x-zip-compressed",
  // Audio (voice notes)
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "audio/mpeg",
  "audio/x-m4a",
  "audio/aac",
]);

function isPreviewSupportDelivery(delivery: Record<string, any>) {
  return (
    ["preview", "partial"].includes(String(delivery.delivery_type ?? "")) ||
    delivery.preview_allowed === true
  );
}

function isSupersededSupportDelivery(delivery: Record<string, any>) {
  const metadata = delivery.metadata;
  if (!metadata) return false;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as Record<string, any>;
      return Boolean(parsed.supersededAt || parsed.superseded_at);
    } catch {
      return false;
    }
  }
  return Boolean(metadata.supersededAt || metadata.superseded_at);
}

function canDownloadSupportDelivery(delivery: Record<string, any>) {
  if (isSupersededSupportDelivery(delivery)) return false;
  if (isPreviewSupportDelivery(delivery)) return true;
  const deliveryStatus = String(delivery.delivery_status ?? "");
  return (
    String(delivery.payment_status ?? "") === "paid" &&
    ["download_unlocked", "downloaded"].includes(deliveryStatus) &&
    delivery.is_locked !== true
  );
}

function assertSupportDeliveryDownloadAllowed(delivery: Record<string, any>) {
  if (canDownloadSupportDelivery(delivery)) return;
  throw new HttpError(402, "PAYMENT_REQUIRED", DELIVERY_PAYMENT_REQUIRED_MESSAGE);
}

function redactClientDelivery(row: Record<string, any>) {
  const canDownload = canDownloadSupportDelivery(row);
  const delivery = toCamel(row) as Record<string, any>;
  delivery.canDownload = canDownload;
  delivery.canPreview = isPreviewSupportDelivery(row);
  delivery.downloadUrl = canDownload
    ? `/api/support/client/requests/${row.request_id}/download?deliveryId=${row.id}`
    : null;

  if (!canDownload) {
    delivery.fileUrl = null;
    delivery.externalFileId = null;
    delivery.externalFileUrl = null;
    delivery.externalFolderId = null;
    delivery.externalUploadStatus = null;
    delivery.externalUploadedAt = null;
  }

  return delivery;
}

function decodePreviewImageContent(row: Record<string, any>) {
  const raw = String(row.content_base64 ?? "").trim();
  if (!raw) {
    throw new HttpError(422, "preview_page_content_missing", "Preview page image is not available yet");
  }

  const bytes = Buffer.from(raw, "base64");
  if (bytes.length < 8) {
    throw new HttpError(422, "preview_page_content_invalid", "Preview page image is incomplete");
  }

  const fileType = String(row.file_type || "image/png").toLowerCase();
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new HttpError(422, "preview_page_content_invalid", "Preview page content is not an image");
  }

  const mime = isPng ? "image/png" : isJpeg ? "image/jpeg" : isWebp ? "image/webp" : fileType;
  return { bytes, mime };
}
const ALLOWED_SUPPORT_UPLOAD_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "zip",
  // Audio (voice notes)
  "webm",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "aac",
]);

function isRequestBodyParseError(error: unknown) {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /json|parse|body/i.test(message) && /unexpected|invalid|malformed|syntax/i.test(message);
}

function extensionFor(fileName: string) {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return extension === fileName.toLowerCase() ? "" : extension;
}

function validateSupportUploads(files: File[], existingCount: number) {
  const errors: Array<Record<string, unknown>> = [];
  if (!files.length) {
    errors.push({
      code: "no_files",
      message: "Choose at least one file to upload.",
    });
  }
  if (files.length > MAX_SUPPORT_UPLOAD_FILES) {
    errors.push({
      code: "too_many_files",
      message: `Upload up to ${MAX_SUPPORT_UPLOAD_FILES} files at a time.`,
      limit: MAX_SUPPORT_UPLOAD_FILES,
      actual: files.length,
    });
  }
  if (existingCount + files.length > MAX_SUPPORT_UPLOAD_FILES) {
    errors.push({
      code: "request_file_limit_reached",
      message: `This request can keep up to ${MAX_SUPPORT_UPLOAD_FILES} uploaded files.`,
      limit: MAX_SUPPORT_UPLOAD_FILES,
      existingCount,
      incomingCount: files.length,
    });
  }

  for (const file of files) {
    const extension = extensionFor(file.name);
    const mimeType = file.type || "application/octet-stream";
    const isAllowed =
      ALLOWED_SUPPORT_UPLOAD_MIME_TYPES.has(mimeType) ||
      ALLOWED_SUPPORT_UPLOAD_EXTENSIONS.has(extension);
    if (!isAllowed) {
      errors.push({
        code: "unsupported_file_type",
        fileName: file.name,
        mimeType,
        extension,
        message: `${file.name} is not a supported support upload type.`,
      });
    }
    if (file.size > MAX_SUPPORT_UPLOAD_FILE_BYTES) {
      errors.push({
        code: "file_too_large",
        fileName: file.name,
        size: file.size,
        limit: MAX_SUPPORT_UPLOAD_FILE_BYTES,
        message: `${file.name} is larger than the 50MB upload limit.`,
      });
    }
  }

  return errors;
}

const PROVIDER_MUTABLE_SUPPORT_FILE_PURPOSES = new Set([
  "provider_message_upload",
  "milestone_upload",
  "admin_clean_pdf",
  "admin_clean_docx",
]);

function retryablePaymentStatusAfterCancel(paymentType: string, request: Record<string, any>) {
  const currentRequestStatus = String(request.request_payment_status ?? request.payment_status ?? "unpaid");
  // If the deposit has already been paid, don't reset below "deposit_paid".
  if (paymentType === "deposit") {
    return currentRequestStatus === "deposit_paid" ? "deposit_paid" : "deposit_required";
  }
  if (paymentType === "full_payment") {
    return currentRequestStatus === "deposit_paid" ? "final_payment_required" : "unpaid";
  }
  if (paymentType === "final_balance" || paymentType === "partial_balance") return "final_payment_required";
  const depositAmount = Number(request.deposit_amount ?? 0);
  const totalAmount = Number(request.final_amount ?? request.payment_amount ?? request.quoted_amount ?? 0);
  if (currentRequestStatus === "deposit_paid") return "final_payment_required";
  return depositAmount > 0 && depositAmount < totalAmount ? "deposit_required" : "unpaid";
}

function assertProviderCanMutateSupportFile(auth: AuthContext, file: Record<string, any>) {
  if (!canSeeProvider(auth)) {
    throw new HttpError(403, "provider_required", "Only providers can edit request files");
  }
  if (!file.request_id) {
    throw new HttpError(400, "request_file_required", "Only request files can be edited");
  }
  if (file.deleted_at) {
    throw new HttpError(410, "file_deleted", "This file has already been deleted");
  }
  if (!PROVIDER_MUTABLE_SUPPORT_FILE_PURPOSES.has(String(file.purpose ?? ""))) {
    throw new HttpError(403, "file_not_provider_owned", "Only provider-uploaded files can be edited");
  }
}

function updateAttachmentForFile(
  attachment: Record<string, any>,
  fileId: string,
  updater: (item: Record<string, any>) => Record<string, any>,
) {
  let changed = false;
  const next = { ...attachment };
  const attachmentFileId = String(next.fileId ?? next.id ?? "").trim();
  if (attachmentFileId === fileId && (!next.kind || next.kind === "file")) {
    Object.assign(next, updater(next));
    changed = true;
  }
  if (Array.isArray(next.files)) {
    const files = next.files.map((file) => {
      if (!file || typeof file !== "object") return file;
      const nestedFile = { ...(file as Record<string, any>) };
      const nestedFileId = String(nestedFile.fileId ?? nestedFile.id ?? "").trim();
      if (nestedFileId !== fileId) return file;
      changed = true;
      return updater(nestedFile);
    });
    next.files = files;
  }
  return { attachment: next, changed };
}

async function updateSupportMessageFileAttachments(
  fileId: string,
  updater: (item: Record<string, any>) => Record<string, any>,
) {
  const db = getDb();
  const markers = [
    { fileId },
    { id: fileId },
  ];
  const messages = await db`
    SELECT *
    FROM support_messages
    WHERE deleted_at IS NULL
      AND (
        attachments @> ${db.json([markers[0]] as any)}::jsonb
        OR attachments @> ${db.json([markers[1]] as any)}::jsonb
      )
  `;
  const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
  for (const message of messages) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    let changed = false;
    const nextAttachments = attachments.map((attachment) => {
      if (!attachment || typeof attachment !== "object") return attachment;
      const result = updateAttachmentForFile(attachment as Record<string, any>, fileId, updater);
      if (result.changed) changed = true;
      return result.attachment;
    });
    if (!changed) continue;
    const [updatedMessage] = await db`
      UPDATE support_messages
      SET attachments = ${db.json(nextAttachments as any)}, edited_at = COALESCE(edited_at, NOW())
      WHERE id = ${message.id}
      RETURNING *
    `;
    broadcastSupportMessageUpdate(String(updatedMessage.thread_id), toCamel(updatedMessage));
  }
}

async function createSupportFileActivityMessage(
  auth: AuthContext,
  requestId: string,
  content: string,
  attachment: Record<string, any>,
) {
  const db = getDb();
  const [thread] = await db`
    SELECT *
    FROM support_message_threads
    WHERE request_id = ${requestId}::uuid
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (!thread) return null;
  const [message] = await db`
    INSERT INTO support_messages (
      thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by
    )
    VALUES (
      ${thread.id}, ${auth.userId}, ${auth.email}, 'provider',
      ${content}, ${db.json([attachment] as any)}, ARRAY[${auth.userId}]::TEXT[]
    )
    RETURNING *
  `;
  await db`
    UPDATE support_message_threads
    SET last_message_at = ${message.created_at}, updated_at = NOW()
    WHERE id = ${thread.id}
  `;
  await addSupportEvent(requestId, auth, "support.file.changed", content, {
    threadId: thread.id,
    messageId: message.id,
    attachment,
  });
  const { broadcastSupportMessage } = await import("../support-messages/realtime");
  broadcastSupportMessage(String(thread.id), toCamel(message));
  return message;
}

function requestEstimateInput(request: Record<string, any>) {
  return {
    academicLevel: request.academic_level,
    serviceCategory: Array.isArray(request.service_tags) ? request.service_tags[0] : undefined,
    serviceTags: Array.isArray(request.service_tags) ? request.service_tags : [],
    selectedChapters: Array.isArray(request.draft_payload?.selectedChapters)
      ? request.draft_payload.selectedChapters
      : [],
    budgetMin: Number(request.budget_min ?? 0) || undefined,
    budgetMax: Number(request.budget_max ?? 0) || undefined,
    dataCollectionOwner: request.draft_payload?.dataCollectionOwner,
    analysisOwner: request.draft_payload?.analysisOwner,
    includeSlides: Boolean(request.draft_payload?.includeSlides),
    assistance24x7: Boolean(request.draft_payload?.assistance24x7),
    description: request.description,
    pages: Number(request.pages ?? 0) || undefined,
    wordCount: Number(request.word_count ?? 0) || undefined,
    deadlineAt: request.deadline_at ? new Date(request.deadline_at).toISOString() : undefined,
    correctionCommentCount: Number(request.draft_payload?.correctionCommentCount ?? 0) || undefined,
  };
}

function requestEstimateInputFromBody(body: Record<string, any>) {
  return {
    academicLevel: body.academicLevel,
    serviceCategory: Array.isArray(body.serviceTags) ? body.serviceTags[0] : undefined,
    serviceTags: Array.isArray(body.serviceTags) ? body.serviceTags : [],
    selectedChapters: Array.isArray(body.selectedChapters) ? body.selectedChapters : [],
    budgetMin: Number(body.budgetMin ?? 0) || undefined,
    budgetMax: Number(body.budgetMax ?? 0) || undefined,
    dataCollectionOwner: body.dataCollectionOwner,
    analysisOwner: body.analysisOwner,
    includeSlides: Boolean(body.includeSlides),
    assistance24x7: Boolean(body.assistance24x7),
    description: body.description,
    pages: Number(body.pages ?? 0) || undefined,
    wordCount: Number(body.wordCount ?? 0) || undefined,
    deadlineAt: body.deadlineAt ? new Date(body.deadlineAt).toISOString() : undefined,
    correctionCommentCount: Number(body.correctionCommentCount ?? 0) || undefined,
  };
}

function assertAssignmentRequestBody(body: Record<string, any>) {
  const serviceTags = Array.isArray(body.serviceTags) ? body.serviceTags.map(String) : [];
  const isAssignment = serviceTags.includes("assignment") || body.serviceCategory === "assignment";
  if (!isAssignment) return;
  if (serviceTags.length > 1) {
    throw new HttpError(400, "assignment_single_service", "Assignment requests can only contain one assignment service.");
  }
  const instructions = String(body.assignmentInstructions ?? body.description ?? "").trim();
  if (!instructions) {
    throw new HttpError(400, "assignment_instructions_required", "Assignment instructions are required.");
  }
  body.serviceTags = ["assignment"];
  body.serviceCategory = "assignment";
  body.assignmentInstructions = instructions;
  body.paymentMode = "before_work";
  body.preferredPaymentMode = "before_work";
  body.depositPercent = 100;
  if (!String(body.description ?? "").trim()) body.description = instructions;
}

function bodyWithAuthoritativeEstimate(body: Record<string, any>): Record<string, any> {
  const estimateInput = requestEstimateInputFromBody(body);
  const localEstimate = estimateSupportCostLocal(estimateInput);
  const isAssignment = estimateInput.serviceCategory === "assignment" || (estimateInput.serviceTags ?? []).includes("assignment");
  const clientEstimate = body.costEstimate && typeof body.costEstimate === "object" ? body.costEstimate : {};
  const trustedTotal = isAssignment
    ? 10
    : roundMoney(localEstimate.range.min);
  const trustedMax = isAssignment
    ? 10
    : roundMoney(Math.max(localEstimate.range.max, trustedTotal));

  return {
    ...body,
    paymentMode: "before_work",
    preferredPaymentMode: "before_work",
    depositPercent: 100,
    costEstimate: {
      ...clientEstimate,
      total: trustedTotal,
      min: trustedTotal,
      max: trustedMax,
      range: {
        min: trustedTotal,
        max: trustedMax,
      },
      serverMinimumTotal: localEstimate.range.min,
      provider: "server-local",
    },
  };
}

function formatRequestDeadline(deadlineAt: unknown) {
  if (!deadlineAt) return "the agreed deadline";
  const date = new Date(String(deadlineAt));
  if (!Number.isFinite(date.getTime())) return "the agreed deadline";
  return date.toLocaleString("en-GB", {
    timeZone: DEFAULT_SUPPORT_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function createRequestAiAcknowledgement(
  request: Record<string, any>,
  auth: AuthContext,
) {
  const db = getDb();
  const thread = await ensureSupportMessageThread(String(request.id), auth.userId);
  if (!thread) return null;

  const files = await db`
    SELECT id, file_name, file_type, file_size, purpose, content_base64, external_file_url
    FROM support_files
    WHERE request_id = ${request.id}::uuid
      AND user_key_id = ${auth.userId}
    ORDER BY created_at ASC
    LIMIT 8
  `;
  const attachmentMetadata = Array.isArray(request.attachment_metadata)
    ? request.attachment_metadata
    : [];
  const fileReferences = [
    ...attachmentMetadata,
    ...files.map((file) => ({
      id: String(file.id),
      fileName: String(file.file_name ?? ""),
      fileType: String(file.file_type ?? ""),
      fileSize: Number(file.file_size ?? 0),
      purpose: String(file.purpose ?? "client_upload"),
      readableByModel: Boolean(file.content_base64),
      externalFileUrl: file.external_file_url ?? null,
    })),
  ];
  const inlineFiles = files
    .filter((file) => file.content_base64 && Number(file.file_size ?? 0) <= 8 * 1024 * 1024)
    .slice(0, 4)
    .map((file) => ({
      mimeType: String(file.file_type ?? "application/octet-stream"),
      data: String(file.content_base64),
      displayName: String(file.file_name ?? "support-upload"),
    }));
  const costEstimate = await estimateSupportCost(requestEstimateInput(request));
  const promptHash = hashSupportPrompt({
    purpose: "support_request_acknowledgement",
    requestId: String(request.id),
    status: String(request.status ?? ""),
    model: getSupportAiModel(),
  });

  const [existing] = await db`
    SELECT id
    FROM support_messages
    WHERE thread_id = ${thread.id}::uuid
      AND sender_key_id = 'support-ai'
      AND prompt_hash = ${promptHash}
    LIMIT 1
  `;
  if (existing) return toCamel(existing);

  const prompt = [
    "Create a concise first support chat acknowledgement for a submitted client request.",
    "Speak directly to the client in first person plural as CognizApp Support.",
    "Explicitly say whether files/documents were read or only file names/metadata were available.",
    "Only claim document contents were read when readableFileCount is greater than 0.",
    "When readableFileCount is greater than 0, include 2-3 concrete observations from the readable file content and what needs to be done next.",
    "When only file metadata is available, list the uploaded file names/types and explain that deeper content review is continuing.",
    "If the request title or description contains console errors, stack traces, or code frames, do not quote them; treat them as accidental diagnostic text and focus on the client's actual files and support deliverable.",
    "Mention the deadline, the main deliverables you understand, and that a provider will follow up if human clarification or quoting is needed.",
    "Do not promise impossible work, final acceptance, or guaranteed delivery before payment/provider review.",
    JSON.stringify({
      request: {
        id: String(request.id),
        taskId: String(request.task_id ?? ""),
        title: String(request.title ?? ""),
        description: String(request.description ?? ""),
        serviceTags: Array.isArray(request.service_tags) ? request.service_tags : [],
        academicLevel: request.academic_level ?? null,
        subject: request.subject ?? null,
        outputExpectation: request.output_expectation ?? null,
        deadline: formatRequestDeadline(request.deadline_at),
        wordCount: request.word_count ?? null,
        pages: request.pages ?? null,
        budgetMin: request.budget_min ?? null,
        budgetMax: request.budget_max ?? null,
        currency: request.currency ?? "GHS",
        paymentStatus: request.payment_status ?? null,
      },
      costEstimate,
      fileReferences,
      readableFileCount: inlineFiles.length,
    }),
  ].join("\n");

  const localAcknowledgement = () => {
    const fileNames = fileReferences
      .map((file: any) => String(file.fileName ?? file.name ?? file.displayName ?? "").trim())
      .filter(Boolean)
      .slice(0, 4);
    const title = String(request.title ?? "your request").trim();
    const safeTitle = /##\s*Error|Code Frame|RequestWizard|Draft not found|Console Error/i.test(title)
      ? "your submitted request"
      : `"${title || "your request"}"`;
    const filePhrase = fileReferences.length
      ? inlineFiles.length
        ? `I have reviewed readable document content from ${fileNames.length ? fileNames.join(", ") : "your uploaded files"}`
        : `I can see the uploaded file details for ${fileNames.length ? fileNames.join(", ") : "your files"} while deeper content review continues`
      : "I have reviewed your request details";
    const nextSteps = "We will compare the submitted material against the requested deliverables, confirm any missing context, and prepare the provider handoff before work begins";
    return {
      model: getSupportAiModel(),
      provider: "fallback" as const,
      reasoning: "The acknowledgement used the local request, file metadata, and cost-estimate context because CognizApp Lite was not available.",
      response: `${filePhrase}. For ${safeTitle}, ${nextSteps}. The current deadline is ${formatRequestDeadline(request.deadline_at)}.`,
      complexity: "complex" as const,
      actionItems: [
        {
          type: "contact_support" as const,
          label: "Wait for provider review",
          data: { requestId: String(request.id), taskId: String(request.task_id ?? "") },
        },
      ],
    };
  };
  const generatedAiResult = await generateSupportAiResponse({
    prompt,
    requestReferences: [{ requestId: String(request.id), taskId: String(request.task_id ?? "") }],
    fileReferences,
    inlineFiles,
  }).catch((error) => {
    console.warn("[support:ai] request acknowledgement generation failed", {
      requestId: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return localAcknowledgement();
  });
  const aiResult = generatedAiResult.provider === "fallback"
    ? localAcknowledgement()
    : generatedAiResult;
  const publicAiResult = {
    reasoning: aiResult.reasoning,
    response: aiResult.response,
    complexity: aiResult.complexity,
    actionItems: aiResult.actionItems,
    model: getPublicSupportAiModelName(aiResult.model),
    provider: aiResult.provider === "fallback" ? "fallback" : "cognizapp",
    costEstimate,
    readableFileCount: inlineFiles.length,
  };
  const [message] = await db`
    INSERT INTO support_messages (
      thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by,
      mentions, file_references, ai_reasoning, prompt_hash, structured_output
    )
    VALUES (
      ${thread.id}::uuid, 'support-ai', 'CognizApp AI', 'ai', ${aiResult.response}, '[]'::jsonb, ARRAY[]::TEXT[],
      ${db.json([{ requestId: String(request.id), taskId: String(request.task_id ?? "") }] as any)},
      ${db.json(fileReferences as any)}, ${aiResult.reasoning}, ${promptHash},
      ${db.json(publicAiResult as any)}
    )
    RETURNING *
  `;
  await db`
    UPDATE support_message_threads
    SET last_message_at = ${message.created_at}, updated_at = NOW()
    WHERE id = ${thread.id}
  `;
  const { broadcastSupportMessage } = await import("../support-messages/realtime");
  broadcastSupportMessage(String(thread.id), toCamel(message));
  return toCamel(message);
}

export const supportRoutes = new Elysia({
  prefix: "/api/support",
  tags: ["support"],
})
  .onError(({ code, error, set, request }) => {
    const routeContext = (() => {
      try {
        const url = request ? new URL(request.url) : null;
        return {
          method: request?.method,
          path: url?.pathname,
          search: url?.search,
        };
      } catch {
        return {};
      }
    })();
    if (error instanceof HttpError) {
      console.warn("[support:error]", {
        ...routeContext,
        status: error.status,
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION" || code === "PARSE" || isRequestBodyParseError(error)) {
      console.warn("[support:error]", {
        ...routeContext,
        status: 400,
        errorCode: "invalid_request",
        message: "Invalid request body",
      });
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
    console.error("[support:error]", {
      ...routeContext,
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: env.isDevelopment && error instanceof Error ? error.stack : undefined,
    });
    set.status = 500;
    return fail("Support request failed", "support_internal_error");
  })
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
  .get("/client/dashboard-stats", async ({ headers, set }) => {
    const auth = await resolveAuth(headers);
    const cacheKey = `support:${auth.userId}:client-dashboard-stats`;
    const cached = await cache.getJson<Record<string, unknown>>(cacheKey);
    if (cached) {
      set.headers["Cache-Control"] =
        "private, max-age=60, stale-while-revalidate=240";
      return ok(cached);
    }
    const db = getDb();
    const [stats] = await db`
      SELECT
        COUNT(*)::int AS total_requests,
        COUNT(*) FILTER (WHERE status IN ('submitted', 'payment_pending', 'admin_review', 'under_review', 'in_progress', 'revision_requested', 'revision_in_progress', 'work_ready'))::int AS active_requests,
        COUNT(*) FILTER (WHERE COALESCE(payment_status, 'unpaid') IN ('unpaid', 'failed', 'deposit_required', 'final_payment_required'))::int AS unpaid_requests,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS recent_activity_count,
        COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_requests,
        COUNT(*) FILTER (WHERE status IN ('completed', 'closed'))::int AS completed_requests,
        COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600)::numeric, 1), 0)::float AS average_response_hours
      FROM support_requests
      WHERE user_key_id = ${auth.userId}
    `;
    const recentRequests = await db`
      SELECT id, task_id, title, status, payment_status, deadline_at, updated_at, created_at
      FROM support_requests
      WHERE user_key_id = ${auth.userId}
      ORDER BY updated_at DESC
      LIMIT 6
    `;
    const recentMessages = await db`
      SELECT m.id, m.thread_id, m.content, m.sender_role, m.created_at, t.request_id, t.type
      FROM support_messages m
      INNER JOIN support_message_threads t ON t.id = m.thread_id
      WHERE t.user_key_id = ${auth.userId}
      ORDER BY m.created_at DESC
      LIMIT 6
    `;

    set.headers["Cache-Control"] =
      "private, max-age=60, stale-while-revalidate=240";
    const payload = {
      data: {
        stats: toCamel(stats ?? {}),
        recentRequests: recentRequests.map(toCamel),
        recentMessages: recentMessages.map(toCamel),
      },
    };
    await cache.setJson(cacheKey, payload, 90);
    return ok(payload);
  })
  .get(
    "/client/requests",
    async ({ headers, query }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const status = String(query.status ?? "").trim();
      const paymentStatus = String(query.paymentStatus ?? "").trim();
      const cacheKey = `support:${auth.userId}:client-requests:${status || "all"}:${paymentStatus || "all"}`;
      const payload = await cache.rememberJson(cacheKey, 15, async () => {
        const rows = await db`
      WITH client_requests AS (
        SELECT DISTINCT ON (r.id)
          r.*,
          f.file_url AS payment_proof_file_url,
          f.file_name AS payment_proof_file_name
        FROM support_requests r
        LEFT JOIN support_files f ON f.id = r.payment_proof_file_id
        WHERE r.user_key_id = ${auth.userId}
          AND (${status || null}::text IS NULL OR r.status = ${status || null})
          AND (${paymentStatus || null}::text IS NULL OR r.payment_status = ${paymentStatus || null})
        ORDER BY r.id, r.updated_at DESC
      )
      SELECT *
      FROM client_requests
      ORDER BY updated_at DESC
      LIMIT 100
    `;
        return { data: rows.map(toCamel) };
      });
      return ok(payload);
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        paymentStatus: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/client/requests",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const whatsappNumber = assertSupportWhatsAppNumber(body.whatsappNumber);
      const client = await ensureClient(auth, body);
      assertAssignmentRequestBody(body);
      const pricingBody = bodyWithAuthoritativeEstimate(body);
      const isAssignment = pricingBody.serviceCategory === "assignment" || (pricingBody.serviceTags ?? []).includes("assignment");
      const basePaymentSchedule = buildPaymentSchedule(pricingBody);
      const discountCode = isAssignment ? "" : String(body.discountCode ?? "").trim().toUpperCase();
      const [discount] = discountCode
        ? await db`
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
        `
        : [];
      if (discountCode) {
        if (!discount) {
          throw new HttpError(400, "invalid_discount_code", "Invalid discount code.");
        }
        if (String(discount.status) !== "active") {
          throw new HttpError(409, "discount_code_unavailable", "This discount code is not active.");
        }
        if (discount.expires_at && new Date(discount.expires_at).getTime() < Date.now()) {
          throw new HttpError(409, "discount_code_expired", "This discount code has expired.");
        }
        if (Number(discount.effective_redemption_count ?? 0) >= Number(discount.max_redemptions ?? 1)) {
          throw new HttpError(409, "discount_code_redeemed", "This discount code has already been used.");
        }
        const minimumAmount = Number(discount.minimum_amount ?? 0);
        if (minimumAmount > 0 && basePaymentSchedule.paymentAmount < minimumAmount) {
          throw new HttpError(409, "discount_minimum_not_met", "This request does not meet the minimum amount for that discount code.");
        }
        const eligibleTags = Array.isArray(discount.eligible_service_tags) ? discount.eligible_service_tags : [];
        const requestTags = Array.isArray(body.serviceTags) ? body.serviceTags : [];
        if (eligibleTags.length && !requestTags.some((tag: string) => eligibleTags.includes(tag))) {
          throw new HttpError(409, "discount_service_not_eligible", "This discount code does not apply to the selected service.");
        }
      }
      const discountPercent = discount ? Number(discount.discount_percent ?? 0) : 0;
      const discountAmount = roundMoney(basePaymentSchedule.paymentAmount * (discountPercent / 100));
      const finalAmount = roundMoney(Math.max(basePaymentSchedule.paymentAmount - discountAmount, 0));
      const paymentSchedule = finalAmount === basePaymentSchedule.paymentAmount
        ? basePaymentSchedule
        : buildPaymentSchedule({ ...pricingBody, costEstimate: { total: finalAmount } });
      const [request] = await db.begin(async (tx) => {
        const [req] = await tx`
          INSERT INTO support_requests (
            task_id, user_key_id, client_id, title, description, service_tags, subject,
            academic_level, output_expectation, institution, whatsapp_number,
            supervisor_comments, referral_code, deadline_at, timezone, budget_min,
            budget_max, currency, word_count, pages, attachment_metadata, integrity_ack, contact_consent,
            workspace_id, payment_amount, quoted_amount, deposit_percent, deposit_amount,
            balance_amount, payment_status, payment_mode, user_notes, draft_payload, draft_step,
            discount_code_id, discount_amount, original_amount, final_amount
          )
          VALUES (
            ${await generateTaskId()}, ${auth.userId}, ${client.id}, ${body.title},
            ${body.description ?? ""}, ${body.serviceTags ?? []}, ${body.subject ?? null},
            ${body.academicLevel ?? null}, ${body.outputExpectation ?? null},
            ${body.institution ?? null}, ${whatsappNumber},
            ${body.supervisorComments ?? null}, ${body.referralCode ?? null},
            ${body.deadlineAt ? new Date(body.deadlineAt) : null}, ${DEFAULT_SUPPORT_TIMEZONE},
            ${body.budgetMin ?? null}, ${body.budgetMax ?? null}, ${body.currency ?? "GHS"},
            ${body.wordCount ?? null}, ${body.pages ?? null}, ${tx.json((body.attachmentMetadata ?? []) as any)}, ${body.integrityAck ?? false},
            ${body.contactConsent ?? false}, ${body.workspaceId ? `${body.workspaceId}` : null},
            ${paymentSchedule.paymentAmount}, ${paymentSchedule.paymentAmount},
            ${paymentSchedule.depositPercent}, ${paymentSchedule.depositAmount},
            ${paymentSchedule.balanceAmount}, 'unpaid',
            ${pricingBody.paymentMode ?? pricingBody.preferredPaymentMode ?? "before_work"}, ${body.userNotes ?? null},
            ${tx.json(buildDraftPayload(pricingBody))}, ${body.currentStep ?? 0},
            ${discount?.id ?? null}, ${discountAmount}, ${basePaymentSchedule.paymentAmount}, ${finalAmount}
          )
          RETURNING *
        `;

        if (body.referralCode) {
          await tx`
            INSERT INTO support_referrals (
              referrer_code, source_user_key_id, referred_user_key_id, referred_client_id,
              request_id, currency, payout_preferences
            )
            SELECT ${body.referralCode}, sc.user_key_id, ${auth.userId}, ${client.id},
              ${req.id}, ${body.currency ?? "GHS"}, COALESCE(sc.payout_preferences, '{}'::jsonb)
            FROM support_clients sc
            WHERE sc.referral_code = ${body.referralCode}
              AND sc.user_key_id != ${auth.userId}
            LIMIT 1
          `;
        }

        return [req];
      });

      await addSupportEvent(
        request.id,
        auth,
        "request.created",
        "Request draft created",
        {
          status: request.status,
          paymentStatus: request.payment_status,
        },
      );

      await ensureSupportMessageThread(String(request.id), auth.userId);

      void (async () => {
        try {
          await ensureRequestStorageReady(
            { ...request, email: client.email, full_name: client.full_name },
            auth,
          );
        } catch (error) {
          console.warn("[support] background request setup failed", {
            requestId: request.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();

      try {
        await invalidateSupportCache(auth.userId);
      } catch (error) {
        console.warn("[support] cache invalidation failed after request create", {
          userId: auth.userId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return ok({
        data: toCamel(request),
        message: "Support request saved",
      });
    },
    {
      body: requestBody,
    },
  )
  .get("/client/requests/:id", async ({ headers, params, set }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const cacheKey = `support:${auth.userId}:client-request:${params.id}`;
    const payload = await cache.rememberJson(cacheKey, 12, async () => {
      const [request] = await db`
        SELECT r.*, f.file_url AS payment_proof_file_url, f.file_name AS payment_proof_file_name
        FROM support_requests r
        LEFT JOIN support_files f ON f.id = r.payment_proof_file_id
        WHERE r.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!request)
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      const policy = (request.payment_policy ?? {}) as Record<string, any>;
      return {
        data: {
          ...toCamel(request),
          canDownloadFinal: String(request.payment_status ?? "") === "paid",
          canViewFullPreview: canAccessFullProtectedPreview(request.payment_status, policy),
          revisionsRemaining: Math.max(
            0,
            Number(request.revisions_allowed ?? 2) - Number(request.revisions_used ?? 0),
          ),
        },
      };
    });
    set.headers["Cache-Control"] = "private, max-age=10, stale-while-revalidate=60";
    return ok(payload);
  })
  .put(
    "/client/requests/:id",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const whatsappNumber = assertSupportWhatsAppNumber(body.whatsappNumber);
      assertAssignmentRequestBody(body);
      const pricingBody = bodyWithAuthoritativeEstimate(body);
      const isAssignment = pricingBody.serviceCategory === "assignment" || (pricingBody.serviceTags ?? []).includes("assignment");
      const basePaymentSchedule = buildPaymentSchedule(pricingBody);
      const [previous] = await db`
        SELECT *
        FROM support_requests
        WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!previous)
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      assertClientRequestEditable(previous);
      const discountCode = isAssignment ? "" : String(body.discountCode ?? "").trim().toUpperCase();
      const [discount] = discountCode
        ? await db`
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
        `
        : [];
      if (discountCode) {
        if (!discount) {
          throw new HttpError(400, "invalid_discount_code", "Invalid discount code.");
        }
        if (String(discount.status) !== "active") {
          throw new HttpError(409, "discount_code_unavailable", "This discount code is not active.");
        }
        if (discount.expires_at && new Date(discount.expires_at).getTime() < Date.now()) {
          throw new HttpError(409, "discount_code_expired", "This discount code has expired.");
        }
        if (Number(discount.effective_redemption_count ?? 0) >= Number(discount.max_redemptions ?? 1)) {
          throw new HttpError(409, "discount_code_redeemed", "This discount code has already been used.");
        }
        const minimumAmount = Number(discount.minimum_amount ?? 0);
        if (minimumAmount > 0 && basePaymentSchedule.paymentAmount < minimumAmount) {
          throw new HttpError(409, "discount_minimum_not_met", "This request does not meet the minimum amount for that discount code.");
        }
        const eligibleTags = Array.isArray(discount.eligible_service_tags) ? discount.eligible_service_tags : [];
        const requestTags = Array.isArray(body.serviceTags) ? body.serviceTags : [];
        if (eligibleTags.length && !requestTags.some((tag: string) => eligibleTags.includes(tag))) {
          throw new HttpError(409, "discount_service_not_eligible", "This discount code does not apply to the selected service.");
        }
      }
      const discountPercent = discount ? Number(discount.discount_percent ?? 0) : 0;
      const discountAmount = roundMoney(basePaymentSchedule.paymentAmount * (discountPercent / 100));
      const finalAmount = roundMoney(Math.max(basePaymentSchedule.paymentAmount - discountAmount, 0));
      const paymentSchedule = finalAmount === basePaymentSchedule.paymentAmount
        ? basePaymentSchedule
        : buildPaymentSchedule({ ...pricingBody, costEstimate: { total: finalAmount } });
      await db`
        INSERT INTO support_request_versions (
          request_id, version_number, snapshot_payload, changed_by, change_reason
        )
        SELECT ${params.id}::uuid,
          COALESCE(MAX(version_number), 0) + 1,
          ${db.json(toCamel(previous))},
          ${auth.userId}::uuid,
          'client_request_update'
        FROM support_request_versions
        WHERE request_id = ${params.id}::uuid
      `;
      const [request] = await db`
      UPDATE support_requests
      SET
        title = ${body.title},
        description = ${body.description ?? ""},
        service_tags = ${body.serviceTags ?? []},
        subject = ${body.subject ?? null},
        academic_level = ${body.academicLevel ?? null},
        output_expectation = ${body.outputExpectation ?? null},
        institution = ${body.institution ?? null},
        whatsapp_number = ${whatsappNumber},
        supervisor_comments = ${body.supervisorComments ?? null},
        referral_code = ${body.referralCode ?? null},
        deadline_at = ${body.deadlineAt ? new Date(body.deadlineAt) : null},
        timezone = ${DEFAULT_SUPPORT_TIMEZONE},
        budget_min = ${body.budgetMin ?? null},
        budget_max = ${body.budgetMax ?? null},
        currency = ${body.currency ?? "GHS"},
        word_count = ${body.wordCount ?? null},
        pages = ${body.pages ?? null},
        attachment_metadata = ${db.json((body.attachmentMetadata ?? []) as any)},
        integrity_ack = ${body.integrityAck ?? false},
        contact_consent = ${body.contactConsent ?? false},
        workspace_id = COALESCE(${body.workspaceId ? `${body.workspaceId}` : null}::uuid, workspace_id),
        payment_amount = CASE
          WHEN payment_status IN ('deposit_paid', 'paid', 'final_payment_pending_verification', 'final_payment_required') THEN payment_amount
          ELSE ${paymentSchedule.paymentAmount}
        END,
        quoted_amount = CASE
          WHEN payment_status IN ('deposit_paid', 'paid', 'final_payment_pending_verification', 'final_payment_required') THEN quoted_amount
          ELSE ${paymentSchedule.paymentAmount}
        END,
        deposit_percent = CASE
          WHEN payment_status IN ('deposit_paid', 'paid', 'final_payment_pending_verification', 'final_payment_required') THEN deposit_percent
          ELSE ${paymentSchedule.depositPercent}
        END,
        deposit_amount = CASE
          WHEN payment_status IN ('deposit_paid', 'paid', 'final_payment_pending_verification', 'final_payment_required') THEN deposit_amount
          ELSE ${paymentSchedule.depositAmount}
        END,
        balance_amount = CASE
          WHEN payment_status IN ('deposit_paid', 'paid', 'final_payment_pending_verification', 'final_payment_required') THEN balance_amount
          ELSE ${paymentSchedule.balanceAmount}
        END,
        payment_status = CASE
          WHEN payment_status IN ('deposit_paid', 'paid', 'pending', 'deposit_pending_verification', 'final_payment_pending_verification') THEN payment_status
          WHEN ${paymentSchedule.paymentAmount} > 0 THEN ${paymentSchedule.depositAmount > 0 ? "deposit_required" : "final_payment_required"}
          ELSE 'paid'
        END,
        payment_mode = ${pricingBody.paymentMode ?? pricingBody.preferredPaymentMode ?? "before_work"},
        user_notes = ${body.userNotes ?? null},
        draft_payload = ${db.json(buildDraftPayload(pricingBody))},
        draft_step = ${body.currentStep ?? 0},
        discount_code_id = ${discount?.id ?? null},
        discount_amount = ${discountAmount},
        original_amount = ${basePaymentSchedule.paymentAmount},
        final_amount = ${finalAmount},
        updated_at = NOW()
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
      RETURNING *
    `;
      await db`
        UPDATE support_clients
        SET whatsapp_number = ${whatsappNumber},
          institution = COALESCE(NULLIF(${String(body.institution ?? "").trim()}, ''), institution),
          updated_at = NOW()
        WHERE id = ${previous.client_id}
      `;
      await invalidateSupportCache(auth.userId);
      return ok({ data: toCamel(request), message: "Support request updated" });
    },
    {
      body: requestBody,
    },
  )
  .delete("/client/requests/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const [existing] = await db`
      SELECT *
      FROM support_requests
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!existing) {
      throw new HttpError(404, "request_not_found", "Support request not found");
    }

    const status = String(existing.status ?? "");
    const paymentStatus = String(existing.payment_status ?? "unpaid");
    const isAbandonedPaymentDraft =
      status === "payment_pending" &&
      [
        "unpaid",
        "failed",
        "pending",
        "paystack_pending",
        "deposit_required",
        "deposit_pending_verification",
      ].includes(paymentStatus);
    const [lockedPayment] = await db`
      SELECT id, status
      FROM support_payments
      WHERE request_id = ${existing.id}
        AND (status IN ('submitted', 'verified', 'refunded', 'refund_pending')
          OR verified_at IS NOT NULL)
      LIMIT 1
    `;

    if (status !== "draft" && !isAbandonedPaymentDraft) {
      throw new HttpError(
        409,
        "request_not_deletable",
        "Only drafts or abandoned unpaid payment drafts can be deleted",
      );
    }

    if (lockedPayment) {
      throw new HttpError(
        409,
        "payment_record_locked",
        "This request has payment evidence or a verified payment, so it cannot be deleted",
      );
    }

    const [request] = await db.begin(async (tx) => {
      await tx`
        DELETE FROM support_message_threads
        WHERE request_id = ${existing.id}
      `;

      await tx`
        DELETE FROM paystack_transactions
        WHERE support_request_id = ${existing.id}
          OR support_payment_id IN (
            SELECT id FROM support_payments WHERE request_id = ${existing.id}
          )
      `;

      const [deleted] = await tx`
        DELETE FROM support_requests
        WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
        RETURNING *
      `;

      return [deleted];
    });
    await Promise.all([
      invalidateSupportCache(auth.userId),
      invalidateProviderSupportCache(),
    ]).catch((error) => {
      console.warn("[support] cache invalidation failed after request delete", {
        userId: auth.userId,
        requestId: params.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return ok({ data: toCamel(request), message: "Request deleted" });
  })
  .post(
    "/client/requests/:id/cancel",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reason = String(body?.reason ?? "").trim();
      const [request] = await getDb()`
      UPDATE support_requests
      SET status = 'cancelled',
        payment_status = CASE
          WHEN payment_status IN ('paid', 'deposit_paid', 'pending', 'deposit_pending_verification', 'final_payment_pending_verification') THEN payment_status
          ELSE 'cancelled'
        END,
        user_notes = COALESCE(NULLIF(${reason}, ''), user_notes),
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
        AND user_key_id = ${auth.userId}
        AND status NOT IN ('draft', 'cancelled', 'completed', 'closed', 'work_ready')
      RETURNING *
    `;
      if (!request)
        throw new HttpError(
          404,
          "request_not_cancelable",
          "Request not found or cannot be cancelled",
        );
      await addSupportEvent(
        params.id,
        auth,
        "request.cancelled",
        "Client cancelled request",
        {
          reason,
        },
      );
      await invalidateSupportCache(auth.userId);
      return ok({ data: toCamel(request), message: "Request cancelled" });
    },
    {
      body: t.Optional(t.Object({ reason: t.Optional(t.String()) })),
    },
  )
  .post("/client/requests/:id/submit", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    let [existingRequest] = await db`
      SELECT *
      FROM support_requests
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!existingRequest || !existingRequest.integrity_ack) {
      throw new HttpError(
        400,
        "request_not_submitted",
        "Request must exist and include integrity acknowledgement",
      );
    }
    existingRequest = await ensureSupportRequestWorkspace(auth, existingRequest);
    assertSupportWhatsAppNumber(existingRequest.whatsapp_number);
    const riskTier = await classifySupportRisk(
      auth.userId,
      existingRequest.client_id ? String(existingRequest.client_id) : null,
    );
    const paymentPolicy = buildSupportPaymentPolicy(existingRequest, riskTier);
    await verifySupportWorkspaceAccess(
      auth,
      String(existingRequest.workspace_id),
    );
    const [request] = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${params.id}))`;
      if (existingRequest.discount_code_id) {
        const [existingRedemption] = await tx`
          SELECT id
          FROM support_discount_redemptions
          WHERE request_id = ${params.id}::uuid
            AND discount_code_id = ${existingRequest.discount_code_id}
            AND status = 'redeemed'
          LIMIT 1
        `;
        if (!existingRedemption) {
          const [redeemedCode] = await tx`
            WITH usage AS (
              SELECT COUNT(*)::int AS used
              FROM support_discount_redemptions dr
              INNER JOIN support_requests sr ON sr.id = dr.request_id
              WHERE dr.discount_code_id = ${existingRequest.discount_code_id}
                AND dr.status = 'redeemed'
                AND sr.submitted_at IS NOT NULL
            )
            UPDATE support_discount_codes dc
            SET redemption_count = usage.used + 1,
              status = CASE WHEN usage.used + 1 >= dc.max_redemptions THEN 'redeemed' ELSE 'active' END,
              updated_at = NOW()
            FROM usage
            WHERE dc.id = ${existingRequest.discount_code_id}
              AND usage.used < dc.max_redemptions
              AND (dc.status = 'active' OR usage.used < dc.max_redemptions)
            RETURNING dc.*
          `;
          if (!redeemedCode) {
            throw new HttpError(409, "discount_code_redeemed", "This discount code has already been used.");
          }
          await tx`
            INSERT INTO support_discount_redemptions (
              discount_code_id, user_key_id, request_id, original_amount, discount_percent,
              discount_amount, final_amount, currency, status
            )
            VALUES (
              ${existingRequest.discount_code_id}, ${auth.userId}, ${params.id}::uuid,
              ${existingRequest.original_amount ?? existingRequest.payment_amount ?? 0},
              ${redeemedCode.discount_percent}, ${existingRequest.discount_amount ?? 0},
              ${existingRequest.final_amount ?? existingRequest.payment_amount ?? 0},
              ${existingRequest.currency ?? "GHS"}, 'redeemed'
            )
          `;
        }
      }
      const [updated] = await tx`
        UPDATE support_requests
        SET status = 'submitted',
          submitted_at = COALESCE(submitted_at, NOW()),
          payment_status = CASE WHEN payment_status = 'paid' THEN 'paid' ELSE 'unpaid' END,
          payment_mode = 'before_work',
          risk_tier = ${riskTier},
          payment_policy = ${tx.json(paymentPolicy as any)},
          payment_policy_version = ${paymentPolicy.version},
          revisions_allowed = ${paymentPolicy.revisionsAllowed},
          updated_at = NOW()
        WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId} AND integrity_ack = TRUE
        RETURNING *
      `;
      return [updated];
    });
    if (!request) {
      throw new HttpError(
        400,
        "request_not_submitted",
        "Request must exist and include integrity acknowledgement",
      );
    }
    await ensureSupportMessageThread(String(request.id), auth.userId);
    await addSupportEvent(
      request.id,
      auth,
      "request.submitted",
      "Request submitted",
      {
        paymentMode: request.payment_mode,
        paymentStatus: request.payment_status,
        workspaceId: request.workspace_id,
      },
    );
    void createRequestAiAcknowledgement(request, auth).catch((error) => {
      console.warn("[support:ai] request acknowledgement background failed", {
        requestId: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    void (async () => {
      try {
        const linkedRequest = await ensureSupportWorkspaceLinks(auth, request);
        await ensureRequestStorageReady(linkedRequest, auth);
        await invalidateSupportCache(auth.userId);
      } catch (error) {
        console.warn("[support:workspace] request workspace linking failed", error);
      }
    })();
    if (Number(request.payment_amount ?? 0) <= 0) {
      void sendSupportEmail(
        auth.email,
        auth.userId,
        "support.request.submitted",
        "Your request is confirmed",
        `Your "${request.title}" request is confirmed. We will deliver it on or before ${request.deadline_at ? new Date(request.deadline_at).toLocaleString("en-GB", { timeZone: DEFAULT_SUPPORT_TIMEZONE, dateStyle: "medium", timeStyle: "short" }) : "the agreed deadline"}.`,
        {
          requestId: request.id,
          taskId: request.task_id,
          paymentStatus: request.payment_status,
          deadlineAt: request.deadline_at,
          actionUrl: `/support/requests/${request.id}`,
        },
      ).catch((error) => console.warn("[support:email] request submitted email failed", error));
    }
    void sendSupportWhatsApp(
      String(request.whatsapp_number ?? ""),
      auth.userId,
      "support.request.submitted",
      "Your CogniZap request is in motion",
      `We have received "${String(request.title ?? "your request")}". Your workspace is ready, and we will keep your files and next steps inside your portal.`,
      {
        requestId: request.id,
        taskId: request.task_id,
        paymentStatus: request.payment_status,
        deadlineAt: request.deadline_at,
        actionUrl: `/support/requests/${request.id}`,
      },
    ).catch((error) => console.warn("[support:whatsapp] request submitted WhatsApp failed", error));
    await invalidateSupportCache(auth.userId);
    return ok({
      data: toCamel(request),
      message: "Request submitted for review",
    });
  })
  .get(
    "/client/requests/:id/drive-files",
    async ({ headers, params, query }) => {
      const auth = await resolveAuth(headers);
      const [request] = await getDb()`
      SELECT id
      FROM support_requests
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId}
      LIMIT 1
    `;
      if (!request)
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      const search = String(query.query ?? "").trim();
      const rows = await getDb()`
        SELECT id, request_id, user_key_id, file_name, file_url, file_type,
          file_size, purpose, storage_provider, external_file_id,
          external_file_url, external_upload_status, external_uploaded_at,
          created_at, updated_at
        FROM support_files
        WHERE request_id = ${params.id}::uuid
          AND (${search || null}::text IS NULL OR file_name ILIKE ${`%${search}%`})
        ORDER BY created_at DESC
        LIMIT ${Number(query.limit ?? 50)}
      `;
      return ok({ data: rows.map(toCamel), count: rows.length });
    },
    {
      query: t.Object({
        query: t.Optional(t.String()),
        limit: t.Optional(t.Numeric()),
        whatToSearch: t.Optional(t.String()),
      }),
    },
  )
  .get("/client/requests/:id/files", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const rows = await getDb()`
      SELECT
        f.id,
        f.request_id,
        f.user_key_id,
        f.file_name,
        f.file_url,
        f.file_type,
        f.file_size,
        f.purpose,
        f.storage_provider,
        f.external_file_id,
        f.external_file_url,
        f.external_folder_id,
        f.external_upload_status,
        f.external_uploaded_at,
        f.created_at,
        f.updated_at
      FROM support_files f
      INNER JOIN support_requests r ON r.id = f.request_id
      WHERE f.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
        AND f.purpose NOT IN (
          'limited_preview',
          'full_protected_preview',
          'admin_clean_pdf',
          'admin_clean_docx',
          'provider_preview_page'
        )
      ORDER BY f.created_at DESC
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .get("/client/requests/:id/draft", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const [request] = await getDb()`
      SELECT id, status, draft_payload, draft_step, updated_at
      FROM support_requests
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId} AND status = 'draft'
      LIMIT 1
    `;
    if (!request)
      throw new HttpError(404, "draft_not_found", "Draft request not found");
    return ok({ data: toCamel(request) });
  })
  .post(
    "/client/requests/:id/draft",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const [request] = await getDb()`
      UPDATE support_requests
      SET draft_payload = ${getDb().json((body.formData ?? body) as any)},
        draft_step = ${body.currentStep ?? 0},
        updated_at = NOW()
      WHERE id = ${params.id}::uuid AND user_key_id = ${auth.userId} AND status = 'draft'
      RETURNING id, status, draft_payload, draft_step, updated_at
    `;
      if (!request)
        throw new HttpError(404, "draft_not_found", "Draft request not found");
      return ok({ data: toCamel(request), message: "Draft saved" });
    },
    {
      body: t.Object({
        currentStep: t.Optional(t.Number()),
        formData: t.Optional(t.Record(t.String(), t.Any())),
      }),
    },
  )
  .post(
    "/client/requests/:id/payment-proof",
    async ({ headers, set }) => {
      await resolveAuth(headers);
      set.status = 410;
      return fail(
        "Manual payment proof is no longer accepted. Use verified Paystack checkout.",
        "paystack_checkout_required",
      );
    },
  )
  .post(
    "/client/requests/:id/payments",
    async ({ headers, set }) => {
      await resolveAuth(headers);
      set.status = 410;
      return fail(
        "Manual payment submission is no longer accepted. Use verified Paystack checkout.",
        "paystack_checkout_required",
      );
    },
  )
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
  .post(
    "/client/requests/:id/paystack/mobile-money",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const paymentType = body.paymentType ?? "full_payment";
      if (!["deposit", "final_balance", "full_payment"].includes(paymentType)) {
        throw new HttpError(
          400,
          "invalid_payment_type",
          "Payment type must be deposit, final_balance, or full_payment",
        );
      }

      const phone = paystackService.normalizeMobileMoneyPhone(String(body.phone ?? ""));
      if (!phone || phone.length < 9) {
        throw new HttpError(
          400,
          "invalid_mobile_money_phone",
          "Enter a valid mobile money phone number",
        );
      }
      const provider = paystackService.normalizeProvider(body.provider);
      const phoneHash = paystackService.hashMobileMoneyPhone(phone);
      const allowBeforePreviewPayment = body.allowBeforePreviewPayment === true;

      const [supportRequest] = await db`
        SELECT r.*, c.email
        FROM support_requests r
        LEFT JOIN support_clients c ON c.id = r.client_id
        WHERE r.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
        LIMIT 1
      `;
      if (!supportRequest) {
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      }

      const policy = (supportRequest.payment_policy ?? {}) as Record<string, any>;
      const paymentStatus = String(supportRequest.payment_status ?? "unpaid");
      if (paymentStatus === "paid") {
        throw new HttpError(409, "payment_already_complete", "This request is already fully paid");
      }
      if (paymentType === "deposit" && policy.previewUnlock === "full_payment") {
        throw new HttpError(
          409,
          "full_payment_required",
          "This request requires full payment to unlock the protected preview",
        );
      }
      if (paymentType === "deposit" && paymentStatus === "deposit_paid") {
        throw new HttpError(409, "deposit_already_paid", "The deposit has already been verified");
      }
      if (
        String(supportRequest.preview_status ?? "not_started") !== "ready" &&
        String(policy.workStartRequirement ?? "none") === "none" &&
        !allowBeforePreviewPayment
      ) {
        throw new HttpError(
          409,
          "PREVIEW_NOT_READY",
          "The free protected preview must be ready before payment begins",
        );
      }

      const amount = paymentAmountForType(supportRequest, paymentType);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(
          400,
          "invalid_payment_amount",
          "Payment amount must be greater than zero",
        );
      }
      if (body.amount !== undefined && Math.abs(body.amount - amount) > 0.01) {
        throw new HttpError(
          400,
          "payment_amount_mismatch",
          "The payment amount must match the amount currently due",
        );
      }

      const pendingPayments = await db`
        SELECT p.*, r.payment_status AS request_payment_status, r.deposit_amount, r.final_amount,
          r.payment_amount, r.quoted_amount,
          t.metadata AS transaction_metadata,
          t.metadata->>'mobileMoneyProvider' AS pending_provider,
          t.metadata->>'phoneHash' AS pending_phone_hash,
          t.metadata->>'pendingStep' AS pending_step,
          GREATEST(
            0,
            ${MOBILE_MONEY_ATTEMPT_TTL_SECONDS} - FLOOR(EXTRACT(EPOCH FROM (NOW() - p.created_at)))
          )::int AS expires_in_seconds
        FROM support_payments p
        INNER JOIN support_requests r ON r.id = p.request_id
        LEFT JOIN paystack_transactions t
          ON t.support_payment_id = p.id
          OR (
            t.support_request_id = p.request_id
            AND t.provider_reference = COALESCE(p.provider_reference, p.transaction_id)
          )
        WHERE p.request_id = ${supportRequest.id}
          AND p.user_key_id = ${auth.userId}
          AND p.payment_type = ${paymentType}
          AND p.provider = 'paystack'
          AND p.status = 'paystack_pending'
          AND p.verified_at IS NULL
          AND p.created_at > NOW() - (${MOBILE_MONEY_ATTEMPT_TTL_SECONDS} || ' seconds')::interval
        ORDER BY p.created_at DESC
      `;
      const [pendingPayment] = pendingPayments.filter((payment) => {
        const pendingProvider = String(payment.pending_provider ?? "");
        const pendingPhoneHash = String(payment.pending_phone_hash ?? "");
        return pendingProvider === provider && pendingPhoneHash === phoneHash;
      });
      if (pendingPayment) {
        const reference = String(pendingPayment.provider_reference ?? pendingPayment.transaction_id);
        const pendingStep =
          String(pendingPayment.pending_step ?? "") === "otp" ? "otp" : "phone_authorization";
        const expiresInSeconds = Math.max(
          1,
          Number(pendingPayment.expires_in_seconds ?? MOBILE_MONEY_ATTEMPT_TTL_SECONDS),
        );
        return ok({
          data: toCamel(pendingPayment),
          request: toCamel(supportRequest),
          reference,
          reused: true,
          expiresInSeconds,
          pendingStep,
          phoneLast4: phone.slice(-4),
          provider,
          chargeStatus: pendingStep === "otp" ? "send_otp" : "pay_offline",
          paystack: {
            status: true,
            message: "Mobile money authorization is already pending",
            data: {
              reference,
              status: pendingStep === "otp" ? "send_otp" : "pay_offline",
              display_text:
                pendingStep === "otp"
                  ? "Enter the OTP sent to your phone."
                  : "Approve the payment prompt on your phone.",
            },
          },
          message: "Mobile money authorization is already pending",
        });
      }

      const stalePendingPayments = pendingPayments.filter((payment) => {
        const pendingProvider = String(payment.pending_provider ?? "");
        const pendingPhoneHash = String(payment.pending_phone_hash ?? "");
        return pendingProvider !== provider || pendingPhoneHash !== phoneHash;
      });
      if (stalePendingPayments.length > 0) {
        await db.begin(async (tx) => {
          for (const stalePayment of stalePendingPayments) {
            const staleReference = String(
              stalePayment.provider_reference ?? stalePayment.transaction_id,
            );
            await tx`
              UPDATE support_payments
              SET status = 'cancelled',
                updated_at = NOW()
              WHERE id = ${stalePayment.id}
                AND status = 'paystack_pending'
                AND verified_at IS NULL
            `;
            await tx`
              UPDATE paystack_transactions
              SET status = 'cancelled',
                metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({
              cancelledAt: new Date().toISOString(),
              cancelledBy: auth.userId,
              cancelReason: "mobile_money_attempt_replaced",
              replacedByProvider: provider,
              replacedByPhoneLast4: phone.slice(-4),
            })}::jsonb,
                updated_at = NOW()
              WHERE provider_reference = ${staleReference}
                AND support_request_id = ${supportRequest.id}
                AND status <> 'success'
            `;
          }
          await tx`
            UPDATE support_requests
            SET payment_status = ${retryablePaymentStatusAfterCancel(paymentType, supportRequest)},
              payment_notes = 'Previous mobile money authorization cancelled before starting a new one.',
              payment_transaction_id = NULL,
              updated_at = NOW()
            WHERE id = ${supportRequest.id}
              AND user_key_id = ${auth.userId}
              AND payment_status IN ('pending', 'paystack_pending', 'deposit_pending_verification', 'final_payment_pending_verification')
          `;
        });
      }

      const reference = paystackService.createReference(
        String(supportRequest.task_id ?? supportRequest.id),
      );
      console.info("[support:paystack.mobile_money] initializing", {
        requestId: String(supportRequest.id),
        taskId: String(supportRequest.task_id ?? ""),
        userId: auth.userId,
        paymentType,
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        provider,
      });

      const metadata = {
        requestId: String(supportRequest.id),
        taskId: String(supportRequest.task_id ?? ""),
        userId: auth.userId,
        paymentType,
        method: "mobile_money",
        mobileMoneyProvider: provider,
      };
      const paystack = await paystackService.chargeMobileMoney({
        email: String(supportRequest.email ?? auth.email),
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        phone,
        provider,
        reference,
        metadata,
      });
      const chargeData = (paystack.data as Record<string, unknown>) ?? {};
      const chargeStatus = String(chargeData.status ?? "");
      const displayText = String((chargeData as any).display_text ?? paystack.message ?? "");
      const pendingStep = chargeStatus === "send_otp" ? "otp" : "phone_authorization";

      const [payment] = await db`
        INSERT INTO support_payments (
          request_id, user_key_id, payment_type, amount, currency, transaction_id,
          provider, provider_reference, status
        )
        VALUES (
          ${supportRequest.id}, ${auth.userId}, ${paymentType}, ${amount},
          ${String(supportRequest.currency ?? "GHS")}, ${reference},
          'paystack', ${reference}, 'paystack_pending'
        )
        RETURNING *
      `;
      await db`
        INSERT INTO paystack_transactions (
          workspace_id, support_request_id, support_payment_id, user_key_id, purpose,
          amount, currency, provider_reference, status, metadata
        )
        VALUES (
          ${supportRequest.workspace_id ?? null}, ${supportRequest.id}, ${payment.id}, ${auth.userId},
          'support_payment', ${amount}, ${String(supportRequest.currency ?? "GHS")},
          ${reference}, 'pending', ${db.json({
        ...metadata,
        phoneLast4: phone.slice(-4),
        phoneHash,
        pendingStep,
      })}
        )
        ON CONFLICT (provider, provider_reference) DO NOTHING
      `;
      const [updated] = await db`
        UPDATE support_requests
        SET payment_transaction_id = ${reference},
          payment_status = ${paymentType === "final_balance" ? "final_payment_pending_verification" : "pending"},
          payment_notes = 'Mobile money authorization sent',
          updated_at = NOW()
        WHERE id = ${supportRequest.id}
        RETURNING *
      `;

      await addSupportEvent(
        updated.id,
        auth,
        "payment.paystack_mobile_money_initialized",
        "Mobile money authorization sent",
        {
          paymentId: payment.id,
          paymentType,
          reference,
          amount,
          provider,
        },
      );
      await invalidateSupportCache(auth.userId);

      console.info("[support:paystack.mobile_money] Charge response", {
        requestId: String(supportRequest.id),
        reference,
        status: chargeStatus,
        displayText,
        provider,
      });

      return ok({
        data: toCamel(payment),
        request: toCamel(updated),
        reference,
        reused: false,
        expiresInSeconds: MOBILE_MONEY_ATTEMPT_TTL_SECONDS,
        pendingStep,
        phoneLast4: phone.slice(-4),
        provider,
        paystack,
        chargeStatus,
        message: displayText || "Approve the payment prompt on your phone.",
      });
    },
    {
      body: t.Object({
        paymentType: t.Optional(t.String()),
        amount: t.Optional(t.Number()),
        phone: t.String(),
        provider: t.String(),
        idempotencyKey: t.Optional(t.String()),
        allowBeforePreviewPayment: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/checkout",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const paymentType = body.paymentType ?? "full_payment";
      const allowBeforePreviewPayment = body.allowBeforePreviewPayment === true;
      if (!["deposit", "final_balance", "full_payment"].includes(paymentType)) {
        throw new HttpError(
          400,
          "invalid_payment_type",
          "Payment type must be deposit, final_balance, or full_payment",
        );
      }
      const [supportRequest] = await db`
      SELECT r.*, c.email
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      WHERE r.id = ${params.id}::uuid AND r.user_key_id = ${auth.userId}
      LIMIT 1
    `;
      if (!supportRequest)
        throw new HttpError(
          404,
          "request_not_found",
          "Support request not found",
        );
      const policy = (supportRequest.payment_policy ?? {}) as Record<string, any>;
      const paymentStatus = String(supportRequest.payment_status ?? "unpaid");
      if (paymentStatus === "paid") {
        throw new HttpError(409, "payment_already_complete", "This request is already fully paid");
      }
      if (paymentType === "deposit" && policy.previewUnlock === "full_payment") {
        throw new HttpError(
          409,
          "full_payment_required",
          "This request requires full payment to unlock the protected preview",
        );
      }
      if (paymentType === "deposit" && paymentStatus === "deposit_paid") {
        throw new HttpError(409, "deposit_already_paid", "The deposit has already been verified");
      }
      if (
        String(supportRequest.preview_status ?? "not_started") !== "ready" &&
        String(policy.workStartRequirement ?? "none") === "none" &&
        !allowBeforePreviewPayment
      ) {
        throw new HttpError(
          409,
          "PREVIEW_NOT_READY",
          "The free protected preview must be ready before payment begins",
        );
      }

      const amount = paymentAmountForType(supportRequest, paymentType);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(
          400,
          "invalid_payment_amount",
          "Payment amount must be greater than zero",
        );
      }
      if (body.amount !== undefined && Math.abs(body.amount - amount) > 0.01) {
        throw new HttpError(
          400,
          "payment_amount_mismatch",
          "The payment amount must match the amount currently due",
        );
      }

      const reference = paystackService.createReference(
        String(supportRequest.task_id ?? supportRequest.id),
      );
      const callbackUrl = normalizePublicCallbackUrl(body.callbackUrl);
      console.info("[support:paystack.checkout] initializing", {
        requestId: String(supportRequest.id),
        taskId: String(supportRequest.task_id ?? ""),
        userId: auth.userId,
        paymentType,
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        currentStatus: String(supportRequest.status ?? ""),
        currentPaymentStatus: String(supportRequest.payment_status ?? ""),
        callbackOrigin: (() => {
          try {
            return new URL(callbackUrl).origin;
          } catch {
            return "";
          }
        })(),
      });
      const paystack = await paystackService.initializeCheckout({
        email: String(supportRequest.email ?? auth.email),
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        reference,
        channels: body.channels,
        callbackUrl,
        metadata: {
          requestId: String(supportRequest.id),
          taskId: String(supportRequest.task_id ?? ""),
          userId: auth.userId,
          paymentType,
          callbackUrl,
        },
      });

      const [payment] = await db`
      INSERT INTO support_payments (
        request_id, user_key_id, payment_type, amount, currency, transaction_id,
        provider, provider_reference, status
      )
      VALUES (
        ${supportRequest.id}, ${auth.userId}, ${paymentType}, ${amount},
        ${String(supportRequest.currency ?? "GHS")}, ${reference},
        'paystack', ${reference}, 'paystack_pending'
      )
      RETURNING *
    `;
      await db`
      INSERT INTO paystack_transactions (
        workspace_id, support_request_id, support_payment_id, user_key_id, purpose,
        amount, currency, provider_reference, status, metadata
      )
      VALUES (
        ${supportRequest.workspace_id ?? null}, ${supportRequest.id}, ${payment.id}, ${auth.userId},
        'support_payment', ${amount}, ${String(supportRequest.currency ?? "GHS")},
        ${reference}, 'pending', ${db.json({ paymentType, requestId: String(supportRequest.id) })}
      )
      ON CONFLICT (provider, provider_reference) DO NOTHING
    `;
      const [updated] = await db`
      UPDATE support_requests
      SET payment_transaction_id = ${reference},
        payment_status = ${paymentType === "final_balance" ? "final_payment_pending_verification" : "pending"},
        payment_notes = 'Paystack checkout initialized',
        updated_at = NOW()
      WHERE id = ${supportRequest.id}
      RETURNING *
    `;
      console.info("[support:paystack.checkout] initialized", {
        requestId: String(updated.id),
        paymentId: String(payment.id),
        userId: auth.userId,
        paymentType,
        amount,
        paymentStatus: String(updated.payment_status ?? ""),
        requestStatus: String(updated.status ?? ""),
        providerReference: reference,
        hasAuthorizationUrl: Boolean(
          (paystack.data as Record<string, unknown> | undefined)?.authorization_url,
        ),
      });

      await addSupportEvent(
        updated.id,
        auth,
        "payment.paystack_checkout_initialized",
        "Paystack checkout initialized",
        {
          paymentId: payment.id,
          paymentType,
          reference,
          amount,
        },
      );
      await invalidateSupportCache(auth.userId);
      return ok({
        data: toCamel(payment),
        request: toCamel(updated),
        paystack,
        accessCode:
          (paystack.data as Record<string, unknown> | undefined)?.access_code ??
          null,
        authorizationUrl:
          (paystack.data as Record<string, unknown> | undefined)
            ?.authorization_url ?? null,
        message: paystack.message || "Paystack checkout initialized",
      });
    },
    {
      body: t.Object({
        paymentType: t.Optional(t.String()),
        amount: t.Optional(t.Number()),
        callbackUrl: t.Optional(t.String()),
        allowBeforePreviewPayment: t.Optional(t.Boolean()),
        channels: t.Optional(
          t.Array(
            t.Union([
              t.Literal("card"),
              t.Literal("bank"),
              t.Literal("ussd"),
              t.Literal("qr"),
              t.Literal("mobile_money"),
              t.Literal("bank_transfer"),
              t.Literal("eft"),
            ]),
          ),
        ),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/submit-otp",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const reference = String(body.reference ?? "").trim();
      const otp = String(body.otp ?? "").trim();

      if (!reference) {
        throw new HttpError(400, "reference_required", "Payment reference is required");
      }
      if (!otp || otp.length < 4) {
        throw new HttpError(400, "invalid_otp", "Enter the OTP sent to your phone");
      }

      const [payment] = await db`
        SELECT p.*, r.currency, r.payment_status
        FROM support_payments p
        INNER JOIN support_requests r ON r.id = p.request_id
        WHERE p.request_id = ${params.id}::uuid
          AND r.user_key_id = ${auth.userId}
          AND COALESCE(p.provider_reference, p.transaction_id) = ${reference}
        ORDER BY p.created_at DESC
        LIMIT 1
      `;

      if (!payment) {
        throw new HttpError(404, "payment_not_found", "Payment not found");
      }

      console.info("[support:paystack.submit_otp] Submitting OTP", {
        requestId: params.id,
        reference,
        userId: auth.userId,
      });

      try {
        const result = await paystackService.submitOtp({
          reference,
          otp,
        });

        const chargeData = (result.data as Record<string, unknown>) ?? {};
        const chargeStatus = String(chargeData.status ?? "");
        const displayText = String((chargeData as any).display_text ?? "");

        console.info("[support:paystack.submit_otp] Response", {
          requestId: params.id,
          reference,
          status: chargeStatus,
          displayText,
          message: result.message,
        });

        // After OTP submission, Paystack automatically sends PIN prompt to customer's phone
        // The status will be "pending" or "pay_offline" while waiting for PIN entry on phone
        if (chargeStatus === "pending" || chargeStatus === "pay_offline" || chargeStatus === "send_pin") {
          return ok({
            data: toCamel(payment),
            paystack: result,
            status: "awaiting_pin_on_phone",
            message: displayText || "OTP accepted. Complete the PIN authorization on your phone.",
          });
        }

        // Check if payment completed successfully
        if (chargeStatus === "success") {
          const confirmResult = await confirmSupportPaystackPayment({
            reference,
            auth,
            requestId: params.id,
          });
          await invalidateSupportCache(auth.userId);
          return ok({
            data: toCamel(payment),
            paystack: result,
            verified: confirmResult.verified,
            message: "Payment successful",
          });
        }

        // Failed or unknown status
        return ok({
          data: toCamel(payment),
          paystack: result,
          status: chargeStatus,
          message: result.message || displayText || "Processing payment. Check your phone.",
        });
      } catch (error) {
        console.error("[support:paystack.submit_otp] Error", {
          requestId: params.id,
          reference,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    {
      body: t.Object({
        reference: t.String(),
        otp: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/verify",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reference = body.reference.trim();
      const result = await confirmSupportPaystackPayment({
        reference,
        auth,
        requestId: params.id,
      });
      await invalidateSupportCache(auth.userId);
      return ok({
        ...result,
        message: result.verified
          ? "Paystack payment verified"
          : "Payment is not successful yet",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/cancel",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const reference = String(body.reference ?? "").trim();
      if (!reference) {
        throw new HttpError(400, "payment_reference_required", "Payment reference is required");
      }

      const [payment] = await db`
        SELECT p.*, r.payment_status AS request_payment_status, r.deposit_amount, r.final_amount,
          r.payment_amount, r.quoted_amount
        FROM support_payments p
        INNER JOIN support_requests r ON r.id = p.request_id
        WHERE p.request_id = ${params.id}::uuid
          AND r.user_key_id = ${auth.userId}
          AND COALESCE(p.provider_reference, p.transaction_id) = ${reference}
        ORDER BY p.created_at DESC
        LIMIT 1
      `;
      if (!payment) {
        throw new HttpError(404, "payment_not_found", "Payment checkout was not found");
      }
      if (String(payment.status ?? "") === "verified" || payment.verified_at) {
        throw new HttpError(409, "payment_already_verified", "This payment has already been verified");
      }

      const resetStatus = retryablePaymentStatusAfterCancel(String(payment.payment_type ?? ""), payment);
      const [updatedPayment, updatedRequest] = await db.begin(async (tx) => {
        const [nextPayment] = await tx`
          UPDATE support_payments
          SET status = 'cancelled',
            updated_at = NOW()
          WHERE id = ${payment.id}
            AND status NOT IN ('verified', 'refunded', 'refund_pending')
          RETURNING *
        `;
        const [nextRequest] = await tx`
          UPDATE support_requests
          SET payment_status = ${resetStatus},
            payment_notes = 'Payment checkout cancelled. User can retry.',
            payment_transaction_id = NULL,
            updated_at = NOW()
          WHERE id = ${params.id}::uuid
            AND user_key_id = ${auth.userId}
            AND payment_status IN ('pending', 'paystack_pending', 'deposit_pending_verification', 'final_payment_pending_verification', 'deposit_paid')
          RETURNING *
        `;
        await tx`
          UPDATE paystack_transactions
          SET status = 'cancelled',
            metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({ cancelledAt: new Date().toISOString(), cancelledBy: auth.userId })}::jsonb,
            updated_at = NOW()
          WHERE provider_reference = ${reference}
            AND support_request_id = ${params.id}::uuid
            AND status <> 'success'
        `;
        return [nextPayment, nextRequest];
      });

      await addSupportEvent(
        params.id,
        auth,
        "payment.paystack_checkout_cancelled",
        "Paystack checkout cancelled",
        {
          paymentId: payment.id,
          paymentType: payment.payment_type,
          reference,
          resetStatus,
        },
      );
      await invalidateSupportCache(auth.userId);
      await invalidateProviderSupportCache();
      return ok({
        data: toCamel(updatedPayment ?? payment),
        request: updatedRequest ? toCamel(updatedRequest) : null,
        message: "Payment checkout cancelled. You can try again.",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/refund-requests",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const db = getDb();
      const [payment] = await db`
      SELECT p.*, r.status AS request_status, r.delivery_status, r.payment_status,
        r.user_key_id AS request_user_key_id, r.title AS request_title
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      WHERE p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
        AND p.status = 'verified'
      ORDER BY p.verified_at DESC NULLS LAST, p.created_at DESC
      LIMIT 1
    `;
      if (!payment) {
        throw new HttpError(
          404,
          "payment_not_found",
          "No verified payment was found for this request",
        );
      }

      const enrichedRequest = {
        status: payment.request_status,
        delivery_status: payment.delivery_status,
        refund_reason_category: body.reasonCategory,
      };
      const eligibility = refundEligibilityForRequest(enrichedRequest, payment);
      if (!eligibility.eligible) {
        throw new HttpError(409, "refund_not_eligible", eligibility.reason);
      }

      const paidAmount = Number(payment.amount ?? 0);
      const requestedAmount =
        body.refundType === "partial"
          ? roundMoney(
            Math.min(Number(body.requestedAmount ?? paidAmount), paidAmount),
          )
          : paidAmount;
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        throw new HttpError(
          400,
          "invalid_refund_amount",
          "Refund amount must be greater than zero",
        );
      }

      const [refund] = await db`
      INSERT INTO support_refund_requests (
        request_id, payment_id, user_key_id, refund_type, requested_amount,
        reason, reason_category, user_evidence
      )
      VALUES (
        ${params.id}::uuid, ${payment.id}, ${auth.userId}, ${body.refundType ?? "full"},
        ${requestedAmount}, ${body.reason.trim()}, ${body.reasonCategory ?? "other"},
        ${db.json(body.userEvidence ?? [])}
      )
      RETURNING *
    `;
      await db`
      UPDATE support_payments
      SET refund_status = 'requested',
        refund_amount = ${requestedAmount},
        updated_at = NOW()
      WHERE id = ${payment.id}
    `;
      await addSupportEvent(
        params.id,
        auth,
        "payment.refund_requested",
        "Refund review requested",
        {
          refundId: refund.id,
          paymentId: payment.id,
          refundType: refund.refund_type,
          requestedAmount,
          reasonCategory: refund.reason_category,
        },
      );
      await invalidateSupportCache(auth.userId);
      return ok({ data: toCamel(refund), message: "Refund review requested" });
    },
    {
      body: t.Object({
        refundType: t.Optional(
          t.Union([t.Literal("full"), t.Literal("partial")]),
        ),
        requestedAmount: t.Optional(t.Number()),
        reason: t.String({ minLength: 12 }),
        reasonCategory: t.Optional(
          t.Union([
            t.Literal("quality_issue"),
            t.Literal("scope_mismatch"),
            t.Literal("non_delivery"),
            t.Literal("cancellation"),
            t.Literal("other"),
          ]),
        ),
        userEvidence: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/check",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reference = body.reference.trim();
      const [payment] = await getDb()`
      SELECT p.*
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      WHERE p.transaction_id = ${reference}
        AND p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
      if (!payment)
        throw new HttpError(
          404,
          "payment_not_found",
          "Paystack payment was not found",
        );
      const paystack = await paystackService.checkCharge(reference);
      const chargeData = (paystack.data ?? {}) as Record<string, any>;
      const chargeStatus = String(chargeData.status ?? "").toLowerCase();
      if (chargeStatus === "success") {
        const result = await confirmSupportPaystackPayment({
          reference,
          auth,
          requestId: params.id,
        });
        await invalidateSupportCache(auth.userId);
        return ok({
          ...result,
          chargeStatus,
          message: "Payment successful",
        });
      }
      return ok({
        data: toCamel(payment),
        paystack,
        verified: false,
        chargeStatus,
        message: paystack.message || "Charge status checked",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
      }),
    },
  )
  .post(
    "/client/requests/:id/paystack/submit-pin",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const reference = body.reference.trim();
      const [payment] = await getDb()`
      SELECT p.*
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      WHERE p.transaction_id = ${reference}
        AND p.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
      if (!payment)
        throw new HttpError(
          404,
          "payment_not_found",
          "Paystack payment was not found",
        );
      const paystack = await paystackService.submitPin({
        reference,
        pin: body.pin.trim(),
      });
      return ok({
        data: toCamel(payment),
        paystack,
        message: paystack.message || "PIN submitted",
      });
    },
    {
      body: t.Object({
        reference: t.String(),
        pin: t.String(),
      }),
    },
  )
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
      const [row] = await db`
        INSERT INTO support_files (
          request_id, milestone_id, user_key_id, file_name, file_url, file_type, file_size, content_base64, purpose, submission_round, is_voice_note, duration_seconds
        )
        VALUES (
          ${requestId}, NULLIF(${milestoneId}, '')::uuid, ${targetUserId}, ${file.name}, '', ${file.type || "application/octet-stream"},
          ${file.size}, ${buffer.toString("base64")}, ${filePurpose}, ${milestoneId ? fileSubmissionRound : 1},
          ${isVoiceNote}, ${voiceNoteDuration ? Number(voiceNoteDuration) || null : null}
        )
        RETURNING *
      `;
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
      const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
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
      const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
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
      const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
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
  .get(
    "/client/orders",
    async ({ headers, query }) => {
      const auth = await resolveAuth(headers);
      const status = String(query.status ?? "").trim();
      const rows = await getDb()`
      SELECT o.*, r.title AS request_title
      FROM support_orders o
      INNER JOIN support_requests r ON r.id = o.request_id
      WHERE o.client_key_id = ${auth.userId}
        AND (${status || null}::text IS NULL OR o.status = ${status || null})
      ORDER BY o.updated_at DESC
      LIMIT 100
    `;
      return ok({ data: rows.map(toCamel) });
    },
    {
      query: t.Object({ status: t.Optional(t.String()) }),
    },
  )
  .get("/client/orders/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const [order] = await getDb()`
      SELECT o.*, r.title AS request_title
      FROM support_orders o
      INNER JOIN support_requests r ON r.id = o.request_id
      WHERE o.id = ${params.id}::uuid AND o.client_key_id = ${auth.userId}
      LIMIT 1
    `;
    if (!order) throw new HttpError(404, "order_not_found", "Order not found");
    return ok({ data: toCamel(order) });
  })
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
      const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
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
    const { getMilestoneHistory } = await import("./shared");
    const history = await getMilestoneHistory(String(params.milestoneId));
    return ok({ data: history });
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
        const { broadcastSupportMessage } = await import("../support-messages/realtime");
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
            const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
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
  .get("/client/requests/:id/events", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const events = await db`
      SELECT e.id, e.event_type AS type, e.message AS description,
             e.actor_id AS "userId", e.actor_role AS "userName",
             e.metadata, e.created_at
      FROM support_events e
      JOIN support_requests r ON r.id = e.request_id
      WHERE r.user_key_id = ${auth.userId}
        AND r.id = ${params.id}::uuid
      ORDER BY e.created_at DESC
      LIMIT 50
    `;
    return ok({ data: events.map(toCamel) });
  })
  .get("/client/requests/:id/history", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const rows = await getDb()`
      SELECT v.id, v.request_id, v.version_number, v.snapshot_payload,
        v.changed_by, v.changed_at, v.change_reason
      FROM support_request_versions v
      INNER JOIN support_requests r ON r.id = v.request_id
      WHERE v.request_id = ${params.id}::uuid
        AND r.user_key_id = ${auth.userId}
      ORDER BY v.version_number DESC
      LIMIT 50
    `;
    return ok({ data: rows.map(toCamel) });
  });
