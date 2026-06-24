import { t } from "elysia";

import { cache } from "../../lib/cache";
import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { n8nService } from "../../lib/n8n";
import { paystackService } from "../../lib/paystack";
import { uploadSupportFile, uploadthingConfigured } from "../../lib/uploadthing";
import {
  normalizeWhatsAppNumber,
  sendWhatsAppNotification,
  twilioWhatsAppConfigured,
} from "../../lib/twilio-whatsapp";
import { auditRepository } from "../audit/repository";
import { notificationsRepository } from "../notifications/repository";
import { requirePermission, resolveAuth, type AuthContext } from "../auth/middleware";
import { normalizeRole } from "../auth/policy";
import { workspaceService } from "../workspace/service";

let warnedUploadThingFallback = false;

const nullableString = t.Optional(t.Union([t.String(), t.Null()]));
const nullableNumber = t.Optional(t.Union([t.Number(), t.Null()]));
const nullableBoolean = t.Optional(t.Union([t.Boolean(), t.Null()]));
const nullableStringArray = t.Optional(t.Union([t.Array(t.String()), t.Null()]));

export const requestBody = t.Object({
  title: t.String(),
  description: nullableString,
  serviceTags: nullableStringArray,
  serviceCategory: nullableString,
  subServices: nullableStringArray,
  subject: nullableString,
  academicLevel: nullableString,
  outputExpectation: nullableString,
  deadlineAt: nullableString,
  timezone: nullableString,
  budgetMin: nullableNumber,
  budgetMax: nullableNumber,
  currency: nullableString,
  workspaceId: nullableString,
  paymentMode: nullableString,
  paymentMethod: nullableString,
  preferredPaymentMode: nullableString,
  wordCount: nullableNumber,
  pages: nullableNumber,
  attachmentMetadata: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
  integrityAck: nullableBoolean,
  contactConsent: nullableBoolean,
  currentStep: nullableNumber,
  fullName: nullableString,
  institution: nullableString,
  whatsappNumber: nullableString,
  supervisorComments: nullableString,
  userNotes: nullableString,
  referralCode: nullableString,
  discountCode: nullableString,
  depositPercent: nullableNumber,
  scopeType: nullableString,
  selectedChapters: nullableStringArray,
  dataCollectionOwner: nullableString,
  analysisOwner: nullableString,
  includeSlides: nullableBoolean,
  slideCount: nullableNumber,
  assistance24x7: nullableBoolean,
  correctionMode: nullableBoolean,
  correctionCommentCount: nullableNumber,
  assignmentInstructions: nullableString,
  costEstimate: t.Optional(t.Any()),
}, {
  additionalProperties: true,
});

const SERVICE_STARTING_PRICES: Record<string, number> = {
  "research-diagnostic": 30,
  "proposal-review": 120,
  "chapter-editing": 180,
  "literature-methodology": 160,
  "citation-integrity": 90,
  "supervisor-comments": 100,
  "data-analysis": 250,
  "questionnaire-survey": 140,
  "thesis-formatting": 120,
  "powerpoint-preparation": 100,
  "excel-dashboard": 180,
  "full-project-support": 500,
  "free-diagnostic": 30,
  "assignment": 10,
};

const DEFAULT_SUPPORT_TIMEZONE = "Africa/Accra";
const LAUNCH_DISCOUNT_RATE = 0.5;
export const PROVIDER_DASHBOARD_CACHE_SECONDS = 30;
const LOCKED_CLIENT_EDIT_PAYMENT_STATUSES = new Set([
  "pending",
  "paystack_pending",
  "deposit_pending_verification",
  "deposit_paid",
  "final_payment_required",
  "final_payment_pending_verification",
  "paid",
  "refunded",
]);

type MemoryCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const supportMemoryCache = new Map<string, MemoryCacheEntry<unknown>>();

export async function rememberSupportJson<T>(name: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  if (cache.isConfigured()) {
    return cache.rememberJson(name, ttlSeconds, loader);
  }

  const now = Date.now();
  const cached = supportMemoryCache.get(name) as MemoryCacheEntry<T> | undefined;
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await loader();
  supportMemoryCache.set(name, {
    expiresAt: now + ttlSeconds * 1000,
    value,
  });
  return value;
}

export function toCamel(row: Record<string, any>) {
  const camel = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
      value,
    ]),
  );
  if ("deadlineAt" in camel && !("deadline" in camel)) {
    camel.deadline = camel.deadlineAt;
  }
  if ("userKeyId" in camel && !("userId" in camel)) {
    camel.userId = camel.userKeyId;
  }
  if ("clientKeyId" in camel && !("clientId" in camel)) {
    camel.clientId = camel.clientKeyId;
  }
  if ("providerKeyId" in camel && !("providerId" in camel)) {
    camel.providerId = camel.providerKeyId;
  }
  if ("quoteType" in camel && !("type" in camel)) {
    camel.type = camel.quoteType;
  }
  if ("amountPaid" in camel && !("amount" in camel)) {
    camel.amount = camel.amountPaid;
  }
  return camel;
}

export function cleanSupportWhatsAppNumber(value: unknown) {
  const str = String(value ?? "").trim();
  if (!str) return "";

  const digits = str.replace(/\D/g, "");
  let local = digits;

  if (local.startsWith("2330")) {
    local = local.slice(4);
  } else if (local.startsWith("233")) {
    local = local.slice(3);
  } else if (local.startsWith("0")) {
    local = local.slice(1);
  }

  return local ? `+233${local.slice(0, 9)}` : "";
}

export function assertSupportWhatsAppNumber(value: unknown) {
  const phone = cleanSupportWhatsAppNumber(value);
  if (!phone) {
    throw new HttpError(
      400,
      "whatsapp_required",
      "WhatsApp number is required so CogniZap can send request and file updates.",
    );
  }
  if (!/^\+233\d{9}$/.test(phone)) {
    throw new HttpError(
      400,
      "invalid_whatsapp_number",
      "Enter a valid Ghana WhatsApp number, for example 024XXXXXXX or +23324XXXXXXX.",
    );
  }
  return phone;
}

function buildReferralCode(userKeyId: string) {
  const shortKey = userKeyId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase();
  return `REG-CLIENT-${shortKey || "000001"}`;
}

export async function ensureClient(auth: AuthContext, body?: Record<string, any>) {
  const whatsappNumber = body?.whatsappNumber
    ? cleanSupportWhatsAppNumber(body.whatsappNumber)
    : "";
  const [client] = await getDb()`
    INSERT INTO support_clients (
      user_key_id, email, full_name, whatsapp_number, institution, level, referral_code
    )
    VALUES (
      ${auth.userId},
      ${auth.email},
      ${String(body?.fullName ?? auth.email).trim()},
      ${whatsappNumber},
      ${String(body?.institution ?? "").trim()},
      ${String(body?.academicLevel ?? "").trim()},
      ${buildReferralCode(auth.userId)}
    )
    ON CONFLICT (user_key_id) DO UPDATE
    SET
      email = EXCLUDED.email,
      full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), support_clients.full_name),
      whatsapp_number = COALESCE(NULLIF(EXCLUDED.whatsapp_number, ''), support_clients.whatsapp_number),
      institution = COALESCE(NULLIF(EXCLUDED.institution, ''), support_clients.institution),
      level = COALESCE(NULLIF(EXCLUDED.level, ''), support_clients.level),
      updated_at = NOW()
    RETURNING *
  `;
  return client;
}

export function generateTaskId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `CZ-RS-${timestamp}-${suffix}`;
}

export function canSeeProvider(auth: AuthContext) {
  const role = normalizeRole(auth.role);
  return (
    role === "ADMIN_USER" ||
    role === "SUPPORT_PROVIDER_USER" ||
    auth.permissions.includes("support.tickets.respond") ||
    auth.permissions.includes("support.users.inspect")
  );
}

export function calculatePaymentAmount(body: Record<string, any>) {
  const serviceTags = Array.isArray(body.serviceTags) ? body.serviceTags.map(String) : [];
  if (serviceTags.includes("assignment") || body.serviceCategory === "assignment") return 10;

  const pricedTags = serviceTags.filter((tag) => SERVICE_STARTING_PRICES[tag] !== undefined);
  if (pricedTags.length > 0) {
    const basePrice = pricedTags.reduce((sum, tag) => sum + (SERVICE_STARTING_PRICES[tag] ?? 0), 0);
    const discount = roundMoney(basePrice * LAUNCH_DISCOUNT_RATE);
    return Math.max(0, roundMoney(basePrice - discount));
  }

  const estimate = body.costEstimate && typeof body.costEstimate === "object" ? body.costEstimate : null;
  if (estimate !== null) {
    const hasExplicitTotal = "total" in estimate || "min" in estimate || ("range" in estimate && estimate.range);
    const estimateTotal = Number(estimate.total ?? estimate.range?.min ?? estimate.min ?? 0);
    if (Number.isFinite(estimateTotal) && estimateTotal > 0) {
      return roundMoney(estimateTotal);
    }
    if (hasExplicitTotal && estimateTotal === 0) {
      return 0;
    }
  }
  return 0;
}

export function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function buildPaymentSchedule(body: Record<string, any>) {
  const paymentAmount = roundMoney(calculatePaymentAmount(body));
  const depositPercent = paymentAmount > 0 ? 100 : 0;
  const depositAmount = paymentAmount;
  const balanceAmount = 0;
  return { paymentAmount, depositPercent, depositAmount, balanceAmount };
}

export function assertClientRequestEditable(request: Record<string, any>) {
  const paymentStatus = String(request.payment_status ?? "unpaid");
  const status = String(request.status ?? "draft");
  const retryableDraftCheckout =
    status === "draft" &&
    [
      "pending",
      "paystack_pending",
      "deposit_pending_verification",
      "final_payment_pending_verification",
    ].includes(paymentStatus);
  if (
    (LOCKED_CLIENT_EDIT_PAYMENT_STATUSES.has(paymentStatus) && !retryableDraftCheckout) ||
    status === "submitted" ||
    status === "under_review" ||
    status === "in_progress" ||
    status === "work_ready" ||
    status === "completed" ||
    status === "closed"
  ) {
    throw new HttpError(
      409,
      "request_locked_after_payment",
      "This request cannot be edited after payment has started. Use the request chat for follow-ups or scope changes.",
      {
        paymentStatus,
        status,
      },
    );
  }
  if (status === "submitted" && paymentStatus === "unpaid") {
    throw new HttpError(
      409,
      "request_submitted_edit_locked",
      "This request has been submitted and can no longer be edited. Use the request chat for any changes.",
      {
        paymentStatus,
        status,
      },
    );
  }
}

export function buildDraftPayload(body: Record<string, any>) {
  return {
    serviceCategory: Array.isArray(body.serviceTags) ? body.serviceTags[0] ?? "" : "",
    subServices: Array.isArray(body.serviceTags) ? body.serviceTags.slice(1) : [],
    title: body.title ?? "",
    description: body.description ?? "",
    academicLevel: body.academicLevel ?? "",
    subject: body.subject ?? "",
    outputExpectation: body.outputExpectation ?? "",
    institution: body.institution ?? "",
    whatsappNumber: body.whatsappNumber ?? "",
    supervisorComments: body.supervisorComments ?? "",
    referralCode: body.referralCode ?? "",
    discountCode: body.discountCode ?? "",
    contactConsent: body.contactConsent ?? false,
    deadline: body.deadlineAt ?? null,
    timezone: DEFAULT_SUPPORT_TIMEZONE,
    budgetMin: body.budgetMin ?? null,
    budgetMax: body.budgetMax ?? null,
    currency: body.currency ?? "GHS",
    wordCount: body.wordCount ?? null,
    pages: body.pages ?? null,
    workspaceId: body.workspaceId ?? null,
    integrityAck: body.integrityAck ?? false,
    attachmentMetadata: body.attachmentMetadata ?? [],
    paymentMode: "before_work",
    paymentMethod: body.paymentMethod ?? "",
    depositPercent: 100,
    scopeType: body.scopeType ?? "",
    selectedChapters: Array.isArray(body.selectedChapters) ? body.selectedChapters : [],
    dataCollectionOwner: body.dataCollectionOwner ?? "",
    analysisOwner: body.analysisOwner ?? "",
    includeSlides: body.includeSlides ?? false,
    assistance24x7: body.assistance24x7 ?? false,
    correctionCommentCount: body.correctionCommentCount ?? null,
    assignmentInstructions: body.assignmentInstructions ?? null,
    assignment_config: body.assignment_config ?? (body.assignmentInstructions ? { instructions: body.assignmentInstructions } : null),
    costEstimate: body.costEstimate ?? null,
  };
}

export async function verifySupportWorkspaceAccess(auth: AuthContext, workspaceId: string) {
  const [workspace] = await getDb()`
    SELECT w.id
    FROM workspaces w
    LEFT JOIN workspace_members m
      ON m.workspace_id = w.id
      AND m.user_uid = ${auth.userId}
      AND m.deleted_at IS NULL
    WHERE w.id = ${workspaceId}::uuid
      AND w.deleted_at IS NULL
      AND (w.owner_uid = ${auth.userId} OR m.id IS NOT NULL)
    LIMIT 1
  `;
  if (!workspace) {
    throw new HttpError(403, "workspace_required", "Choose a workspace you can access before submitting this support request");
  }
}

export async function ensureSupportRequestWorkspace(
  auth: AuthContext,
  request: Record<string, any>,
) {
  const currentWorkspaceId = request.workspace_id ? String(request.workspace_id) : "";
  if (currentWorkspaceId) {
    await verifySupportWorkspaceAccess(auth, currentWorkspaceId);
    return request;
  }

  const workspace = await workspaceService.ensureDefaultWorkspace(
    auth.userId,
    auth.email,
    auth.email,
  );
  const [updated] = await getDb()`
    UPDATE support_requests
    SET workspace_id = ${workspace.id}::uuid,
      updated_at = NOW()
    WHERE id = ${request.id}::uuid
      AND user_key_id = ${auth.userId}
      AND workspace_id IS NULL
    RETURNING *
  `;

  return updated ?? { ...request, workspace_id: workspace.id };
}

export async function ensureSupportWorkspaceLinks(auth: AuthContext, request: Record<string, any>) {
  const workspaceId = request.workspace_id ? String(request.workspace_id) : "";
  if (!workspaceId) {
    throw new HttpError(400, "workspace_required", "Choose a workspace before submitting this support request");
  }
  await verifySupportWorkspaceAccess(auth, workspaceId);

  if (request.project_id && request.collection_id) {
    return request;
  }

  const db = getDb();
  const [project] = request.project_id
    ? await db`SELECT * FROM workspace_projects WHERE id = ${request.project_id}::uuid LIMIT 1`
    : await db`
        INSERT INTO workspace_projects (
          workspace_id, owner_uid, title, description, status, visibility,
          field_of_study, project_type, keywords, collaborators, completion_pct,
          deadline, document_count, task_count, completed_tasks, metadata
        ) VALUES (
          ${workspaceId}::uuid, ${auth.userId}, ${String(request.title ?? "Support request")},
          ${String(request.description ?? "")}, 'active', 'private',
          ${request.subject ?? null}, 'support_request',
          ${Array.isArray(request.service_tags) ? request.service_tags : []}, ARRAY[]::TEXT[], 0,
          ${request.deadline_at ?? null}, 0, 0, 0,
          ${db.json({
      source: "support_request",
      supportRequestId: String(request.id),
      taskId: String(request.task_id ?? ""),
      paymentStatus: String(request.payment_status ?? "unpaid"),
    })}
        )
        RETURNING *
      `;

  const collectionName = `${String(request.title ?? "Support request")} Files`;
  const [collection] = request.collection_id
    ? await db`SELECT * FROM workspace_collections WHERE id = ${request.collection_id}::uuid LIMIT 1`
    : await db`
        INSERT INTO workspace_collections (
          workspace_id, owner_uid, name, description, collection_type,
          parent_id, filters, sort_order, is_default, metadata
        ) VALUES (
          ${workspaceId}::uuid, ${auth.userId}, ${collectionName},
          ${`Files, uploads, and deliverables for support request ${String(request.task_id ?? request.id)}`},
          'folder', NULL, NULL, 0, FALSE,
          ${db.json({
      source: "support_request",
      supportRequestId: String(request.id),
      taskId: String(request.task_id ?? ""),
      driveFolderId: request.drive_folder_id ?? null,
      driveFolderUrl: request.drive_folder_url ?? null,
    })}
        )
        RETURNING *
      `;

  await db`
    INSERT INTO collection_items (collection_id, item_type, item_id, added_by, sort_order, metadata)
    VALUES (
      ${collection.id}, 'project', ${project.id}, ${auth.userId}, 0,
      ${db.json({ source: "support_request", supportRequestId: String(request.id) })}
    )
    ON CONFLICT DO NOTHING
  `;

  const [updated] = await db`
    UPDATE support_requests
    SET workspace_id = ${workspaceId}::uuid,
      project_id = ${project.id},
      collection_id = ${collection.id},
      updated_at = NOW()
    WHERE id = ${request.id}
    RETURNING *
  `;
  await addSupportEvent(String(request.id), auth, "workspace.linked", "Support request linked to workspace project and collection", {
    workspaceId,
    projectId: String(project.id),
    collectionId: String(collection.id),
  });
  return updated;
}

export async function createSupportNotification(
  userId: string,
  auth: AuthContext,
  title: string,
  body: string,
  metadata: Record<string, any>,
) {
  await notificationsRepository.insert({
    userId,
    type: "support.payment",
    category: "support",
    title,
    body,
    actorId: auth.userId,
    actorType: auth.actorType,
    actorKey: auth.userId,
    metadata,
  });
}

export async function addSupportEvent(
  requestId: string | null,
  auth: AuthContext,
  eventType: string,
  message: string,
  metadata: Record<string, any> = {},
) {
  await getDb()`
    INSERT INTO support_events (request_id, actor_id, actor_role, event_type, message, metadata)
    VALUES (
      ${requestId}, ${auth.userId}, ${auth.role || "client"}, ${eventType}, ${message}, ${getDb().json(metadata)}
    )
  `;
}

export async function ensureSupportMessageThread(
  requestId: string,
  userId: string,
  type = "request",
) {
  const db = getDb();
  const [inserted] = await db`
    INSERT INTO support_message_threads (request_id, user_key_id, type, last_message_at)
    SELECT ${requestId}::uuid, ${userId}, ${type}, NOW()
    WHERE NOT EXISTS (
      SELECT 1
      FROM support_message_threads
      WHERE request_id = ${requestId}::uuid
        AND user_key_id = ${userId}
    )
    RETURNING *
  `;
  if (inserted) return inserted;

  const [existing] = await db`
    SELECT *
    FROM support_message_threads
    WHERE request_id = ${requestId}::uuid
      AND user_key_id = ${userId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return existing ?? null;
}

export async function getMilestoneFiles(milestoneId: string) {
  const rows = await getDb()`
    SELECT f.id, f.request_id, f.milestone_id, f.user_key_id, f.file_name, f.file_url, f.file_type,
      f.file_size, f.purpose, f.storage_provider, f.external_file_id, f.external_file_url,
      f.external_upload_status, f.created_at, f.deleted_at, f.replaced_at, f.previous_file_name,
      r.payment_status, r.payment_policy
    FROM support_files f
    LEFT JOIN support_requests r ON r.id = f.request_id
    WHERE f.milestone_id = ${milestoneId}::uuid
    ORDER BY f.created_at DESC
  `;
  return rows.map((file) => {
    const item = toCamel(file);
    const purpose = String(item.purpose ?? "");
    const deleted = Boolean(item.deletedAt);
    const cleanFinalFile = ["admin_clean_pdf", "admin_clean_docx"].includes(purpose);
    const providerFile = purpose === "milestone_upload" || purpose === "provider_message_upload";
    return {
      ...item,
      name: item.fileName,
      label: item.fileName,
      url: deleted ? null : `/api/support/files/${item.id}/download`,
      externalUrl: null,
      externalFileId: undefined,
      externalFileUrl: undefined,
      type: item.fileType,
      size: item.fileSize,
      kind: "file",
      status: deleted ? "deleted" : item.replacedAt ? "edited" : "active",
      locked: cleanFinalFile || providerFile,
      canPreview: providerFile,
      canDownload: false,
      previousName: item.previousFileName ?? null,
    };
  });
}

export async function recordMilestoneFileEvent({
  requestId,
  milestoneId,
  fileId,
  auth,
  eventType,
  fileName,
  previousFileName,
  metadata = {},
}: {
  requestId: string;
  milestoneId?: string | null;
  fileId?: string | null;
  auth: AuthContext;
  eventType: string;
  fileName?: string | null;
  previousFileName?: string | null;
  metadata?: Record<string, any>;
}) {
  const db = getDb();
  const [table] = await db`SELECT to_regclass('app.milestone_file_events') AS regclass`;
  if (!table?.regclass) return null;
  const [event] = await db`
    INSERT INTO milestone_file_events (
      request_id, milestone_id, file_id, actor_key_id, actor_role,
      event_type, file_name, previous_file_name, metadata
    )
    VALUES (
      ${requestId}::uuid, NULLIF(${milestoneId ?? ""}, '')::uuid, NULLIF(${fileId ?? ""}, '')::uuid,
      ${auth.userId}, ${auth.role || "provider"}, ${eventType},
      ${fileName ?? null}, ${previousFileName ?? null}, ${db.json(metadata)}
    )
    RETURNING *
  `;
  return toCamel(event);
}

export async function buildMilestoneCardAttachment(
  milestone: Record<string, any>,
  requestId: string,
  latestRevision?: Record<string, any> | null,
) {
  const files = await getMilestoneFiles(String(milestone.id));
  return {
    kind: "milestone_card",
    milestoneId: milestone.id,
    requestId,
    title: milestone.title,
    description: milestone.description,
    dueAt: milestone.due_at,
    status: milestone.status,
    revisionCount: milestone.revision_count,
    revisionRequestCount: milestone.revision_count,
    fileCount: files.length,
    files,
    locked: true,
    canPreview: files.length > 0,
    canDownload: false,
    sourceOfTruth: "request_milestones",
    userFeedback: milestone.user_feedback,
    providerNotes: milestone.provider_notes,
    latestRevisionReason: latestRevision?.reason ?? null,
    latestRevisionMessage: latestRevision?.revision_message ?? milestone.user_feedback ?? null,
    latestRevisionStatus: latestRevision?.status ?? null,
    latestRevisionAt: latestRevision?.created_at ?? null,
    updatedAt: milestone.updated_at,
  };
}

export async function refreshMilestoneCardMessages(
  requestId: string,
  milestoneId: string,
) {
  const db = getDb();
  const [milestone] = await db`
    SELECT *
    FROM request_milestones
    WHERE id = ${milestoneId}::uuid
      AND request_id = ${requestId}::uuid
    LIMIT 1
  `;
  if (!milestone) return [];

  const [latestRevision] = await db`
    SELECT reason, revision_message, status, created_at
    FROM support_revisions
    WHERE milestone_id = ${milestoneId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const card = await buildMilestoneCardAttachment(milestone, requestId, latestRevision);
  const messages = await db`
    UPDATE support_messages sm
    SET attachments = ${db.json([card])},
      edited_at = NOW()
    FROM support_message_threads t
    WHERE sm.thread_id = t.id
      AND t.request_id = ${requestId}::uuid
      AND sm.attachments @> ${db.json([{ kind: "milestone_card", milestoneId }] as any)}::jsonb
    RETURNING sm.*
  `;
  return messages.map(toCamel);
}

export async function completeSupportMessageThreads(requestId: string) {
  await getDb()`
    UPDATE support_message_threads
    SET status = 'completed',
      completed_at = COALESCE(completed_at, NOW()),
      updated_at = NOW()
    WHERE request_id = ${requestId}::uuid
  `;
}

export async function sendSupportEmail(
  to: string,
  userId: string,
  eventType: string,
  title: string,
  message: string,
  metadata: Record<string, any> = {},
) {
  if (!to.trim()) {
    return { ok: false, status: 0, data: { skipped: true, reason: "missing_recipient" } };
  }
  const result = await n8nService.sendNotificationEmail({
    to,
    userId,
    eventType,
    title,
    message,
    actionUrl: String(metadata.actionUrl ?? ""),
    metadata,
  });
  if (!result.ok && !result.data.skipped) {
    console.warn("[support:n8n] email webhook failed", {
      eventType,
      userId,
      status: result.status,
      plainEnglishMeaning:
        "The support action succeeded, but the notification email webhook did not accept the message.",
      details: result.data,
    });
  } else if (result.ok) {
    const [name = "", domain = ""] = to.split("@");
    console.log("[support:n8n] email webhook accepted", {
      eventType,
      userId,
      recipient: `${name.slice(0, 2)}***@${domain}`,
      status: result.status,
      plainEnglishMeaning:
        "The notification email webhook accepted this support message.",
    });
  }
  return result;
}

export async function sendSupportWhatsApp(
  to: string,
  userId: string,
  eventType: string,
  title: string,
  message: string,
  metadata: Record<string, any> = {},
) {
  const result = await sendWhatsAppNotification({
    to,
    eventType,
    title,
    message,
    actionUrl: String(metadata.actionUrl ?? ""),
    metadata,
  });
  if (!result.ok && !result.skipped) {
    console.warn("[support:twilio] WhatsApp notification failed", {
      eventType,
      userId,
      status: result.status,
      plainEnglishMeaning:
        "The support action succeeded, but Twilio did not accept the WhatsApp notification.",
      details: result.error ?? result.data,
    });
  } else if (result.ok) {
    console.log("[support:twilio] WhatsApp notification accepted", {
      eventType,
      userId,
      sid: result.sid,
      status: result.messageStatus,
      plainEnglishMeaning:
        "Twilio accepted this WhatsApp support notification.",
    });
  } else if (result.skipped && twilioWhatsAppConfigured()) {
    console.warn("[support:twilio] WhatsApp notification skipped", {
      eventType,
      userId,
      details: result.data,
    });
  }
  return result;
}

export async function ensureRequestStorageReady(
  request: Record<string, any>,
  auth: AuthContext,
) {
  await addSupportEvent(
    String(request.id),
    auth,
    uploadthingConfigured() ? "storage.uploadthing_ready" : "storage.local_fallback",
    uploadthingConfigured()
      ? "UploadThing storage is ready for request files"
      : "UploadThing is not configured; files will use local database fallback",
    {
      provider: uploadthingConfigured() ? "uploadthing" : "database",
      taskId: String(request.task_id ?? ""),
    },
  );

  return request;
}

export async function storeSupportFileOnUploadThing(
  fileRow: Record<string, any>,
  file: File,
  buffer: Buffer,
  auth: AuthContext,
  purpose: string,
) {
  const db = getDb();
  if (!uploadthingConfigured()) {
    if (!warnedUploadThingFallback) {
      warnedUploadThingFallback = true;
      console.warn("[support:storage] UploadThing is not configured; support files will remain in database fallback storage", {
        whatHappened: "UPLOADTHING_TOKEN was not available to the users backend.",
        userImpact: "Uploads still save, but they use database fallback storage instead of UploadThing URLs.",
        whatToDo: "Set UPLOADTHING_TOKEN and restart the users backend.",
      });
    }
    const [fallback] = await db`
      UPDATE support_files
      SET storage_provider = 'database',
        external_upload_status = 'not_configured',
        external_upload_error = NULL
      WHERE id = ${fileRow.id}
      RETURNING *
    `;
    return fallback ?? fileRow;
  }

  const [pending] = await db`
    UPDATE support_files
    SET storage_provider = 'uploadthing',
      external_upload_status = 'pending',
      external_upload_error = NULL,
      external_folder_id = NULL
    WHERE id = ${fileRow.id}
    RETURNING *
  `;

  const result = await uploadSupportFile({
    bytes: buffer,
    fileName: file.name,
    fileType: file.type || "application/octet-stream",
    requestId: fileRow.request_id ? String(fileRow.request_id) : null,
    userId: auth.userId,
    purpose,
    metadata: {
      fileRowId: String(fileRow.id),
      originalFileName: file.name,
    },
  });
  const externalFileId = result.ok ? result.key : null;
  const externalFileUrl = result.ok ? result.url : null;
  const externalFolderId = result.ok ? result.customId : null;
  const uploadError = result.ok ? null : `${result.code}: ${result.message}`.slice(0, 1000);

  const [updated] = await db`
    UPDATE support_files
    SET external_file_id = ${externalFileId},
      external_file_url = ${externalFileUrl},
      external_folder_id = ${externalFolderId},
      external_upload_status = ${result.ok ? "uploaded" : "failed"},
      external_upload_error = ${uploadError},
      external_uploaded_at = CASE WHEN ${result.ok} THEN NOW() ELSE external_uploaded_at END,
      file_url = CASE WHEN ${result.ok} THEN ${externalFileUrl} ELSE file_url END,
      content_base64 = CASE WHEN ${result.ok} THEN NULL ELSE content_base64 END,
      updated_at = NOW()
    WHERE id = ${fileRow.id}
    RETURNING *
  `;

  if (fileRow.request_id) {
    await addSupportEvent(
      String(fileRow.request_id),
      auth,
      result.ok ? "uploadthing.file_uploaded" : "uploadthing.file_upload_failed",
      result.ok ? "File uploaded to secure storage" : "Secure file upload failed",
      {
        fileId: fileRow.id,
        externalFileId: externalFileId ?? "",
        externalFileUrl: externalFileUrl ?? "",
        purpose,
        provider: "uploadthing",
        error: result.ok ? null : result.message,
      },
    );
  }

  return updated ?? pending ?? fileRow;
}

export function paymentStatusForSubmittedPayment(paymentType: string) {
  if (paymentType === "deposit") return "deposit_pending_verification";
  if (paymentType === "final_balance") return "final_payment_pending_verification";
  if (paymentType === "partial_balance") return "final_payment_pending_verification";
  return "pending";
}

export function paymentStatusForVerifiedPayment(paymentType: string) {
  if (paymentType === "deposit") return "deposit_paid";
  if (paymentType === "partial_balance") return "final_payment_required";
  return "paid";
}

export async function accrueReferralReward(payment: Record<string, any>) {
  const paymentId = String(payment.id ?? "");
  const requestId = String(payment.request_id ?? "");
  const paymentAmount = roundMoney(Number(payment.amount ?? 0));
  if (!paymentId || !requestId || paymentAmount <= 0) {
    return null;
  }

  const db = getDb();
  const referredUserId = String(payment.user_key_id ?? "").trim();
  if (referredUserId) {
    const [relationship] = await db`
      SELECT rr.*
      FROM referral_relationships rr
      WHERE rr.referred_user_id = ${referredUserId}::uuid
        AND rr.status = 'active'
      LIMIT 1
    `.catch((error) => {
      console.warn("[support:referral] Failed to query referral relationship", {
        referredUserId,
        message: error instanceof Error ? error.message : String(error),
      });
      return [] as any[];
    });
    if (relationship?.id && String(relationship.referrer_user_id) !== referredUserId) {
      const amountPaidPesewas = Math.round(paymentAmount * 100);
      const rateBps = Number(relationship.commission_rate_bps ?? 1000);
      const commissionPesewas = Math.floor((amountPaidPesewas * rateBps) / 10000);
      const [commission] = await db`
        INSERT INTO referral_commissions (
          relationship_id, referrer_user_id, referred_user_id, support_payment_id, request_id,
          amount_paid_pesewas, commission_rate_bps, commission_amount_pesewas,
          currency, status, available_at, metadata
        )
        VALUES (
          ${relationship.id}, ${String(relationship.referrer_user_id)}::uuid, ${referredUserId}::uuid,
          ${paymentId}::uuid, ${requestId}::uuid, ${amountPaidPesewas}, ${rateBps}, ${commissionPesewas},
          ${String(payment.currency ?? "GHS")}, 'pending',
          COALESCE(${payment.verified_at ?? null}::timestamptz, NOW()) + INTERVAL '7 days',
          ${db.json({ paymentType: payment.payment_type ?? null, source: "support_payment_verified" })}
        )
        ON CONFLICT (support_payment_id) DO NOTHING
        RETURNING *
      `;
      if (commission) {
        const commissionAmount = roundMoney(commissionPesewas / 100);
        await db`
          INSERT INTO support_wallet_transactions (
            user_key_id, transaction_type, amount, currency, status, request_id,
            payment_id, description, metadata
          )
          VALUES (
            ${String(relationship.referrer_user_id)}, 'referral_commission', ${commissionAmount},
            ${String(payment.currency ?? "GHS")}, 'pending', ${requestId}::uuid,
            ${paymentId}::uuid, 'Referral commission from verified support payment',
            ${db.json({
              referralRelationshipId: String(relationship.id),
              referralCommissionId: String(commission.id),
              referredUserId,
              rateBps,
            })}
          )
        `;
        await db`
          UPDATE support_clients
          SET pending_wallet_balance = pending_wallet_balance + ${commissionAmount},
            updated_at = NOW()
          WHERE user_key_id = ${String(relationship.referrer_user_id)}
        `;
        await cache.deletePattern(`referrals:${String(relationship.referrer_user_id)}:*`);
        return { commission: toCamel(commission), relationship: toCamel(relationship) };
      }
      return null;
    }
  }

  const [referral] = await db`
    SELECT sr.*, sc.user_key_id AS referrer_user_key_id, sc.payout_preferences AS referrer_payout_preferences
    FROM support_referrals sr
    LEFT JOIN support_clients sc ON sc.referral_code = sr.referrer_code
    WHERE sr.request_id = ${requestId}::uuid
      AND COALESCE(sr.reward_status, 'pending') != 'cancelled'
    LIMIT 1
  `;
  if (!referral?.referrer_user_key_id) {
    return null;
  }
  if (String(referral.referrer_user_key_id) === String(referral.referred_user_key_id ?? payment.user_key_id ?? "")) {
    return null;
  }

  const rewardPercent = Number(referral.reward_percent ?? 10);
  const rewardAmount = roundMoney(paymentAmount * (rewardPercent / 100));
  const payoutPreferences = referral.payout_preferences && Object.keys(referral.payout_preferences).length
    ? referral.payout_preferences
    : referral.referrer_payout_preferences ?? {};

  const [event] = await db`
    INSERT INTO support_referral_reward_events (
      referral_id, request_id, payment_id, referrer_user_key_id, referred_user_key_id,
      payment_amount, reward_percent, reward_amount, currency, status, payout_preferences
    )
    VALUES (
      ${referral.id}, ${requestId}::uuid, ${paymentId}::uuid, ${String(referral.referrer_user_key_id)},
      ${String(referral.referred_user_key_id ?? payment.user_key_id ?? "")}, ${paymentAmount}, ${rewardPercent},
      ${rewardAmount}, ${String(payment.currency ?? referral.currency ?? "GHS")}, 'earned',
      ${db.json(payoutPreferences as any)}
    )
    ON CONFLICT (payment_id) DO NOTHING
    RETURNING *
  `;
  if (!event) {
    return null;
  }

  const [updatedReferral] = await db`
    UPDATE support_referrals
    SET source_user_key_id = COALESCE(source_user_key_id, ${String(referral.referrer_user_key_id)}),
      reward_amount = COALESCE(reward_amount, 0) + ${rewardAmount},
      currency = ${String(payment.currency ?? referral.currency ?? "GHS")},
      reward_status = 'earned',
      payout_preferences = CASE
        WHEN payout_preferences = '{}'::jsonb THEN ${db.json(payoutPreferences as any)}
        ELSE payout_preferences
      END,
      last_payment_id = ${paymentId}::uuid,
      last_rewarded_at = NOW(),
      updated_at = NOW()
    WHERE id = ${referral.id}
    RETURNING *
  `;
  return { event: toCamel(event), referral: toCamel(updatedReferral) };
}

export async function confirmSupportPaystackPayment(input: {
  reference: string;
  auth?: AuthContext;
  requestId?: string;
}) {
  const db = getDb();
  const [payment] = await db`
    SELECT p.*, r.user_key_id AS request_user_key_id, r.payment_status AS request_payment_status,
      r.delivery_status, r.currency AS request_currency, r.title AS request_title,
      r.task_id AS request_task_id, r.deadline_at AS request_deadline_at,
      r.whatsapp_number AS request_whatsapp_number,
      c.email AS request_email
    FROM support_payments p
    INNER JOIN support_requests r ON r.id = p.request_id
    LEFT JOIN support_clients c ON c.id = r.client_id
    WHERE COALESCE(p.provider_reference, p.transaction_id) = ${input.reference}
      AND (${input.requestId ?? null}::uuid IS NULL OR p.request_id = ${input.requestId ?? null}::uuid)
    ORDER BY p.created_at DESC
    LIMIT 1
  `;
  if (!payment) throw new HttpError(404, "payment_not_found", "Paystack payment was not found");
  if (input.auth && payment.request_user_key_id !== input.auth.userId) {
    throw new HttpError(403, "forbidden", "This payment belongs to another account");
  }
  if (payment.provider === "paystack" && payment.status === "verified") {
    const [request] = await db`
      SELECT *
      FROM support_requests
      WHERE id = ${payment.request_id}
      LIMIT 1
    `;
    return {
      data: toCamel(payment),
      request: request ? toCamel(request) : null,
      paystack: { status: true, message: "Payment already verified" },
      verified: true,
      idempotent: true,
    };
  }

  const verification = await paystackService.verifyTransaction(input.reference);
  const data = (verification.data ?? {}) as Record<string, any>;
  const paid = String(data.status ?? "").toLowerCase() === "success";
  if (!paid) {
    return { data: toCamel(payment), paystack: verification, verified: false };
  }

  const metadata = (data.metadata ?? {}) as Record<string, any>;
  if (metadata.requestId && String(metadata.requestId) !== String(payment.request_id)) {
    throw new HttpError(400, "payment_metadata_mismatch", "Paystack metadata does not match this support request");
  }
  const expectedAmount = Number(payment.amount ?? 0);
  const paidAmount = Math.round(Number(data.amount ?? 0)) / 100;
  const expectedCurrency = String(payment.currency ?? payment.request_currency ?? "GHS").toUpperCase();
  const paidCurrency = String(data.currency ?? "").toUpperCase();
  if (Math.abs(paidAmount - expectedAmount) > 0.01 || paidCurrency !== expectedCurrency) {
    throw new HttpError(400, "payment_mismatch", "Paystack payment amount or currency does not match this support payment");
  }

  const authorization = data.authorization as Record<string, any> | undefined;
  const [updatedPayment] = await db`
    UPDATE support_payments
    SET status = 'verified',
      provider = 'paystack',
      provider_reference = ${input.reference},
      provider_transaction_id = ${data.id ? String(data.id) : null},
      authorization_code = ${authorization?.authorization_code ? String(authorization.authorization_code) : null},
      channel = ${data.channel ? String(data.channel) : null},
      gateway_response = ${data.gateway_response ? String(data.gateway_response) : null},
      verified_payload = ${db.json(data)},
      verified_at = NOW(),
      rejection_reason = NULL,
      updated_at = NOW()
    WHERE id = ${payment.id}
    RETURNING *
  `;
  const [paymentTotals] = await db`
    SELECT
      COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'verified' AND p.provider = 'paystack'), 0)::numeric AS verified_amount,
      COALESCE(MAX(r.final_amount), MAX(r.payment_amount), MAX(r.quoted_amount), 0)::numeric AS total_amount,
      COALESCE(MAX(r.deposit_amount), 0)::numeric AS deposit_amount
    FROM support_payments p
    INNER JOIN support_requests r ON r.id = p.request_id
    WHERE p.request_id = ${payment.request_id}
  `;
  const verifiedAmount = Number(paymentTotals?.verified_amount ?? 0);
  const totalAmount = Number(paymentTotals?.total_amount ?? 0);
  const depositAmount = Number(paymentTotals?.deposit_amount ?? 0);
  const aggregateStatus =
    totalAmount <= 0 || verifiedAmount + 0.005 >= totalAmount
      ? "paid"
      : depositAmount > 0 && verifiedAmount + 0.005 >= depositAmount
        ? "deposit_paid"
        : "unpaid";
  const unlockDownload = aggregateStatus === "paid";
  await db`
    UPDATE support_deliveries
    SET is_locked = FALSE, unlocked_at = COALESCE(unlocked_at, NOW())
    WHERE request_id = ${payment.request_id} AND ${unlockDownload}
  `;
  const [updated] = await db`
    UPDATE support_requests
    SET payment_status = ${aggregateStatus},
      balance_amount = CASE
        WHEN ${unlockDownload} THEN 0
        ELSE GREATEST(${totalAmount}::numeric - ${verifiedAmount}::numeric, 0)
      END,
      payment_verified_at = NOW(),
      payment_notes = 'Paystack payment verified',
      preview_access = CASE
        WHEN ${unlockDownload} THEN 'clean_final'
        WHEN ${aggregateStatus === "deposit_paid"} THEN 'full_protected'
        ELSE preview_access
      END,
      submitted_at = COALESCE(submitted_at, NOW()),
      delivery_status = CASE
        WHEN ${unlockDownload} AND delivery_status = 'uploaded_locked' THEN 'download_unlocked'
        ELSE delivery_status
      END,
      status = CASE
        WHEN support_requests.status = 'draft' THEN 'submitted'
        ELSE support_requests.status
      END,
      updated_at = NOW()
    WHERE id = ${payment.request_id}
    RETURNING *
  `;
  await ensureSupportMessageThread(
    String(payment.request_id),
    String(payment.request_user_key_id ?? payment.user_key_id),
  );
  await db`
    INSERT INTO paystack_transactions (
      workspace_id, support_request_id, support_payment_id, user_key_id, purpose,
      amount, currency, provider_reference, provider_transaction_id,
      authorization_code, channel, gateway_response, status, verified_payload,
      metadata, verified_at
    )
    SELECT r.workspace_id, ${payment.request_id}, ${payment.id}, ${payment.user_key_id},
      'support_payment', ${payment.amount}, ${payment.currency}, ${input.reference},
      ${data.id ? String(data.id) : null},
      ${authorization?.authorization_code ? String(authorization.authorization_code) : null},
      ${data.channel ? String(data.channel) : null},
      ${data.gateway_response ? String(data.gateway_response) : null},
      'verified', ${db.json(data)}, ${db.json({ paymentType: payment.payment_type })}, NOW()
    FROM support_requests r
    WHERE r.id = ${payment.request_id}
    ON CONFLICT (provider, provider_reference) DO UPDATE SET
      support_payment_id = EXCLUDED.support_payment_id,
      status = 'verified',
      verified_payload = EXCLUDED.verified_payload,
      verified_at = NOW(),
      updated_at = NOW()
  `;

  await addSupportEvent(String(payment.request_id), input.auth ?? {
    actorId: String(payment.user_key_id),
    userId: String(payment.user_key_id),
    email: "",
    role: "system",
    actorType: "system",
    permissions: [],
    sessionId: "",
  } as AuthContext, "payment.paystack_verified", "Paystack payment verified", {
    paymentId: updatedPayment.id,
      paymentType: updatedPayment.payment_type,
      reference: input.reference,
      paystackStatus: data.status,
      verifiedAmount,
      totalAmount,
      aggregateStatus,
  });

  await accrueReferralReward(updatedPayment);

  const recipient = input.auth?.email ?? String(payment.request_email ?? "");
  if (recipient) {
    const deadlineLabel = payment.request_deadline_at
      ? new Date(payment.request_deadline_at).toLocaleString("en-GB", {
          timeZone: DEFAULT_SUPPORT_TIMEZONE,
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "the agreed deadline";
    void sendSupportEmail(
      recipient,
      String(payment.request_user_key_id ?? payment.user_key_id),
      "support.payment.verified",
      "Payment successful for your CognizApp request",
      `We have received your ${String(updatedPayment.payment_type ?? "support")} payment of ${String(updatedPayment.currency ?? payment.request_currency ?? "GHS")} ${Number(updatedPayment.amount ?? 0).toLocaleString()}. Your request "${String(payment.request_title ?? "Support request")}" is confirmed, and you will receive the completed work on or before ${deadlineLabel}.`,
      {
        requestId: String(payment.request_id),
        taskId: String(payment.request_task_id ?? ""),
        paymentId: String(updatedPayment.id),
        paymentType: String(updatedPayment.payment_type ?? ""),
        amount: Number(updatedPayment.amount ?? 0),
        currency: String(updatedPayment.currency ?? payment.request_currency ?? "GHS"),
        deadlineAt: payment.request_deadline_at ?? null,
        actionUrl: `/support/requests/${payment.request_id}`,
      },
    ).catch((error) => console.warn("[support:email] Paystack success email failed", error));
    void sendSupportWhatsApp(
      String(payment.request_whatsapp_number ?? ""),
      String(payment.request_user_key_id ?? payment.user_key_id),
      "support.payment.verified",
      "Payment confirmed by CogniZap",
      `We have received your ${String(updatedPayment.payment_type ?? "support")} payment of ${String(updatedPayment.currency ?? payment.request_currency ?? "GHS")} ${Number(updatedPayment.amount ?? 0).toLocaleString()}. Your files and request updates are available in your portal.`,
      {
        requestId: String(payment.request_id),
        taskId: String(payment.request_task_id ?? ""),
        paymentId: String(updatedPayment.id),
        paymentType: String(updatedPayment.payment_type ?? ""),
        amount: Number(updatedPayment.amount ?? 0),
        currency: String(updatedPayment.currency ?? payment.request_currency ?? "GHS"),
        deadlineAt: payment.request_deadline_at ?? null,
        actionUrl: `/support/requests/${payment.request_id}`,
      },
    ).catch((error) => console.warn("[support:whatsapp] Paystack success WhatsApp failed", error));
  }

  // Invalidate caches so the UI reflects the new payment status immediately.
  // This is especially important for webhook-driven confirmations where the
  // caller has no auth context and cannot invalidate the cache itself.
  const cacheUserId = String(payment.request_user_key_id ?? payment.user_key_id ?? "");
  if (cacheUserId) {
    await invalidateSupportCache(cacheUserId);
  }
  await invalidateProviderSupportCache();

  return {
    data: toCamel(updatedPayment),
    request: toCamel(updated),
    paystack: verification,
    verified: true,
  };
}

export function paymentAmountForType(request: Record<string, any>, paymentType: string, requestedAmount?: number) {
  const serviceTags = Array.isArray(request.service_tags)
    ? request.service_tags.map(String)
    : Array.isArray(request.serviceTags)
      ? request.serviceTags.map(String)
      : [];
  if (serviceTags.includes("assignment")) {
    if (paymentType === "final_balance" || paymentType === "partial_balance") return 0;
    if (
      typeof requestedAmount === "number" &&
      Number.isFinite(requestedAmount) &&
      requestedAmount > 0 &&
      Math.abs(roundMoney(requestedAmount) - 10) > 0.01
    ) {
      throw new HttpError(
        400,
        "payment_amount_mismatch",
        "Assignment payment amount must be exactly GHS 10",
        {
          requestedAmount: roundMoney(requestedAmount),
          expectedAmount: 10,
          paymentType,
        },
      );
    }
    return 10;
  }

  const baseAmount = Number(
    request.final_amount ??
    request.payment_amount ??
    request.quoted_amount ??
    request.budget_min ??
    0,
  );
  let computedAmount = baseAmount;
  if (paymentType === "deposit" || paymentType === "full_payment") {
    computedAmount = baseAmount;
  } else if (paymentType === "final_balance" || paymentType === "partial_balance") {
    computedAmount = 0;
  }

  if (paymentType === "partial_balance") {
    const partialAmount = roundMoney(Number(requestedAmount ?? 0));
    const minimumPartial = roundMoney(computedAmount * 0.5);
    if (
      !Number.isFinite(partialAmount) ||
      partialAmount <= 0 ||
      partialAmount > roundMoney(computedAmount) ||
      Math.abs(partialAmount - minimumPartial) > 0.01
    ) {
      throw new HttpError(
        400,
        "invalid_partial_balance_amount",
        "Partial balance payment must be half of the remaining balance",
        {
          requestedAmount: partialAmount,
          expectedAmount: minimumPartial,
          paymentType,
        },
      );
    }
    return partialAmount;
  }

  if (
    typeof requestedAmount === "number" &&
    Number.isFinite(requestedAmount) &&
    requestedAmount > 0 &&
    Math.abs(roundMoney(requestedAmount) - roundMoney(computedAmount)) > 0.01
  ) {
    throw new HttpError(
      400,
      "payment_amount_mismatch",
      "Payment amount must match the approved request amount",
      {
        requestedAmount: roundMoney(requestedAmount),
        expectedAmount: roundMoney(computedAmount),
        paymentType,
      },
    );
  }

  return computedAmount;
}

export function refundEligibilityForRequest(request: Record<string, any>, payment: Record<string, any>) {
  const status = String(request.status ?? "");
  const deliveryStatus = String(request.delivery_status ?? "");
  const refundStatus = String(payment.refund_status ?? "none");
  const paidAt = payment.verified_at ? new Date(payment.verified_at) : null;
  const requestAgeDays = paidAt
    ? (Date.now() - paidAt.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  if (refundStatus !== "none") {
    return { eligible: false, reason: "A refund review already exists for this payment" };
  }
  if (String(payment.status ?? "") !== "verified") {
    return { eligible: false, reason: "Only verified payments can be reviewed for refund" };
  }
  if (["downloaded", "accepted"].includes(deliveryStatus) || ["completed", "closed"].includes(status)) {
    return { eligible: false, reason: "Delivered, downloaded, accepted, or closed work is not normally refundable" };
  }
  if (requestAgeDays > 14 && !["non_delivery", "scope_mismatch"].includes(String(request.refund_reason_category ?? ""))) {
    return { eligible: false, reason: "Refund review must normally be requested within 14 days of payment" };
  }

  return { eligible: true, reason: "Eligible for support review" };
}

export async function invalidateSupportCache(userId: string) {
  await Promise.all([
    cache.deletePattern(`support:${userId}:*`),
    cache.deletePattern(`user:${userId}:dashboard*`),
  ]);
}

export async function invalidateProviderSupportCache() {
  for (const name of supportMemoryCache.keys()) {
    if (name.startsWith("support:provider-dashboard:") || name.startsWith("support:provider-requests:")) {
      supportMemoryCache.delete(name);
    }
  }
  await Promise.all([
    cache.deletePattern("support:provider-dashboard:*"),
    cache.deletePattern("support:provider-requests:*"),
  ]);
}
