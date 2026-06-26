import { Elysia, t } from "elysia";

import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { paystackService } from "../../lib/paystack";
import { auditRepository } from "../audit/repository";
import { notificationsRepository } from "../notifications/repository";
import { requirePermission, resolveAuth } from "../auth/middleware";
import { normalizeRole } from "../auth/policy";
import {
  addSupportEvent,
  accrueReferralReward,
  buildMilestoneCardAttachment,
  canSeeProvider,
  completeSupportMessageThreads,
  createSupportNotification,
  ensureSupportMessageThread,
  getMilestoneFiles,
  invalidateProviderSupportCache,
  invalidateSupportCache,
  paymentAmountForType,
  paymentStatusForVerifiedPayment,
  PROVIDER_DASHBOARD_CACHE_SECONDS,
  recordMilestoneFileEvent,
  refreshMilestoneCardMessages,
  refundEligibilityForRequest,
  rememberSupportJson,
  roundMoney,
  sendSupportEmail,
  sendSupportWhatsApp,
  storeSupportFileOnUploadThing,
  toCamel,
} from "../support/shared";
import {
  buildSupportPaymentPolicy,
  classifySupportRisk,
} from "../support/payment-policy";
import {
  generateProtectedPreviews,
  storeImagePreviewPages,
} from "../support/preview-service";

function isSupportAdminRole(role: string) {
  return normalizeRole(role) === "ADMIN_USER";
}

function normalizeProviderPaymentType(value: unknown) {
  const paymentType = String(value ?? "deposit").trim().toLowerCase();
  if (paymentType === "balance") return "final_balance";
  if (paymentType === "milestone_payment") return "partial_balance";
  if (["deposit", "final_balance", "partial_balance", "full_payment"].includes(paymentType)) {
    return paymentType;
  }
  return "deposit";
}

function isUploadedFile(value: FormDataEntryValue): value is File {
  return typeof value !== "string" && typeof value.size === "number" && value.size > 0;
}

function normalizeProviderCardKind(value: unknown) {
  const kind = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["payment", "payment_request", "payment_card"].includes(kind)) return "payment_card";
  if (["revision", "revision_update", "revision_card"].includes(kind)) return "revision_card";
  if (["delivery", "deliverable", "delivery_card"].includes(kind)) return "delivery_card";
  return kind;
}

function redactProviderRequest(row: Record<string, any>, isAdmin: boolean) {
  if (isAdmin) return row;
  const next = { ...row };
  delete next.client_referral_code;
  delete next.whatsapp_number;
  delete next.institution;
  delete next.referral_code;
  delete next.payment_transaction_id;
  delete next.payment_proof_file_id;
  delete next.payment_verified_by;
  delete next.workspace_id;
  delete next.email;
  delete next.full_name;
  if (next.client && typeof next.client === "object") {
    const client = { ...next.client };
    delete client.email;
    delete client.full_name;
    delete client.whatsapp_number;
    delete client.institution;
    delete client.referral_code;
    next.client = client;
  }
  if (next.draft_payload && typeof next.draft_payload === "object") {
    const draft = { ...next.draft_payload };
    delete draft.whatsappNumber;
    delete draft.institution;
    delete draft.referralCode;
    delete draft.workspaceId;
    delete draft.contactConsent;
    delete draft.email;
    delete draft.fullName;
    next.draft_payload = draft;
  }
  return next;
}

const defaultProviderNotificationPreferences = {
  email: true,
  newRequests: true,
  messages: true,
  deadlineReminders: true,
};

const defaultProviderWorkloadPreferences = {
  preferredServices: [],
  maxActiveRequests: 10,
  autoAssign: false,
};

function providerSettingsPayload(row: Record<string, any> | null | undefined, auth: Awaited<ReturnType<typeof resolveAuth>>) {
  return toCamel({
    provider_key_id: row?.provider_key_id ?? auth.userId,
    display_name: row?.display_name ?? auth.email,
    bio: row?.bio ?? "",
    timezone: row?.timezone ?? "Africa/Accra",
    availability_status: row?.availability_status ?? "available",
    weekly_capacity: row?.weekly_capacity ?? 20,
    response_target_hours: row?.response_target_hours ?? 24,
    notification_preferences: row?.notification_preferences ?? defaultProviderNotificationPreferences,
    workload_preferences: row?.workload_preferences ?? defaultProviderWorkloadPreferences,
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null,
  });
}

function normalizeMilestoneStatus(value: unknown) {
  const status = String(value ?? "pending").trim();
  return [
    "pending",
    "active",
    "submitted",
    "revision_requested",
    "approved",
    "auto_approved",
    "disputed",
    "cancelled",
  ].includes(status)
    ? status
    : "pending";
}

function normalizeDiscountStatus(value: unknown) {
  const status = String(value ?? "").trim();
  return ["approved", "rejected"].includes(status) ? status : "approved";
}

const providerSettingsBody = t.Object({
  displayName: t.Optional(t.String()),
  display_name: t.Optional(t.String()),
  bio: t.Optional(t.String()),
  timezone: t.Optional(t.String()),
  availabilityStatus: t.Optional(t.String()),
  availability_status: t.Optional(t.String()),
  weeklyCapacity: t.Optional(t.Number()),
  weekly_capacity: t.Optional(t.Number()),
  responseTargetHours: t.Optional(t.Number()),
  response_target_hours: t.Optional(t.Number()),
  notificationPreferences: t.Optional(t.Record(t.String(), t.Any())),
  notification_preferences: t.Optional(t.Record(t.String(), t.Any())),
  workloadPreferences: t.Optional(t.Record(t.String(), t.Any())),
  workload_preferences: t.Optional(t.Record(t.String(), t.Any())),
});

async function readProviderSettings(headers: Record<string, string | undefined>) {
  const auth = await resolveAuth(headers);
  if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
  const [settings] = await getDb()`
    SELECT *
    FROM provider_settings
    WHERE provider_key_id = ${auth.userId}
    LIMIT 1
  `;
  return ok({ data: providerSettingsPayload(settings, auth) });
}

async function saveProviderSettings(headers: Record<string, string | undefined>, body: Record<string, any>) {
  const auth = await resolveAuth(headers);
  if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
  const db = getDb();
  const displayName = String(body.displayName ?? body.display_name ?? auth.email).trim().slice(0, 120);
  const bio = String(body.bio ?? "").trim().slice(0, 1000);
  const timezone = String(body.timezone ?? "Africa/Accra").trim().slice(0, 80);
  const availabilityStatus = String(body.availabilityStatus ?? body.availability_status ?? "available").trim();
  const weeklyCapacity = Math.max(0, Math.min(168, Number(body.weeklyCapacity ?? body.weekly_capacity ?? 20) || 20));
  const responseTargetHours = Math.max(1, Math.min(168, Number(body.responseTargetHours ?? body.response_target_hours ?? 24) || 24));
  const notificationPreferences = {
    ...defaultProviderNotificationPreferences,
    ...((body.notificationPreferences ?? body.notification_preferences ?? {}) as Record<string, unknown>),
  };
  const workloadPreferences = {
    ...defaultProviderWorkloadPreferences,
    ...((body.workloadPreferences ?? body.workload_preferences ?? {}) as Record<string, unknown>),
  };
  const [settings] = await db`
    INSERT INTO provider_settings (
      provider_key_id, display_name, bio, timezone, availability_status,
      weekly_capacity, response_target_hours, notification_preferences, workload_preferences
    )
    VALUES (
      ${auth.userId}, ${displayName || auth.email}, ${bio}, ${timezone || "Africa/Accra"},
      ${availabilityStatus}, ${weeklyCapacity}, ${responseTargetHours},
      ${db.json(notificationPreferences)}, ${db.json(workloadPreferences)}
    )
    ON CONFLICT (provider_key_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      bio = EXCLUDED.bio,
      timezone = EXCLUDED.timezone,
      availability_status = EXCLUDED.availability_status,
      weekly_capacity = EXCLUDED.weekly_capacity,
      response_target_hours = EXCLUDED.response_target_hours,
      notification_preferences = EXCLUDED.notification_preferences,
      workload_preferences = EXCLUDED.workload_preferences,
      updated_at = NOW()
    RETURNING *
  `;
  await invalidateProviderSupportCache();
  return ok({ data: providerSettingsPayload(settings, auth), message: "Provider settings saved" });
}

export const providerSettingsRoutes = new Elysia({ prefix: "/api/provider", tags: ["provider-settings"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })
  .get("/settings", async ({ headers }) => readProviderSettings(headers))
  .patch("/settings", async ({ headers, body }) => saveProviderSettings(headers, body), {
    body: providerSettingsBody,
  });

async function handlePreviewsRetry({ headers, params }: any) {
  const auth = await resolveAuth(headers);
  if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
  const [asset] = await getDb()`
    SELECT source_file_id
    FROM support_preview_assets
    WHERE request_id = ${params.id}::uuid
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (!asset?.source_file_id) {
    throw new HttpError(404, "preview_source_not_found", "No protected-preview source is available for retry");
  }
  const previewAssets = await generateProtectedPreviews(params.id, String(asset.source_file_id));
  await addSupportEvent(params.id, auth, "admin.preview_retried", "Provider retried protected preview generation", {
    previewAssetIds: previewAssets.map((preview) => preview.id),
  });
  return ok({
    data: previewAssets.map(toCamel),
    message: "Protected previews regenerated",
  });
}

async function handlePaymentPolicyOverride({ headers, params, body }: any) {
  const auth = await resolveAuth(headers);
  if (!isSupportAdminRole(auth.role)) requirePermission(auth, "support.users.inspect");
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 8) {
    throw new HttpError(400, "override_reason_required", "Provide a clear reason for the policy override");
  }
  const depositPercent = Number(body.depositPercent);
  if (!Number.isFinite(depositPercent) || depositPercent < 0 || depositPercent > 100) {
    throw new HttpError(400, "invalid_deposit_percent", "Deposit percent must be between 0 and 100");
  }
  if (!["deposit", "full_payment"].includes(body.previewUnlock)) {
    throw new HttpError(400, "invalid_preview_unlock", "Preview unlock must be deposit or full_payment");
  }
  if (!["none", "deposit", "full_payment"].includes(body.workStartRequirement)) {
    throw new HttpError(400, "invalid_work_start_requirement", "Invalid work-start requirement");
  }
  const db = getDb();
  const [current] = await db`
    SELECT *
    FROM support_requests
    WHERE id = ${params.id}::uuid
    LIMIT 1
  `;
  if (!current) throw new HttpError(404, "request_not_found", "Support request not found");
  if (
    [
      "pending",
      "paystack_pending",
      "deposit_pending_verification",
      "deposit_paid",
      "final_payment_pending_verification",
      "final_payment_required",
      "paid",
    ].includes(String(current.payment_status ?? ""))
  ) {
    throw new HttpError(409, "payment_already_started", "Policy cannot be changed after payment checkout starts");
  }
  const basePolicy = buildSupportPaymentPolicy(
    current,
    (current.risk_tier ?? "first_time") as "first_time" | "trusted" | "high_risk",
  );
  const totalAmount = Number(current.final_amount ?? current.payment_amount ?? current.quoted_amount ?? 0);
  const depositAmount = roundMoney((totalAmount * depositPercent) / 100);
  const policy = {
    ...basePolicy,
    ...(current.payment_policy ?? {}),
    depositPercent,
    previewUnlock: body.previewUnlock,
    workStartRequirement: body.workStartRequirement,
    editableDocumentRequired: body.editableDocumentRequired,
    revisionsAllowed: body.revisionsAllowed ?? current.revisions_allowed ?? 2,
    override: {
      reason,
      actorId: auth.userId,
      overriddenAt: new Date().toISOString(),
    },
  };
  const [updated] = await db`
    UPDATE support_requests
    SET payment_policy = ${db.json(policy as any)},
      payment_policy_version = payment_policy_version + 1,
      deposit_percent = ${depositPercent},
      deposit_amount = ${depositAmount},
      balance_amount = GREATEST(${totalAmount} - ${depositAmount}, 0),
      payment_mode = ${depositPercent >= 100 ? "before_work" : "deposit_then_balance"},
      payment_status = CASE WHEN ${totalAmount <= 0} THEN 'paid' ELSE 'deposit_required' END,
      revisions_allowed = ${policy.revisionsAllowed},
      updated_at = NOW()
    WHERE id = ${params.id}::uuid
    RETURNING *
  `;
  await addSupportEvent(params.id, auth, "admin.payment_policy_override", "Admin overrode payment policy", {
    reason,
    depositPercent,
    previewUnlock: body.previewUnlock,
    workStartRequirement: body.workStartRequirement,
    editableDocumentRequired: body.editableDocumentRequired,
    revisionsAllowed: policy.revisionsAllowed,
  });
  await invalidateSupportCache(String(current.user_key_id));
  await invalidateProviderSupportCache();
  return ok({ data: toCamel(updated), message: "Payment policy override saved" });
}

async function handleDeliverRequest({ headers, params, request }: any) {
  const auth = await resolveAuth(headers);
  if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
  const isAdmin = isSupportAdminRole(auth.role);
  const db = getDb();
  const form = await request.formData();
  const note = String(form.get("deliveryNote") ?? form.get("note") ?? "").trim();
  const pdfValue = form.get("pdfFile");
  const docxValue = form.get("docxFile");
  const pdfFile = pdfValue && isUploadedFile(pdfValue) ? pdfValue : null;
  const docxFile = docxValue && isUploadedFile(docxValue) ? docxValue : null;
  const previewImages = form
    .getAll("previewImages")
    .filter(isUploadedFile);
  if (!pdfFile) {
    throw new HttpError(
      400,
      "pdf_delivery_file_required",
      "Upload the clean PDF preview source",
    );
  }
  if (pdfFile.type !== "application/pdf" && !pdfFile.name.toLowerCase().endsWith(".pdf")) {
    throw new HttpError(400, "invalid_pdf_source", "The preview source must be a PDF file");
  }
  if (!docxFile) {
    throw new HttpError(
      400,
      "docx_delivery_file_required",
      "Upload the clean DOCX file together with the PDF and preview images",
    );
  }
  if (
    docxFile.type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
    !docxFile.name.toLowerCase().endsWith(".docx")
  ) {
    throw new HttpError(400, "invalid_docx_final", "The clean final document must be a DOCX file");
  }
  if (!previewImages.length) {
    throw new HttpError(
      400,
      "preview_images_required",
      "Upload ordered PNG or JPEG preview page images before publishing.",
    );
  }

  const [supportRequest] = await db`
    SELECT r.*, c.email, c.full_name
    FROM support_requests r
    LEFT JOIN support_clients c ON c.id = r.client_id
    WHERE r.id = ${params.id}::uuid
    LIMIT 1
  `;
  if (!supportRequest) throw new HttpError(404, "request_not_found", "Support request not found");
  const deliverStatus = String(supportRequest.status ?? "draft");
  if (!["in_progress", "work_ready", "error_resend_required"].includes(deliverStatus)) {
    throw new HttpError(409, "invalid_status_transition", `Cannot deliver a request with status "${deliverStatus}"`);
  }

  const storedFiles: Record<string, any>[] = [];
  const deliveryFiles: Array<[File, "admin_clean_pdf" | "admin_clean_docx"]> = [
    [pdfFile, "admin_clean_pdf"],
    [docxFile, "admin_clean_docx"],
  ];
  for (const [file, purpose] of deliveryFiles) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const [storedFile] = await db`
      INSERT INTO support_files (
        request_id, user_key_id, file_name, file_url, file_type, file_size, content_base64, purpose
      )
      VALUES (
        ${params.id}::uuid, ${supportRequest.user_key_id}, ${file.name}, '',
        ${file.type || "application/octet-stream"}, ${file.size},
        ${buffer.toString("base64")}, ${purpose}
      )
      RETURNING *
    `;
    storedFiles.push(storedFile);
  }
  const isPaid = supportRequest.payment_status === "paid";
  const locked = !isPaid;
  const deliveries = [];
  await db`
    UPDATE support_deliveries
    SET is_locked = TRUE,
      metadata = COALESCE(metadata, '{}'::jsonb) || ${db.json({
    supersededAt: new Date().toISOString(),
    supersededBy: auth.userId,
    reason: "provider_reuploaded_delivery_package",
  })}::jsonb,
      updated_at = NOW()
    WHERE request_id = ${params.id}::uuid
      AND delivery_type = 'final'
      AND asset_type = 'clean_final'
      AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'supersededAt')
  `;
  for (const storedFile of storedFiles) {
    const [delivery] = await db`
      INSERT INTO support_deliveries (
        request_id, uploaded_by_admin_id, file_id, delivery_note, is_locked,
        unlocked_at, delivery_type, preview_allowed, asset_type, metadata
      )
      VALUES (
        ${params.id}::uuid, ${auth.userId}, ${storedFile.id}, ${note}, ${locked},
        ${locked ? null : new Date()}, 'final', FALSE, 'clean_final',
        ${db.json({
      uploadedByRole: normalizeRole(auth.role),
      finalPaymentRequired: !isPaid,
      filePurpose: storedFile.purpose,
    })}
      )
      RETURNING *
    `;
    deliveries.push(delivery);
  }
  const previewPages = await storeImagePreviewPages({
    requestId: params.id,
    userKeyId: String(supportRequest.user_key_id),
    previewImages,
  });
  const [updated] = await db`
    UPDATE support_requests
    SET status = 'work_ready',
      delivery_status = ${locked ? "uploaded_locked" : "download_unlocked"},
      payment_status = CASE
        WHEN ${isPaid} THEN payment_status
        WHEN payment_status = 'deposit_paid' THEN 'final_payment_required'
        ELSE payment_status
      END,
      preview_status = 'ready',
      preview_access = CASE
        WHEN payment_status IN ('deposit_paid', 'paid') THEN 'full_protected'
        ELSE 'limited'
      END,
      updated_at = NOW()
    WHERE id = ${params.id}::uuid
    RETURNING *
  `;
  await addSupportEvent(params.id, auth, "admin.delivery_uploaded", "Admin uploaded completed work", {
    deliveryIds: deliveries.map((delivery) => delivery.id),
    fileIds: storedFiles.map((file) => file.id),
    previewPageIds: previewPages.map((page) => page.id),
    previewPageCount: previewPages.length,
    deliveryType: "paired_clean_final_with_image_preview_pages",
    isLocked: locked,
  });
  const thread = await ensureSupportMessageThread(params.id, String(supportRequest.user_key_id));
  if (thread) {
    const attachment = {
      kind: "preview_pages_card",
      requestId: params.id,
      title: "Preview pages ready",
      description: "Review the page images in chat and request corrections before paying to unlock clean files.",
      pageCount: previewPages.length,
      locked: locked,
      cleanFilesLocked: locked,
      paymentType: isPaid ? "paid" : "final_balance",
      paymentStatus: isPaid ? "paid" : "final_payment_required",
      amount: Number(supportRequest.balance_amount ?? supportRequest.final_amount ?? supportRequest.payment_amount ?? 0),
      currency: supportRequest.currency ?? "GHS",
      files: storedFiles.map((file) => ({
        id: file.id,
        kind: "locked_delivery_file",
        name: file.file_name,
        label: file.file_name,
        fileName: file.file_name,
        fileType: file.file_type,
        fileSize: file.file_size,
        purpose: file.purpose,
        locked,
        canDownload: !locked,
      })),
      deliveredAt: new Date().toISOString(),
    };
    const [message] = await db`
      INSERT INTO support_messages (
        thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by
      )
      VALUES (
        ${thread.id}, ${auth.userId}, ${auth.email}, 'provider',
        ${"Preview pages are ready for review. Clean PDF and DOCX downloads stay locked until payment."},
        ${db.json([attachment] as any)}, ARRAY[${auth.userId}]::TEXT[]
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
  void sendSupportEmail(
    String(supportRequest.email ?? ""),
    String(supportRequest.user_key_id),
    "support.delivery.uploaded",
    locked ? "Your completed work has been uploaded" : "New support work is ready",
    locked
      ? "A protected preview is ready. Complete the required payments to view the full preview and unlock clean PDF/DOCX downloads."
      : "Your protected preview and clean PDF/DOCX downloads are ready.",
    {
      requestId: params.id,
      deliveryIds: deliveries.map((delivery) => delivery.id),
      actionUrl: `/support/requests/${params.id}`,
    },
  ).catch((error) => console.warn("[support:email] delivery email failed", error));
  void sendSupportWhatsApp(
    String(supportRequest.whatsapp_number ?? ""),
    String(supportRequest.user_key_id),
    "support.delivery.uploaded",
    locked ? "Your CogniZap file is ready" : "Your CogniZap work is ready",
    locked
      ? "Your protected preview is ready. Complete the required payment in your portal to unlock more access."
      : "Your protected preview and clean PDF/DOCX files are ready in your portal.",
    {
      requestId: params.id,
      taskId: String(supportRequest.task_id ?? ""),
      deliveryIds: deliveries.map((delivery) => delivery.id),
      actionUrl: `/support/requests/${params.id}`,
    },
  ).catch((error) => console.warn("[support:whatsapp] delivery WhatsApp failed", error));
  await invalidateSupportCache(String(supportRequest.user_key_id));
  await invalidateProviderSupportCache();
  return ok({
    data: {
      deliveries: deliveries.map(toCamel),
      previewPages: previewPages.map(toCamel),
    },
    request: toCamel(redactProviderRequest(updated, isAdmin)),
    message: locked
      ? "Preview pages published; clean PDF and DOCX remain locked"
      : "Preview pages and clean files are ready",
  });
}

export const supportInboxRoutes = new Elysia({ prefix: "/api/support", tags: ["support-inbox"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })
  .get("/provider/requests", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const isAdmin = isSupportAdminRole(auth.role);
    const status = String(query.status ?? "").trim();
    const paymentStatus = String(query.paymentStatus ?? query.payment_status ?? "").trim();
    const deadline = String(query.deadline ?? "").trim();
    const subscription = String(query.subscription ?? query.plan ?? "").trim();
    const priority = String(query.priority ?? "").trim();
    const rows = await rememberSupportJson(
      `support:provider-requests:${isAdmin ? "admin" : "provider"}:${status || "all"}:${paymentStatus || "all"}:${deadline || "all"}:${subscription || "all"}:${priority || "all"}`,
      15,
      () => getDb()`
      SELECT r.*, c.email, c.full_name, c.referral_code AS client_referral_code,
        COALESCE(ws.plan_id, 'free') AS subscription_plan_id,
        sp.name AS subscription_plan_name,
        COALESCE(sp.priority_level, 0) AS subscription_priority_level,
        ws.status AS subscription_status,
        mt.id AS message_thread_id,
        mt.last_message_at AS message_thread_last_message_at,
        COALESCE(fc.file_count, 0)::int AS file_count,
        COALESCE(mc.message_count, 0)::int AS message_count
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = r.workspace_id
      LEFT JOIN subscription_plans sp ON sp.id = ws.plan_id
      LEFT JOIN LATERAL (
        SELECT id, last_message_at
        FROM support_message_threads
        WHERE request_id = r.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) mt ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS file_count
        FROM support_files
        WHERE request_id = r.id
      ) fc ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(m.id)::int AS message_count
        FROM support_message_threads t
        LEFT JOIN support_messages m ON m.thread_id = t.id
        WHERE t.request_id = r.id
      ) mc ON TRUE
      WHERE (${status || null}::text IS NULL OR r.status = ${status || null})
        AND (${paymentStatus || null}::text IS NULL OR r.payment_status = ${paymentStatus || null})
        AND (${subscription || null}::text IS NULL OR COALESCE(ws.plan_id, 'free') = ${subscription || null})
        AND (
          ${deadline || null}::text IS NULL
          OR (${deadline || null} = 'overdue' AND r.deadline_at IS NOT NULL AND r.deadline_at < NOW())
          OR (${deadline || null} = '24h' AND r.deadline_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours')
          OR (${deadline || null} = '7d' AND r.deadline_at BETWEEN NOW() AND NOW() + INTERVAL '7 days')
          OR (${deadline || null} = 'none' AND r.deadline_at IS NULL)
        )
        AND (
          ${priority || null}::text IS NULL
          OR (${priority || null} = 'high' AND COALESCE(sp.priority_level, 0) >= 2)
          OR (${priority || null} = 'standard' AND COALESCE(sp.priority_level, 0) < 2)
        )
      ORDER BY COALESCE(sp.priority_level, 0) DESC,
        CASE WHEN r.deadline_at IS NULL THEN 1 ELSE 0 END,
        r.deadline_at ASC,
        r.updated_at DESC
      LIMIT 200
    `,
    );
    return ok({ data: rows.map((row) => toCamel(redactProviderRequest(row, isAdmin))) });
  }, {
    query: t.Object({
      status: t.Optional(t.String()),
      paymentStatus: t.Optional(t.String()),
      payment_status: t.Optional(t.String()),
      deadline: t.Optional(t.String()),
      subscription: t.Optional(t.String()),
      plan: t.Optional(t.String()),
      priority: t.Optional(t.String()),
    }),
  })
  .get("/provider/settings", async ({ headers }) => {
    return readProviderSettings(headers);
  })
  .patch("/provider/settings", async ({ headers, body }) => {
    return saveProviderSettings(headers, body);
  }, {
    body: providerSettingsBody,
  })
  .get("/provider/requests/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const isAdmin = isSupportAdminRole(auth.role);
    const db = getDb();
    const [request] = await getDb()`
      SELECT r.*, c.email, c.full_name, c.referral_code AS client_referral_code,
        COALESCE(ws.plan_id, 'free') AS subscription_plan_id,
        sp.name AS subscription_plan_name,
        COALESCE(sp.priority_level, 0) AS subscription_priority_level,
        mt.id AS message_thread_id,
        mt.last_message_at AS message_thread_last_message_at,
        COALESCE(mc.message_count, 0)::int AS message_count
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = r.workspace_id
      LEFT JOIN subscription_plans sp ON sp.id = ws.plan_id
      LEFT JOIN LATERAL (
        SELECT id, last_message_at
        FROM support_message_threads
        WHERE request_id = r.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) mt ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(m.id)::int AS message_count
        FROM support_message_threads t
        LEFT JOIN support_messages m ON m.thread_id = t.id
        WHERE t.request_id = r.id
      ) mc ON TRUE
      WHERE r.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    const files = await db`
      SELECT id, file_name, file_type, file_size, file_url, purpose, storage_provider,
        external_file_id, external_file_url, external_upload_status, created_at
      FROM support_files
      WHERE request_id = ${params.id}::uuid
      ORDER BY created_at DESC
    `;
    return ok({ data: { ...toCamel(redactProviderRequest(request, isAdmin)), files: files.map(toCamel) } });
  })
  .get("/provider/requests/:id/milestones", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const [request] = await db`
      SELECT id
      FROM support_requests
      WHERE id = ${params.id}::uuid
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
    const milestoneIds = rows.map((r) => String(r.id));
    const allFiles: Array<Record<string, any>> = milestoneIds.length
      ? await db`
          SELECT id, milestone_id, file_name, file_type, file_size, file_url,
            external_file_url, purpose, storage_provider, created_at, deleted_at
          FROM support_files
          WHERE milestone_id = ANY(${milestoneIds}::uuid[])
          ORDER BY created_at DESC
        `
      : [];
    const filesByMilestone = new Map<string, Array<Record<string, any>>>();
    for (const f of allFiles) {
      const key = String(f.milestone_id);
      if (!filesByMilestone.has(key)) filesByMilestone.set(key, []);
      filesByMilestone.get(key)!.push(f);
    }
    const data = rows.map((row) => ({
      ...toCamel(row),
      files: (filesByMilestone.get(String(row.id)) ?? []).map(toCamel),
    }));
    return ok({ data });
  })
  .post("/provider/requests/:id/milestones", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const title = String(body.title ?? "").trim();
    if (title.length < 3) throw new HttpError(400, "milestone_title_required", "Milestone title is required");
    const [supportRequest] = await db`
      SELECT id, user_key_id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!supportRequest) throw new HttpError(404, "request_not_found", "Support request not found");

    const [milestone] = await db`
      INSERT INTO request_milestones (
        request_id, title, description, due_at, status, provider_notes, metadata
      )
      VALUES (
        ${params.id}::uuid,
        ${title},
        ${String(body.description ?? "").trim()},
        ${body.dueAt || body.due_at ? new Date(String(body.dueAt ?? body.due_at)) : null},
        ${normalizeMilestoneStatus(body.status ?? "pending")},
        ${String(body.providerNotes ?? body.provider_notes ?? "").trim()},
        ${db.json((body.metadata ?? {}) as any)}
      )
      RETURNING *
    `;
    await db`
      UPDATE support_requests
      SET updated_at = NOW()
      WHERE id = ${params.id}::uuid
    `;
    await addSupportEvent(params.id, auth, "milestone.created", "Provider created milestone", {
      milestoneId: milestone.id,
      title: milestone.title,
      dueAt: milestone.due_at,
    });
    await invalidateSupportCache(String(supportRequest.user_key_id));
    await invalidateProviderSupportCache();
    return ok({ data: toCamel(milestone), message: "Milestone created" });
  }, {
    body: t.Object({
      title: t.String(),
      description: t.Optional(t.String()),
      dueAt: t.Optional(t.String()),
      due_at: t.Optional(t.String()),
      status: t.Optional(t.String()),
      providerNotes: t.Optional(t.String()),
      provider_notes: t.Optional(t.String()),
      metadata: t.Optional(t.Record(t.String(), t.Any())),
    }),
  })
  .patch("/provider/requests/:id/milestones/:milestoneId", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const description = Object.prototype.hasOwnProperty.call(body, "description")
      ? String(body.description ?? "")
      : null;
    const dueAt = body.dueAt || body.due_at ? new Date(String(body.dueAt ?? body.due_at)) : null;
    const providerNotes = body.providerNotes ?? body.provider_notes ?? null;
    const newStatus = body.status ? normalizeMilestoneStatus(body.status) : null;

    // If transitioning to submitted from revision_requested, increment round
    let roundUpdate: number | null = null;
    if (newStatus === "submitted") {
      const [current] = await db`
        SELECT status, submission_round
        FROM request_milestones
        WHERE id = ${params.milestoneId}::uuid AND request_id = ${params.id}::uuid
        LIMIT 1
      `;
      if (current) {
        if (current.status === "revision_requested") {
          roundUpdate = Number(current.submission_round ?? 0) + 1;
        } else if (Number(current.submission_round ?? 0) === 0) {
          roundUpdate = 1;
        }
      }
    }

    const [milestone] = await db`
      UPDATE request_milestones
      SET title = COALESCE(NULLIF(${String(body.title ?? "").trim()}, ''), title),
        description = COALESCE(${description}, description),
        due_at = COALESCE(${dueAt}, due_at),
        status = COALESCE(${newStatus ? newStatus : null}::text, status),
        submission_round = COALESCE(${roundUpdate}::int, submission_round),
        provider_notes = COALESCE(${providerNotes}, provider_notes),
        submitted_at = CASE WHEN ${newStatus ?? null}::text = 'submitted' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
        updated_at = NOW()
      WHERE id = ${params.milestoneId}::uuid
        AND request_id = ${params.id}::uuid
      RETURNING *
    `;
    if (!milestone) throw new HttpError(404, "milestone_not_found", "Milestone not found");
    const [supportRequest] = await db`
      SELECT user_key_id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    const refreshedMessages = await refreshMilestoneCardMessages(
      params.id,
      String(milestone.id),
    );
    if (refreshedMessages.length > 0) {
      const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
      for (const message of refreshedMessages) {
        broadcastSupportMessageUpdate(String(message.threadId), message);
      }
    }
    await addSupportEvent(params.id, auth, "milestone.updated", "Provider updated milestone", {
      milestoneId: milestone.id,
      status: milestone.status,
    });
    if (supportRequest?.user_key_id) {
      await invalidateSupportCache(String(supportRequest.user_key_id));
    }
    await invalidateProviderSupportCache();
    return ok({ data: toCamel(milestone), message: "Milestone updated" });
  }, {
    body: t.Object({
      title: t.Optional(t.String()),
      description: t.Optional(t.String()),
      dueAt: t.Optional(t.String()),
      due_at: t.Optional(t.String()),
      status: t.Optional(t.String()),
      providerNotes: t.Optional(t.String()),
      provider_notes: t.Optional(t.String()),
    }),
  })
  .post("/provider/requests/:id/milestones/:milestoneId/send-card", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const [milestone] = await db`
      SELECT m.*, r.user_key_id, r.title AS request_title, r.task_id
      FROM request_milestones m
      INNER JOIN support_requests r ON r.id = m.request_id
      WHERE m.id = ${params.milestoneId}::uuid
        AND m.request_id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!milestone) throw new HttpError(404, "milestone_not_found", "Milestone not found");
    const thread = await ensureSupportMessageThread(params.id, String(milestone.user_key_id));
    if (!thread) throw new HttpError(500, "thread_unavailable", "Could not create request conversation");
    const status = normalizeMilestoneStatus(body.status ?? "submitted");

    // If resubmitting after a revision, increment the submission round
    let newRound = Number(milestone.submission_round ?? 0);
    const isResubmission = milestone.status === "revision_requested" && status === "submitted";
    if (isResubmission) {
      newRound = newRound + 1;
    } else if (status === "submitted" && newRound === 0) {
      newRound = 1;
    }

    const [updatedMilestone] = await db`
      UPDATE request_milestones
      SET status = ${status},
        submission_round = ${newRound},
        submitted_at = CASE WHEN ${status} = 'submitted' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
        provider_notes = COALESCE(NULLIF(${String(body.note ?? body.message ?? "").trim()}, ''), provider_notes),
        updated_at = NOW()
      WHERE id = ${params.milestoneId}::uuid
      RETURNING *
    `;
    const [latestRevision] = await db`
      SELECT reason, revision_message, status, created_at
      FROM support_revisions
      WHERE milestone_id = ${updatedMilestone.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const card = await buildMilestoneCardAttachment(updatedMilestone, params.id, latestRevision);
    const content = String(body.message ?? body.note ?? "").trim()
      || `Milestone submitted: ${updatedMilestone.title}`;
    const [existingCardMessage] = await db`
      SELECT *
      FROM support_messages
      WHERE thread_id = ${thread.id}
        AND attachments @> ${db.json([{ kind: "milestone_card", milestoneId: updatedMilestone.id }] as any)}::jsonb
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const [message] = existingCardMessage
      ? await db`
        UPDATE support_messages
        SET content = ${content},
          attachments = ${db.json([card])},
          read_by = ARRAY[${auth.userId}]::TEXT[]
        WHERE id = ${existingCardMessage.id}
        RETURNING *
      `
      : await db`
        INSERT INTO support_messages (
          thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by
        )
        VALUES (
          ${thread.id}, ${auth.userId}, ${auth.email}, 'provider', ${content},
          ${db.json([card])}, ARRAY[${auth.userId}]::TEXT[]
        )
        RETURNING *
      `;
    await db`
      UPDATE support_message_threads
      SET last_message_at = ${message.created_at}, updated_at = NOW()
      WHERE id = ${thread.id}
    `;
    const { broadcastSupportMessage, broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
    if (existingCardMessage) {
      broadcastSupportMessageUpdate(String(thread.id), toCamel(message));
    } else {
      broadcastSupportMessage(String(thread.id), toCamel(message));
    }
    await addSupportEvent(params.id, auth, existingCardMessage ? "milestone.card_updated" : "milestone.card_sent", existingCardMessage ? "Provider updated milestone card" : "Provider sent milestone card", {
      milestoneId: updatedMilestone.id,
      messageId: message.id,
      status: updatedMilestone.status,
    });
    await recordMilestoneFileEvent({
      requestId: params.id,
      milestoneId: String(updatedMilestone.id),
      auth,
      eventType: existingCardMessage ? "card_updated" : "card_sent",
      submissionRound: newRound,
      metadata: {
        messageId: message.id,
        status: updatedMilestone.status,
        fileCount: card.fileCount ?? 0,
        submissionRound: newRound,
      },
    });
    await invalidateSupportCache(String(milestone.user_key_id));
    await invalidateProviderSupportCache();
    return ok({ data: toCamel(updatedMilestone), message: "Milestone card sent" });
  }, {
    body: t.Object({
      message: t.Optional(t.String()),
      note: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }),
  })
  .get("/provider/requests/:id/milestones/:milestoneId", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
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
      LEFT JOIN LATERAL (
        SELECT rv.reason, rv.revision_message, rv.status, rv.created_at
        FROM support_revisions rv
        WHERE rv.milestone_id = m.id
        ORDER BY rv.created_at DESC
        LIMIT 1
      ) latest_revision ON TRUE
      WHERE m.id = ${params.milestoneId}::uuid
        AND m.request_id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!row) throw new HttpError(404, "milestone_not_found", "Milestone not found");
    const data = {
      ...toCamel(row),
      files: await getMilestoneFiles(String(row.id)),
    };
    return ok({ data });
  })
  .get("/provider/requests/:id/milestones/:milestoneId/history", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [row] = await getDb()`
      SELECT id FROM request_milestones
      WHERE id = ${params.milestoneId}::uuid AND request_id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!row) throw new HttpError(404, "milestone_not_found", "Milestone not found");
    const { getMilestoneHistory } = await import("../support/shared");
    const history = await getMilestoneHistory(String(params.milestoneId));
    return ok({ data: history });
  })
  .post("/provider/requests/:id/discount-decision", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const decision = normalizeDiscountStatus(body.status ?? body.decision);
    const requestedAmount = Math.max(0, Number(body.requestedAmount ?? body.requested_amount ?? 0) || 0);
    const requestedPercent = body.discountPercent ?? body.discount_percent;
    const discountPercent = requestedPercent === undefined || requestedPercent === null
      ? null
      : Number(requestedPercent);
    if (discountPercent !== null && (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100)) {
      throw new HttpError(400, "invalid_discount_percent", "Discount percent must be between 1 and 100");
    }
    const approvedAmount = Math.max(0, Number(body.approvedAmount ?? body.approved_amount ?? requestedAmount) || 0);
    const reason = String(body.reason ?? body.note ?? "").trim();
    const [supportRequest] = await db`
      SELECT id, user_key_id, payment_status, currency, payment_amount, quoted_amount,
        payment_policy, risk_tier,
        COALESCE(original_amount, payment_amount, quoted_amount, 0) AS original_amount,
        COALESCE(discount_amount, 0) AS existing_discount
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!supportRequest) throw new HttpError(404, "request_not_found", "Support request not found");
    const discountStatus = String((supportRequest as any).status ?? "draft");
    if (!["submitted", "under_review", "quoted", "awaiting_payment"].includes(discountStatus)) {
      throw new HttpError(409, "invalid_status_transition", `Cannot make discount decision on a request with status "${discountStatus}"`);
    }
    if (["deposit_paid", "paid", "final_payment_pending_verification", "final_payment_required"].includes(String(supportRequest.payment_status ?? ""))) {
      throw new HttpError(409, "payment_already_started", "Discount cannot be changed after payment has started");
    }
    const baseAmount = Number(supportRequest.original_amount ?? supportRequest.payment_amount ?? supportRequest.quoted_amount ?? 0);
    const percentDiscountAmount = discountPercent === null
      ? null
      : roundMoney((baseAmount * discountPercent) / 100);
    const discountAmount = decision === "approved" ? Math.min(percentDiscountAmount ?? approvedAmount, baseAmount) : 0;
    const finalAmount = roundMoney(Math.max(baseAmount - discountAmount, 0));
    const automaticPolicy = buildSupportPaymentPolicy(
      supportRequest,
      (supportRequest.risk_tier ?? "first_time") as "first_time" | "trusted" | "high_risk",
    );
    const currentPolicy = Object.keys(supportRequest.payment_policy ?? {}).length
      ? supportRequest.payment_policy
      : automaticPolicy;
    const requestedDepositPercent = Number(currentPolicy.depositPercent);
    const depositPercent = finalAmount === 0 ? 0 : requestedDepositPercent;
    const depositAmount = finalAmount === 0 ? 0 : roundMoney((finalAmount * depositPercent) / 100);
    const balanceAmount = roundMoney(Math.max(finalAmount - depositAmount, 0));
    const [discountRequest] = await db`
      INSERT INTO support_discount_requests (
        request_id, user_key_id, provider_key_id, requested_amount, approved_amount,
        currency, status, reason, decided_at, metadata
      )
      VALUES (
        ${params.id}::uuid, ${supportRequest.user_key_id}, ${auth.userId}, ${requestedAmount},
        ${discountAmount}, ${supportRequest.currency ?? "GHS"}, ${decision}, ${reason}, NOW(),
        ${db.json({ baseAmount, finalAmount, depositPercent, discountPercent } as any)}
      )
      RETURNING *
    `;
    const [updated] = await db`
      UPDATE support_requests
      SET original_amount = COALESCE(original_amount, payment_amount, quoted_amount, ${baseAmount}),
        discount_amount = ${discountAmount},
        final_amount = ${finalAmount},
        quoted_amount = ${finalAmount},
        payment_amount = ${finalAmount},
        deposit_percent = ${depositPercent},
        deposit_amount = ${depositAmount},
        balance_amount = ${balanceAmount},
        payment_mode = ${depositPercent >= 100 ? "before_work" : "deposit_then_balance"},
        payment_status = ${finalAmount === 0 ? "paid" : "deposit_required"},
        status = CASE WHEN ${finalAmount === 0} THEN 'under_review' ELSE status END,
        payment_policy = ${db.json({
      ...currentPolicy,
      depositPercent,
      previewUnlock: depositPercent >= 100 ? "full_payment" : currentPolicy.previewUnlock,
      quotedAmount: finalAmount,
    } as any)},
        payment_verified_at = ${finalAmount === 0 ? new Date() : null},
        payment_verified_by = ${finalAmount === 0 ? auth.userId : null},
        admin_notes = COALESCE(NULLIF(${reason}, ''), admin_notes),
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    await addSupportEvent(
      params.id,
      auth,
      decision === "approved" ? "discount.approved" : "discount.rejected",
      decision === "approved" ? "Provider approved discount" : "Provider rejected discount",
      {
        discountRequestId: discountRequest.id,
        requestedAmount,
        approvedAmount: discountAmount,
        baseAmount,
        finalAmount,
        depositAmount,
        balanceAmount,
      },
    );
    await invalidateSupportCache(String(supportRequest.user_key_id));
    await invalidateProviderSupportCache();
    const [discountClient] = await getDb()`
      SELECT c.email, c.whatsapp_number, r.title, r.user_key_id
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      WHERE r.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (discountClient?.email) {
      const discountMessage = decision === "approved"
        ? `Your discount request for "${String(discountClient.title ?? "Support request")}" has been approved. The new price is ${String(supportRequest.currency ?? "GHS")} ${finalAmount.toLocaleString()}.`
        : `Your discount request for "${String(discountClient.title ?? "Support request")}" was not approved. The original price remains ${String(supportRequest.currency ?? "GHS")} ${baseAmount.toLocaleString()}.`;
      void sendSupportEmail(
        String(discountClient.email),
        String(discountClient.user_key_id),
        "support.discount.decision",
        decision === "approved" ? "Discount approved" : "Discount update",
        discountMessage,
        { requestId: params.id, decision, finalAmount, baseAmount, actionUrl: `/support/requests/${params.id}` },
      ).catch((error) => console.warn("[support:email] Discount decision email failed", error));
    }
    if (discountClient?.whatsapp_number) {
      const discountWaMessage = decision === "approved"
        ? `Your discount for "${String(discountClient.title ?? "Support request")}" was approved. New price: ${String(supportRequest.currency ?? "GHS")} ${finalAmount.toLocaleString()}.`
        : `Your discount for "${String(discountClient.title ?? "Support request")}" was not approved. Price remains ${String(supportRequest.currency ?? "GHS")} ${baseAmount.toLocaleString()}.`;
      void sendSupportWhatsApp(
        String(discountClient.whatsapp_number),
        String(discountClient.user_key_id),
        "support.discount.decision",
        decision === "approved" ? "CogniZap discount approved" : "CogniZap discount update",
        discountWaMessage,
        { requestId: params.id, decision, actionUrl: `/support/requests/${params.id}` },
      ).catch((error) => console.warn("[support:whatsapp] Discount decision WhatsApp failed", error));
    }
    return ok({
      data: toCamel(discountRequest),
      request: toCamel(redactProviderRequest(updated, isSupportAdminRole(auth.role))),
      message: decision === "approved" ? "Discount approved and price updated" : "Discount rejected",
    });
  }, {
    body: t.Object({
      status: t.Optional(t.String()),
      decision: t.Optional(t.String()),
      requestedAmount: t.Optional(t.Number()),
      requested_amount: t.Optional(t.Number()),
      approvedAmount: t.Optional(t.Number()),
      approved_amount: t.Optional(t.Number()),
      discountPercent: t.Optional(t.Number()),
      discount_percent: t.Optional(t.Number()),
      reason: t.Optional(t.String()),
      note: t.Optional(t.String()),
    }),
  })
  // ── Send structured provider card (payment / revision / delivery) ──────────
  .post("/provider/requests/:id/send-card", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers as unknown as Record<string, string>);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();

    const VALID_KINDS = ["payment_card", "revision_card", "delivery_card"] as const;
    type CardKind = typeof VALID_KINDS[number];
    const kind = normalizeProviderCardKind(body.kind) as CardKind;
    if (!VALID_KINDS.includes(kind)) {
      throw new HttpError(400, "invalid_card_kind", `kind must be one of: ${VALID_KINDS.join(", ")}`);
    }

    const [supportRequest] = await db`
      SELECT r.id, r.task_id, r.title, r.user_key_id, r.payment_amount, r.quoted_amount,
             r.final_amount, r.deposit_amount, r.balance_amount, r.deposit_percent,
             r.currency, r.payment_status, r.status AS request_status
      FROM support_requests r
      WHERE r.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!supportRequest) throw new HttpError(404, "request_not_found", "Support request not found");

    const thread = await ensureSupportMessageThread(params.id, String(supportRequest.user_key_id));
    if (!thread) throw new HttpError(500, "thread_unavailable", "Could not resolve request conversation");

    // Build the attachment object based on kind
    let card: Record<string, any>;
    if (kind === "payment_card") {
      const paymentType = normalizeProviderPaymentType(body.paymentType);
      const requestedAmount = Number(body.amount ?? 0);
      const amount = paymentAmountForType(
        supportRequest,
        paymentType,
        Number.isFinite(requestedAmount) && requestedAmount > 0
          ? requestedAmount
          : undefined,
      );
      card = {
        kind: "payment_card",
        requestId: params.id,
        paymentType,
        amount,
        currency: String(supportRequest.currency ?? "GHS"),
        note: String(body.note ?? "").trim() || null,
        paymentStatus: String(supportRequest.payment_status ?? "pending"),
        depositAmount: Number(supportRequest.deposit_amount ?? 0),
        balanceAmount: Number(supportRequest.balance_amount ?? 0),
        depositPercent: Number(supportRequest.deposit_percent ?? 0),
        sentAt: new Date().toISOString(),
      };
    } else if (kind === "revision_card") {
      card = {
        kind: "revision_card",
        requestId: params.id,
        title: String(body.title ?? "Revision Update"),
        message: String(body.message ?? body.note ?? "").trim(),
        expectedAt: body.expectedAt ?? null,
        sentAt: new Date().toISOString(),
      };
    } else {
      // delivery_card
      card = {
        kind: "delivery_card",
        requestId: params.id,
        title: String(body.title ?? "Work Delivered"),
        message: String(body.message ?? body.note ?? "").trim(),
        deliveredAt: new Date().toISOString(),
        locked: Boolean(body.locked ?? true),
        sentAt: new Date().toISOString(),
      };
    }

    const content = String(body.message ?? body.note ?? "").trim() || (
      kind === "payment_card" ? `Payment request: ${card.currency} ${card.amount}`
        : kind === "revision_card" ? "Revision update from your provider"
          : "Your work is ready for delivery"
    );

    const [message] = await db`
      INSERT INTO support_messages (
        thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by
      )
      VALUES (
        ${thread.id}, ${auth.userId}, ${auth.email ?? "Provider"}, 'provider',
        ${content}, ${db.json([card])}, ARRAY[${auth.userId}]::TEXT[]
      )
      RETURNING *
    `;

    await db`
      UPDATE support_message_threads
      SET last_message_at = NOW(), updated_at = NOW()
      WHERE id = ${thread.id}
    `;

    const { broadcastSupportMessage } = await import("../support-messages/realtime");
    broadcastSupportMessage(String(thread.id), toCamel(message));

    await addSupportEvent(
      params.id, auth,
      `provider.${kind}_sent`,
      `Provider sent a ${kind.replace("_", " ")}`,
      { messageId: message.id, kind, amount: card.amount },
    );

    await invalidateSupportCache(String(supportRequest.user_key_id));
    await invalidateProviderSupportCache();

    return ok({ data: toCamel(message), message: `${kind.replace("_", " ")} sent` });
  }, {
    body: t.Object({
      kind: t.String(),
      amount: t.Optional(t.Number()),
      paymentType: t.Optional(t.String()),
      note: t.Optional(t.String()),
      message: t.Optional(t.String()),
      title: t.Optional(t.String()),
      expectedAt: t.Optional(t.String()),
      locked: t.Optional(t.Boolean()),
    }),
  })
  .post("/provider/requests/:id/timeline", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [request] = await getDb()`
      UPDATE support_requests
      SET status = ${body.status}, updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    return ok({ data: toCamel(redactProviderRequest(request, isSupportAdminRole(auth.role))), message: "Timeline updated" });
  }, {
    body: t.Object({ status: t.String(), note: t.Optional(t.String()) }),
  })
  .post("/provider/requests/:id/quotes", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const [supportRequest] = await db`
      SELECT id FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!supportRequest) throw new HttpError(404, "request_not_found", "Support request not found");

    const [quote] = await db`
      INSERT INTO support_quotes (
        request_id, provider_key_id, quote_type, line_items, deliverables,
        turnaround_hours, revision_policy, terms, total_amount, currency, status, valid_until
      )
      VALUES (
        ${params.id}::uuid, ${auth.userId}, ${body.quoteType ?? body.type ?? "fixed"},
        ${db.json((body.lineItems ?? []) as any)}, ${body.deliverables ?? []},
        ${body.turnaroundHours ?? 24}, ${db.json((body.revisionPolicy ?? { included: 1, additionalCost: 0, maxRevisions: 1, revisionWindow: 48 }) as any)},
        ${body.terms ?? ""}, ${body.totalAmount ?? 0}, ${body.currency ?? "GHS"},
        ${body.status ?? "sent"}, ${body.validUntil ? new Date(body.validUntil) : null}
      )
      RETURNING *
    `;
    await db`UPDATE support_requests SET status = 'quoted', updated_at = NOW() WHERE id = ${params.id}::uuid`;
    return ok({ data: toCamel(quote), message: "Quote sent" });
  }, {
    body: t.Object({
      quoteType: t.Optional(t.String()),
      type: t.Optional(t.String()),
      lineItems: t.Optional(t.Array(t.Any())),
      deliverables: t.Optional(t.Array(t.String())),
      turnaroundHours: t.Optional(t.Number()),
      revisionPolicy: t.Optional(t.Any()),
      terms: t.Optional(t.String()),
      totalAmount: t.Optional(t.Number()),
      currency: t.Optional(t.String()),
      status: t.Optional(t.String()),
      validUntil: t.Optional(t.String()),
    }),
  })
  .get("/provider/quotes", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const status = String(query.status ?? "").trim();
    const rows = await getDb()`
      SELECT q.*, r.title AS request_title, r.task_id
      FROM support_quotes q
      INNER JOIN support_requests r ON r.id = q.request_id
      WHERE (${status || null}::text IS NULL OR q.status = ${status || null})
      ORDER BY q.updated_at DESC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  }, {
    query: t.Object({ status: t.Optional(t.String()) }),
  })
  .post("/provider/quotes", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    if (!body.requestId) throw new HttpError(400, "request_required", "requestId is required");
    const db = getDb();
    const [quote] = await db`
      INSERT INTO support_quotes (
        request_id, provider_key_id, quote_type, line_items, deliverables,
        turnaround_hours, revision_policy, terms, total_amount, currency, status, valid_until
      )
      VALUES (
        ${body.requestId}::uuid, ${auth.userId}, ${body.quoteType ?? body.type ?? "fixed"},
        ${db.json((body.lineItems ?? []) as any)}, ${body.deliverables ?? []},
        ${body.turnaroundHours ?? 24}, ${db.json((body.revisionPolicy ?? { included: 1, additionalCost: 0, maxRevisions: 1, revisionWindow: 48 }) as any)},
        ${body.terms ?? ""}, ${body.totalAmount ?? 0}, ${body.currency ?? "GHS"},
        ${body.status ?? "sent"}, ${body.validUntil ? new Date(body.validUntil) : null}
      )
      RETURNING *
    `;
    await db`UPDATE support_requests SET status = 'quoted', updated_at = NOW() WHERE id = ${body.requestId}::uuid`;
    return ok({ data: toCamel(quote), message: "Quote sent" });
  }, {
    body: t.Object({
      requestId: t.String(),
      quoteType: t.Optional(t.String()),
      type: t.Optional(t.String()),
      lineItems: t.Optional(t.Array(t.Any())),
      deliverables: t.Optional(t.Array(t.String())),
      turnaroundHours: t.Optional(t.Number()),
      revisionPolicy: t.Optional(t.Any()),
      terms: t.Optional(t.String()),
      totalAmount: t.Optional(t.Number()),
      currency: t.Optional(t.String()),
      status: t.Optional(t.String()),
      validUntil: t.Optional(t.String()),
    }),
  })
  .get("/provider/orders", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const status = String(query.status ?? "").trim();
    const rows = await getDb()`
      SELECT o.*, r.title AS request_title, r.task_id
      FROM support_orders o
      INNER JOIN support_requests r ON r.id = o.request_id
      WHERE (${status || null}::text IS NULL OR o.status = ${status || null})
      ORDER BY o.updated_at DESC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  }, {
    query: t.Object({ status: t.Optional(t.String()) }),
  })
  .get("/provider/orders/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [order] = await getDb()`
      SELECT o.*, r.title AS request_title, r.task_id
      FROM support_orders o
      INNER JOIN support_requests r ON r.id = o.request_id
      WHERE o.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!order) throw new HttpError(404, "order_not_found", "Order not found");
    return ok({ data: toCamel(order) });
  })
  .put("/provider/orders/:id/status", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [order] = await getDb()`
      UPDATE support_orders
      SET status = ${body.status}, updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    if (!order) throw new HttpError(404, "order_not_found", "Order not found");
    return ok({ data: toCamel(order), message: "Order status updated" });
  }, {
    body: t.Object({ status: t.String(), notes: t.Optional(t.String()) }),
  })
  .get("/provider/dashboard/stats", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const stats = await rememberSupportJson("support:provider-dashboard:stats", PROVIDER_DASHBOARD_CACHE_SECONDS, async () => {
      const db = getDb();
      const [row] = await db`
        SELECT
          COUNT(*)::int AS total_requests,
          COUNT(*) FILTER (WHERE status IN ('submitted', 'under_review'))::int AS open_requests,
          COUNT(*) FILTER (WHERE status = 'converted_to_order')::int AS converted_requests,
          (SELECT COUNT(*)::int FROM support_message_threads) AS message_threads,
          (SELECT COUNT(*)::int FROM support_referrals) AS referrals
        FROM support_requests
      `;
      return toCamel(row);
    });
    return ok({ data: stats });
  })
  .get("/provider/dashboard/deadlines", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const limit = Math.min(Math.max(Number(query.limit ?? 10) || 10, 1), 50);
    const rows = await rememberSupportJson(`support:provider-dashboard:deadlines:${limit}`, PROVIDER_DASHBOARD_CACHE_SECONDS, async () => {
      const rows = await getDb()`
        SELECT
          id,
          COALESCE(NULLIF(title, ''), task_id, 'Support request') AS title,
          'request' AS type,
          deadline_at AS deadline,
          status
        FROM support_requests
        WHERE deadline_at IS NOT NULL
          AND status NOT IN ('completed', 'cancelled', 'refunded')
        ORDER BY deadline_at ASC
        LIMIT ${limit}
      `;
      return rows.map(toCamel);
    });
    return ok({ data: rows });
  }, {
    query: t.Object({ limit: t.Optional(t.String()) }),
  })
  .get("/provider/dashboard/activity", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const limit = Math.min(Math.max(Number(query.limit ?? 10) || 10, 1), 50);
    const rows = await rememberSupportJson(`support:provider-dashboard:activity:${limit}`, PROVIDER_DASHBOARD_CACHE_SECONDS, async () => {
      const rows = await getDb()`
        SELECT
          e.id,
          e.event_type AS type,
          e.message,
          e.created_at AS time,
          COALESCE(NULLIF(r.title, ''), r.task_id, 'Support request') AS title,
          r.id AS request_id
        FROM support_events e
        LEFT JOIN support_requests r ON r.id = e.request_id
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `;
      return rows.map(toCamel);
    });
    return ok({ data: rows });
  }, {
    query: t.Object({ limit: t.Optional(t.String()) }),
  })
  .get("/provider/clients", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const rows = await getDb()`
      WITH support_client_stats AS (
        SELECT
          c.id AS client_id,
          c.user_key_id,
          c.email,
          c.full_name,
          c.whatsapp_number,
          c.institution,
          c.referral_code,
          c.created_at,
          c.updated_at,
          COUNT(r.id)::int AS request_count,
          COALESCE(SUM(CASE WHEN r.payment_status IN ('paid', 'deposit_paid') THEN r.payment_amount ELSE 0 END), 0)::numeric AS total_spent,
          MAX(COALESCE(r.updated_at, c.updated_at)) AS last_activity_at
        FROM support_clients c
        LEFT JOIN support_requests r ON r.client_id = c.id
        GROUP BY c.id
      ),
      auth_user_stats AS (
        SELECT
          NULL::uuid AS client_id,
          u.id::text AS user_key_id,
          u.email,
          COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), u.email) AS full_name,
          NULL::text AS whatsapp_number,
          NULL::text AS institution,
          u.referral_code,
          u.created_at,
          u.updated_at,
          COUNT(r.id)::int AS request_count,
          COALESCE(SUM(CASE WHEN r.payment_status IN ('paid', 'deposit_paid') THEN r.payment_amount ELSE 0 END), 0)::numeric AS total_spent,
          MAX(COALESCE(r.updated_at, u.updated_at)) AS last_activity_at
        FROM auth.users u
        LEFT JOIN support_requests r ON r.user_key_id = u.id::text
        WHERE u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM support_clients c WHERE c.user_key_id = u.id::text
          )
        GROUP BY u.id
      )
      SELECT
        client_id,
        user_key_id AS client_uid,
        user_key_id,
        email,
        full_name,
        whatsapp_number,
        institution,
        referral_code,
        request_count,
        request_count AS total_requests,
        request_count AS total_orders,
        total_spent,
        last_activity_at,
        ARRAY_REMOVE(ARRAY[institution, referral_code], NULL)::text[] AS tags,
        created_at,
        updated_at
      FROM (
        SELECT * FROM support_client_stats
        UNION ALL
        SELECT * FROM auth_user_stats
      ) clients
      ORDER BY last_activity_at DESC NULLS LAST, updated_at DESC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .get("/provider/referrals", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const rows = await getDb()`
      SELECT rf.*, r.task_id, r.status AS request_status, r.created_at AS request_created_at
      FROM support_referrals rf
      LEFT JOIN support_requests r ON r.id = rf.request_id
      ORDER BY rf.created_at DESC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .get("/provider/discount-codes", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const isAdmin = isSupportAdminRole(auth.role);
    const rows = await getDb()`
      SELECT
        dc.*,
        COUNT(dr.id)::int AS redemption_rows,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', dr.id,
              'userKeyId', dr.user_key_id,
              'requestId', dr.request_id,
              'originalAmount', dr.original_amount,
              'discountAmount', dr.discount_amount,
              'finalAmount', dr.final_amount,
              'status', dr.status,
              'redeemedAt', dr.redeemed_at,
              'email', c.email,
              'fullName', c.full_name
            )
            ORDER BY dr.redeemed_at DESC
          ) FILTER (WHERE dr.id IS NOT NULL),
          '[]'::jsonb
        ) AS redemptions
      FROM support_discount_codes dc
      LEFT JOIN support_discount_redemptions dr ON dr.discount_code_id = dc.id
      LEFT JOIN support_clients c ON c.user_key_id = dr.user_key_id
      WHERE (${isAdmin} OR dc.provider_key_id = ${auth.userId}) AND dc.status != 'cancelled'
      GROUP BY dc.id
      ORDER BY dc.updated_at DESC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .post("/provider/discount-codes", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const isAdmin = isSupportAdminRole(auth.role);
    const discountPercent = roundMoney(Number(body.discountPercent ?? 0));
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      throw new HttpError(400, "invalid_discount_percent", "Discount percent must be between 1 and 100");
    }
    const maxRedemptions = Math.max(1, Math.min(500, Math.floor(Number(body.maxRedemptions ?? 1) || 1)));
    const rawCode = String(body.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    const generatedCode = `COGNI-${Math.round(discountPercent)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const code = rawCode || generatedCode;
    const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
      throw new HttpError(400, "invalid_expiry", "Discount expiry date is invalid");
    }
    const status = "active";
    const [row] = await getDb()`
      INSERT INTO support_discount_codes (
        provider_key_id, code, label, discount_percent, max_redemptions,
        minimum_amount, eligible_service_tags, status, requires_admin_approval,
        approved_by, approved_at, expires_at
      )
      VALUES (
        ${auth.userId}, ${code}, ${String(body.label ?? "").trim()}, ${discountPercent},
        ${maxRedemptions}, ${body.minimumAmount ?? null},
        ${Array.isArray(body.eligibleServiceTags) ? body.eligibleServiceTags : []},
        ${status}, ${false}, ${isAdmin ? auth.userId : null},
        ${isAdmin ? new Date() : null}, ${expiresAt}
      )
      RETURNING *
    `;
    await addSupportEvent(null, auth, "discount_code.created", "Provider created a discount code", {
      code,
      discountPercent,
      maxRedemptions,
      expiresAt,
    });
    return ok({ data: toCamel(row), message: "Discount code created" });
  }, {
    body: t.Object({
      code: t.Optional(t.String()),
      label: t.Optional(t.String()),
      discountPercent: t.Number(),
      maxRedemptions: t.Optional(t.Number()),
      minimumAmount: t.Optional(t.Number()),
      eligibleServiceTags: t.Optional(t.Array(t.String())),
      expiresAt: t.Optional(t.String()),
    }),
  })
  .put("/provider/discount-codes/:id", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const isAdmin = isSupportAdminRole(auth.role);
    const discountPercent = body.discountPercent === undefined ? null : roundMoney(Number(body.discountPercent));
    if (discountPercent !== null && (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100)) {
      throw new HttpError(400, "invalid_discount_percent", "Discount percent must be between 1 and 100");
    }
    const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
      throw new HttpError(400, "invalid_expiry", "Discount expiry date is invalid");
    }
    const [row] = await getDb()`
      UPDATE support_discount_codes
      SET label = COALESCE(${body.label ?? null}, label),
        discount_percent = COALESCE(${discountPercent}, discount_percent),
        max_redemptions = COALESCE(${body.maxRedemptions ?? null}, max_redemptions),
        minimum_amount = ${body.minimumAmount ?? null},
        eligible_service_tags = COALESCE(${Array.isArray(body.eligibleServiceTags) ? body.eligibleServiceTags : null}, eligible_service_tags),
        status = COALESCE(${body.status ?? null}, status),
        expires_at = ${expiresAt},
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
        AND (${isAdmin} OR provider_key_id = ${auth.userId})
      RETURNING *
    `;
    if (!row) throw new HttpError(404, "discount_code_not_found", "Discount code not found");
    return ok({ data: toCamel(row), message: "Discount code updated" });
  }, {
    body: t.Object({
      label: t.Optional(t.String()),
      discountPercent: t.Optional(t.Number()),
      maxRedemptions: t.Optional(t.Number()),
      minimumAmount: t.Optional(t.Number()),
      eligibleServiceTags: t.Optional(t.Array(t.String())),
      expiresAt: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }),
  })
  .delete("/provider/discount-codes/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.users.inspect");
    const isAdmin = isSupportAdminRole(auth.role);
    const [row] = await getDb()`
      UPDATE support_discount_codes
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${params.id}::uuid
        AND (${isAdmin} OR provider_key_id = ${auth.userId})
      RETURNING *
    `;
    if (!row) throw new HttpError(404, "discount_code_not_found", "Discount code not found");
    return ok({ data: toCamel(row), message: "Discount code cancelled" });
  })
  .get("/admin/requests", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const status = String(query.status ?? "").trim();
    const paymentStatus = String(query.paymentStatus ?? query.payment_status ?? "").trim();
    const rows = await getDb()`
      SELECT r.*, c.email, c.full_name, f.file_url AS payment_proof_file_url, f.file_name AS payment_proof_file_name
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      LEFT JOIN support_files f ON f.id = r.payment_proof_file_id
      WHERE (${status || null}::text IS NULL OR r.status = ${status || null})
        AND (${paymentStatus || null}::text IS NULL OR r.payment_status = ${paymentStatus || null})
      ORDER BY r.updated_at DESC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  }, {
    query: t.Object({
      status: t.Optional(t.String()),
      paymentStatus: t.Optional(t.String()),
      payment_status: t.Optional(t.String()),
    }),
  })
  .get("/admin/requests/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const [request] = await getDb()`
      SELECT r.*, c.email, c.full_name, f.file_url AS payment_proof_file_url, f.file_name AS payment_proof_file_name
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      LEFT JOIN support_files f ON f.id = r.payment_proof_file_id
      WHERE r.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    return ok({ data: toCamel(request) });
  })
  .get("/admin/requests/:id/drive-files", async ({ headers, params, query }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const [request] = await getDb()`
      SELECT id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
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
  }, {
    query: t.Object({
      query: t.Optional(t.String()),
      limit: t.Optional(t.Numeric()),
      whatToSearch: t.Optional(t.String()),
    }),
  })
  .post("/admin/requests/:id/ai-review", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const db = getDb();
    const [request] = await db`
      SELECT * FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");

    const description = String(request.description ?? "").toLowerCase();
    const tags = Array.isArray(request.service_tags) ? request.service_tags : [];
    const budget = Number(request.budget_min ?? request.payment_amount ?? 0);
    const highComplexity =
      description.includes("chapter") ||
      description.includes("thesis") ||
      description.includes("data analysis") ||
      tags.includes("chapter-editing") ||
      tags.includes("literature-methodology");
    const suggestedMinimum = highComplexity ? 1500 : budget || 300;
    const suggestedMaximum = highComplexity ? 3000 : Math.max(suggestedMinimum, budget || 600);
    const depositPercent = highComplexity ? 70 : budget > 800 ? 50 : 0;
    const depositAmount = Math.round((suggestedMinimum * depositPercent) / 100);
    const review = {
      ok: true,
      requestType: highComplexity ? "research_paper" : "other",
      complexity: highComplexity ? "high" : "medium",
      budgetReview: {
        submittedBudget: budget,
        currency: request.currency ?? "GHS",
        rating: budget > 0 && budget < suggestedMinimum ? "too_low" : "needs_admin_review",
        reason: highComplexity
          ? "The request appears to include a large academic workload."
          : "The request should be reviewed by admin before committing pricing.",
        suggestedMinimum,
        suggestedMaximum,
      },
      deadlineReview: {
        rating: request.deadline_at ? "needs_admin_review" : "unknown",
        reason: request.deadline_at ? "Admin should confirm feasibility against workload." : "No deadline was provided.",
      },
      paymentRecommendation: {
        mode: depositPercent > 0 ? "deposit_then_balance" : "after_completion",
        depositRequired: depositPercent > 0,
        depositPercent,
        depositAmount,
        balanceAmount: Math.max(suggestedMinimum - depositAmount, 0),
        reason: depositPercent > 0 ? "Deposit recommended due to workload or payment risk." : "Small work may be payable after completion.",
      },
      scopeReview: {
        scopeStatus: description ? "clear" : "missing_info",
        summary: request.description ?? "",
        missingItems: description ? [] : ["Project description"],
      },
      adminRecommendation: {
        action: depositPercent > 0 ? "require_deposit" : "send_quote",
        priority: highComplexity ? "high" : "normal",
        messageToAdmin: depositPercent > 0
          ? "Review the request and require a deposit before work starts."
          : "Review the request and send a final quote.",
      },
      suggestedUserMessage: {
        title: "Your request is under review",
        message: "The admin team will review your project details and confirm the next step.",
      },
      uiBadges: [
        highComplexity ? "High complexity" : "Admin review needed",
        depositPercent > 0 ? "Deposit recommended" : "Quote recommended",
      ],
    };
    const [updated] = await db`
      UPDATE support_requests
      SET ai_review = ${db.json(review)}, status = 'ai_reviewed', updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    await addSupportEvent(params.id, auth, "ai.reviewed", "AI review saved", review);
    return ok({ data: toCamel(updated), review });
  })
  .post("/admin/requests/:id/quote", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const quotedAmount = body.quotedAmount ?? body.totalAmount ?? 0;
    const [current] = await db`
      SELECT * FROM support_requests WHERE id = ${params.id}::uuid LIMIT 1
    `;
    if (!current) throw new HttpError(404, "request_not_found", "Support request not found");
    const riskTier = await classifySupportRisk(
      String(current.user_key_id),
      current.client_id ? String(current.client_id) : null,
    );
    const automaticPolicy = buildSupportPaymentPolicy(current, riskTier);
    const depositPercent = automaticPolicy.depositPercent;
    const depositAmount = Math.round((quotedAmount * depositPercent) / 100);
    const balanceAmount = Math.max(quotedAmount - depositAmount, 0);
    const paymentStatus = quotedAmount <= 0
      ? "paid"
      : depositPercent >= 100
        ? "final_payment_required"
        : "deposit_required";
    const paymentPolicy = {
      ...automaticPolicy,
      depositPercent,
      previewUnlock: depositPercent >= 100 ? "full_payment" : automaticPolicy.previewUnlock,
      quotedAmount,
      quotedAt: new Date().toISOString(),
    };
    const [request] = await db`
      UPDATE support_requests
      SET status = 'quote_sent',
        quoted_amount = ${quotedAmount},
        payment_mode = ${body.paymentMode ?? (depositPercent > 0 ? "deposit_then_balance" : "after_completion")},
        deposit_percent = ${depositPercent},
        deposit_amount = ${depositAmount},
        balance_amount = ${balanceAmount},
        payment_amount = ${quotedAmount},
        payment_status = ${paymentStatus},
        risk_tier = ${riskTier},
        payment_policy = ${db.json(paymentPolicy as any)},
        payment_policy_version = 1,
        revisions_allowed = 2,
        admin_notes = ${body.notes ?? null},
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    await addSupportEvent(params.id, auth, "admin.quote_sent", "Admin sent quote", {
      quotedAmount,
      depositPercent,
      depositAmount,
      balanceAmount,
    });
    return ok({ data: toCamel(redactProviderRequest(request, isSupportAdminRole(auth.role))), message: "Quote saved" });
  }, {
    body: t.Object({
      quotedAmount: t.Optional(t.Number()),
      totalAmount: t.Optional(t.Number()),
      paymentMode: t.Optional(t.String()),
      notes: t.Optional(t.String()),
    }),
  })
  .post("/admin/requests/:id/require-deposit", async ({ headers, params, body }) => {
    await resolveAuth(headers);
    throw new HttpError(
      410,
      "policy_override_required",
      "Use the audited payment-policy override endpoint instead of the legacy deposit action",
    );
  }, {
    body: t.Object({
      amount: t.Optional(t.Number()),
      depositAmount: t.Optional(t.Number()),
      depositPercent: t.Optional(t.Number()),
      notes: t.Optional(t.String()),
    }),
  })
  .post("/admin/requests/:id/risk-override", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!isSupportAdminRole(auth.role)) requirePermission(auth, "support.users.inspect");
    const tier = String(body.riskTier ?? body.risk_tier ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!["first_time", "trusted", "high_risk"].includes(tier)) {
      throw new HttpError(400, "invalid_risk_tier", "Risk tier must be first_time, trusted, or high_risk");
    }
    if (reason.length < 8) {
      throw new HttpError(400, "risk_reason_required", "Provide a clear reason for the risk override");
    }
    const db = getDb();
    const [request] = await db`
      SELECT id, client_id, user_key_id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    await db`
      UPDATE support_clients
      SET risk_tier_override = ${tier},
        risk_override_reason = ${reason},
        risk_override_by = ${auth.userId},
        risk_override_at = NOW(),
        updated_at = NOW()
      WHERE id = ${request.client_id}
    `;
    const [current] = await db`
      SELECT *
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    const automaticPolicy = buildSupportPaymentPolicy(current ?? request, tier as "first_time" | "trusted" | "high_risk");
    const totalAmount = Number(current?.final_amount ?? current?.payment_amount ?? current?.quoted_amount ?? 0);
    const depositAmount = roundMoney((totalAmount * automaticPolicy.depositPercent) / 100);
    const [updated] = await db`
      UPDATE support_requests
      SET risk_tier = ${tier},
        payment_policy = CASE
          WHEN payment_status IN ('deposit_paid', 'paid') THEN payment_policy
          ELSE ${db.json(automaticPolicy as any)}
        END,
        deposit_percent = CASE
          WHEN payment_status IN ('deposit_paid', 'paid') THEN deposit_percent
          ELSE ${automaticPolicy.depositPercent}
        END,
        deposit_amount = CASE
          WHEN payment_status IN ('deposit_paid', 'paid') THEN deposit_amount
          ELSE ${depositAmount}
        END,
        balance_amount = CASE
          WHEN payment_status IN ('deposit_paid', 'paid') THEN balance_amount
          ELSE GREATEST(${totalAmount} - ${depositAmount}, 0)
        END,
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    await addSupportEvent(params.id, auth, "admin.risk_override", "Admin changed client risk tier", {
      riskTier: tier,
      reason,
    });
    return ok({ data: toCamel(updated), message: "Risk tier override saved" });
  }, {
    body: t.Object({
      riskTier: t.Optional(t.String()),
      risk_tier: t.Optional(t.String()),
      reason: t.String(),
    }),
  })
  .post("/admin/requests/:id/payment-policy-override", handlePaymentPolicyOverride, {
    body: t.Object({
      depositPercent: t.Number(),
      previewUnlock: t.String(),
      workStartRequirement: t.String(),
      editableDocumentRequired: t.Boolean(),
      revisionsAllowed: t.Optional(t.Number({ minimum: 0, maximum: 10 })),
      reason: t.String(),
    }),
  })
  .post("/provider/requests/:id/payment-policy-override", handlePaymentPolicyOverride, {
    body: t.Object({
      depositPercent: t.Number(),
      previewUnlock: t.String(),
      workStartRequirement: t.String(),
      editableDocumentRequired: t.Boolean(),
      revisionsAllowed: t.Optional(t.Number({ minimum: 0, maximum: 10 })),
      reason: t.String(),
    }),
  })
  .post("/admin/requests/:id/start-work", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [current] = await getDb()`
      SELECT id, status, payment_status, payment_policy, user_key_id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!current) throw new HttpError(404, "request_not_found", "Support request not found");
    const currentStatus = String(current.status ?? "draft");
    if (!["submitted", "under_review", "error_resend_required"].includes(currentStatus)) {
      throw new HttpError(409, "invalid_status_transition", `Cannot start work on a request with status "${currentStatus}"`);
    }
    const policy = (current.payment_policy ?? {}) as Record<string, any>;
    const workStartRequirement = String(policy.workStartRequirement ?? "none");
    const paymentStatus = String(current.payment_status ?? "unpaid");
    const requirementMet =
      workStartRequirement === "none" ||
      paymentStatus === "paid" ||
      (workStartRequirement === "deposit" && paymentStatus === "deposit_paid");
    if (!requirementMet) {
      throw new HttpError(
        402,
        "WORK_START_PAYMENT_REQUIRED",
        workStartRequirement === "full_payment"
          ? "Full payment must be verified before work starts"
          : "The required deposit must be verified before work starts",
      );
    }
    const [request] = await getDb()`
      UPDATE support_requests
      SET status = 'in_progress', delivery_status = 'working', scope_locked_at = COALESCE(scope_locked_at, NOW()), updated_at = NOW()
      WHERE id = ${params.id}::uuid AND status IN ('submitted', 'under_review', 'error_resend_required')
      RETURNING *
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    await addSupportEvent(params.id, auth, "admin.work_started", "Work started");
    await invalidateSupportCache(String(current.user_key_id));
    await invalidateProviderSupportCache();
    const [clientInfo] = await getDb()`
      SELECT c.email, c.full_name, c.whatsapp_number, r.title, r.user_key_id
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      WHERE r.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (clientInfo?.email) {
      void sendSupportEmail(
        String(clientInfo.email),
        String(clientInfo.user_key_id),
        "support.work_started",
        "Work has started on your CogniZap request",
        `Your request "${String(clientInfo.title ?? "Support request")}" is now in progress. The provider has started working on it.`,
        { requestId: params.id, actionUrl: `/support/requests/${params.id}` },
      ).catch((error) => console.warn("[support:email] Work started email failed", error));
    }
    if (clientInfo?.whatsapp_number) {
      void sendSupportWhatsApp(
        String(clientInfo.whatsapp_number),
        String(clientInfo.user_key_id),
        "support.work_started",
        "Work started on your CogniZap request",
        `Your request "${String(clientInfo.title ?? "Support request")}" is now in progress. The provider has started working on it.`,
        { requestId: params.id, actionUrl: `/support/requests/${params.id}` },
      ).catch((error) => console.warn("[support:whatsapp] Work started WhatsApp failed", error));
    }
    return ok({ data: toCamel(redactProviderRequest(request, isSupportAdminRole(auth.role))), message: "Work started" });
  })
  .post("/admin/requests/:id/mark-error", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [current] = await getDb()`
      SELECT id, status, user_key_id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!current) throw new HttpError(404, "request_not_found", "Support request not found");
    const currentStatus = String(current.status ?? "draft");
    if (!["submitted", "in_progress", "work_ready"].includes(currentStatus)) {
      throw new HttpError(409, "invalid_status_transition", `Cannot mark error on a request with status "${currentStatus}"`);
    }
    const [request] = await getDb()`
      UPDATE support_requests
      SET status = 'error_resend_required', admin_notes = ${body.message ?? body.notes ?? null}, updated_at = NOW()
      WHERE id = ${params.id}::uuid AND status IN ('submitted', 'in_progress', 'work_ready')
      RETURNING *
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    await addSupportEvent(params.id, auth, "admin.error_resend_required", "Admin requested resend", {
      message: body.message ?? body.notes ?? "",
    });
    await invalidateSupportCache(String(current.user_key_id));
    await invalidateProviderSupportCache();
    return ok({ data: toCamel(redactProviderRequest(request, isSupportAdminRole(auth.role))), message: "Marked as error/resend required" });
  }, {
    body: t.Object({ message: t.Optional(t.String()), notes: t.Optional(t.String()) }),
  })
  .post("/admin/requests/:id/deliver", handleDeliverRequest)
  .post("/provider/requests/:id/deliver", handleDeliverRequest)
  .post("/admin/requests/:id/previews/retry", handlePreviewsRetry)
  .post("/provider/requests/:id/previews/retry", handlePreviewsRetry)
  .post("/admin/requests/:id/complete", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const [current] = await getDb()`
      SELECT id, status, payment_status, user_key_id
      FROM support_requests
      WHERE id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!current) throw new HttpError(404, "request_not_found", "Support request not found");
    const currentStatus = String(current.status ?? "draft");
    if (!["in_progress", "work_ready", "downloaded"].includes(currentStatus)) {
      throw new HttpError(409, "invalid_status_transition", `Cannot complete a request with status "${currentStatus}"`);
    }
    const paymentStatus = String(current.payment_status ?? "unpaid");
    if (paymentStatus !== "paid") {
      throw new HttpError(402, "PAYMENT_REQUIRED", "Request must be fully paid before completion");
    }
    const [request] = await getDb()`
      UPDATE support_requests
      SET status = 'completed', updated_at = NOW()
      WHERE id = ${params.id}::uuid AND status IN ('in_progress', 'work_ready', 'downloaded')
      RETURNING *
    `;
    if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    await completeSupportMessageThreads(params.id);
    await addSupportEvent(params.id, auth, "admin.completed", "Request completed");
    await invalidateSupportCache(String(current.user_key_id));
    await invalidateProviderSupportCache();
    const [clientInfo] = await getDb()`
      SELECT c.email, c.full_name, c.whatsapp_number, r.title, r.user_key_id
      FROM support_requests r
      LEFT JOIN support_clients c ON c.id = r.client_id
      WHERE r.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (clientInfo?.email) {
      void sendSupportEmail(
        String(clientInfo.email),
        String(clientInfo.user_key_id),
        "support.request.completed",
        "Your CogniZap request is complete",
        `Your request "${String(clientInfo.title ?? "Support request")}" has been marked as completed. You can download your files from the portal.`,
        { requestId: params.id, actionUrl: `/support/requests/${params.id}` },
      ).catch((error) => console.warn("[support:email] Completion email failed", error));
    }
    if (clientInfo?.whatsapp_number) {
      void sendSupportWhatsApp(
        String(clientInfo.whatsapp_number),
        String(clientInfo.user_key_id),
        "support.request.completed",
        "Your CogniZap request is complete",
        `Your request "${String(clientInfo.title ?? "Support request")}" has been marked as completed. You can download your files from the portal.`,
        { requestId: params.id, actionUrl: `/support/requests/${params.id}` },
      ).catch((error) => console.warn("[support:whatsapp] Completion WhatsApp failed", error));
    }
    return ok({ data: toCamel(redactProviderRequest(request, isSupportAdminRole(auth.role))), message: "Request completed" });
  })
  .get("/admin/payments/pending", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const rows = await getDb()`
      SELECT p.*, r.title, r.task_id, r.payment_status AS request_payment_status,
        c.email, c.full_name, f.file_url AS payment_proof_file_url, f.file_name AS payment_proof_file_name
      FROM support_payments p
      INNER JOIN support_requests r ON r.id = p.request_id
      LEFT JOIN support_clients c ON c.id = r.client_id
      LEFT JOIN support_files f ON f.id = p.proof_file_id
      WHERE p.status = 'submitted'
      ORDER BY p.created_at ASC
      LIMIT 200
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .post("/admin/payments/:id/verify", async ({ headers, params, body }) => {
    await resolveAuth(headers);
    throw new HttpError(
      410,
      "paystack_verification_required",
      "Manual payment verification is disabled. Verify the Paystack reference instead.",
    );
  }, {
    body: t.Object({ notes: t.Optional(t.String()) }),
  })
  .post("/admin/payments/:id/reject", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    throw new HttpError(
      410,
      "paystack_verification_required",
      "Manual payment decisions are disabled. Historical payment proofs are read-only.",
    );
  }, {
    body: t.Object({ reason: t.Optional(t.String()), notes: t.Optional(t.String()) }),
  })
  .get("/admin/refunds/pending", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const rows = await getDb()`
      SELECT rr.*, r.title AS request_title, r.task_id, p.provider_reference,
        p.amount AS payment_amount, p.currency
      FROM support_refund_requests rr
      INNER JOIN support_requests r ON r.id = rr.request_id
      INNER JOIN support_payments p ON p.id = rr.payment_id
      WHERE rr.status IN ('pending', 'approved', 'failed')
      ORDER BY rr.requested_at ASC
    `;
    return ok({ data: rows.map(toCamel) });
  })
  .post("/admin/refunds/:id/process", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");
    const db = getDb();
    const [refund] = await db`
      SELECT rr.*, p.provider_reference, p.amount AS payment_amount, p.currency,
        p.user_key_id, p.request_id
      FROM support_refund_requests rr
      INNER JOIN support_payments p ON p.id = rr.payment_id
      WHERE rr.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!refund) throw new HttpError(404, "refund_not_found", "Refund request not found");
    if (!refund.provider_reference) {
      throw new HttpError(400, "refund_missing_reference", "Payment has no Paystack reference to refund");
    }
    if (String(refund.status) === "processed") {
      throw new HttpError(409, "refund_already_processed", "Refund has already been processed");
    }

    const paymentAmount = Number(refund.payment_amount ?? 0);
    const approvedAmount = roundMoney(Math.min(Number(body.approvedAmount ?? refund.requested_amount), paymentAmount));
    if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
      throw new HttpError(400, "invalid_refund_amount", "Approved refund amount must be greater than zero");
    }

    await db`
      UPDATE support_refund_requests
      SET status = 'approved',
        approved_amount = ${approvedAmount},
        admin_notes = ${body.adminNotes ?? null},
        reviewed_at = NOW(),
        reviewed_by = ${auth.userId},
        updated_at = NOW()
      WHERE id = ${refund.id}
    `;

    try {
      const paystack = await paystackService.createRefund({
        reference: String(refund.provider_reference),
        amount: approvedAmount,
        currency: String(refund.currency ?? "GHS"),
        customerNote: body.customerNote ?? "CognizApp refund approved",
        merchantNote: body.adminNotes ?? `Refund request ${refund.id}`,
      });
      const refundData = (paystack.data ?? {}) as Record<string, any>;
      const refundReference = String(refundData.reference ?? refundData.id ?? refund.id);
      const [updatedRefund] = await db`
        UPDATE support_refund_requests
        SET status = 'processed',
          approved_amount = ${approvedAmount},
          processed_at = NOW(),
          updated_at = NOW()
        WHERE id = ${refund.id}
        RETURNING *
      `;
      await db`
        UPDATE support_payments
        SET refund_status = 'completed',
          refund_amount = ${approvedAmount},
          refunded_at = NOW(),
          updated_at = NOW()
        WHERE id = ${refund.payment_id}
      `;
      await db`
        UPDATE paystack_transactions
        SET refund_status = 'completed',
          refund_amount = ${approvedAmount},
          refund_reference = ${refundReference},
          refunded_at = NOW(),
          updated_at = NOW()
        WHERE support_payment_id = ${refund.payment_id}
      `;
      await addSupportEvent(String(refund.request_id), auth, "payment.refund_processed", "Refund processed", {
        refundId: refund.id,
        approvedAmount,
        refundReference,
      });
      await invalidateSupportCache(String(refund.user_key_id));
      return ok({ data: toCamel(updatedRefund), paystack, message: "Refund processed" });
    } catch (error) {
      await db`
        UPDATE support_refund_requests
        SET status = 'failed',
          admin_notes = COALESCE(${error instanceof Error ? error.message : "Paystack refund failed"}, admin_notes),
          updated_at = NOW()
        WHERE id = ${refund.id}
      `;
      await db`
        UPDATE support_payments
        SET refund_status = 'failed',
          updated_at = NOW()
        WHERE id = ${refund.payment_id}
      `;
      throw error;
    }
  }, {
    body: t.Object({
      approvedAmount: t.Optional(t.Number()),
      adminNotes: t.Optional(t.String()),
      customerNote: t.Optional(t.String()),
    }),
  })
  .post("/admin/requests/:id/verify-payment", async ({ headers, params, body }) => {
    await resolveAuth(headers);
    throw new HttpError(
      410,
      "paystack_verification_required",
      "Manual request payment verification is disabled. Use Paystack verification.",
    );
  }, {
    body: t.Object({
      approved: t.Boolean(),
      notes: t.Optional(t.String()),
    }),
  })
  .post("/admin/revisions/:id/respond", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    if (!canSeeProvider(auth)) requirePermission(auth, "support.tickets.respond");
    const db = getDb();
    const status = body.status ?? (body.isNewProject ? "new_project_required" : "accepted");
    const scopeStatus = body.isNewProject ? "new_project_detected" : "same_project";
    const [revision] = await db`
      UPDATE support_revisions
      SET admin_response = ${body.response ?? body.message ?? ""},
        status = ${status},
        revision_scope_status = ${scopeStatus},
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    if (!revision) throw new HttpError(404, "revision_not_found", "Revision not found");
    await db`
      UPDATE support_requests
      SET status = ${body.isNewProject ? "closed" : "revision_in_progress"},
        delivery_status = ${body.isNewProject ? "accepted" : "revision_requested"},
        updated_at = NOW()
      WHERE id = ${revision.request_id}
    `;
    if (body.isNewProject) {
      await completeSupportMessageThreads(String(revision.request_id));
    }
    await addSupportEvent(revision.request_id, auth, "revision.responded", "Admin responded to revision", {
      revisionId: revision.id,
      status,
      scopeStatus,
    });
    return ok({ data: toCamel(revision), message: "Revision response saved" });
  }, {
    body: t.Object({
      response: t.Optional(t.String()),
      message: t.Optional(t.String()),
      status: t.Optional(t.String()),
      isNewProject: t.Optional(t.Boolean()),
    }),
  })
  .get("/users", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");

    const db = getDb();
    const search = String(query.search ?? "").trim();
    const like = search ? `%${search}%` : null;
    const rows = like
      ? await db`
          SELECT id, email, display_name, role, status, created_at
          FROM auth.users
          WHERE email ILIKE ${like} OR display_name ILIKE ${like}
          ORDER BY created_at DESC
          LIMIT 100
        `
      : await db`
          SELECT id, email, display_name, role, status, created_at
          FROM auth.users
          ORDER BY created_at DESC
          LIMIT 100
        `;

    return ok({ users: rows });
  }, {
    query: t.Object({
      search: t.Optional(t.String()),
    }),
  })
  .get("/users/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.users.inspect");

    const db = getDb();
    const [user] = await db`
      SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at,
        (SELECT COUNT(*)::int FROM workspaces w WHERE w.owner_uid = u.id::text AND w.deleted_at IS NULL) AS owned_workspaces
      FROM auth.users u
      WHERE u.id = ${params.id}::uuid
      LIMIT 1
    `;
    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }

    return ok({ user });
  })
  .post("/users/:id/message", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "support.tickets.respond");

    const db = getDb();
    const [target] = await db`SELECT id, email FROM auth.users WHERE id = ${params.id}::uuid LIMIT 1`;
    if (!target) {
      throw new HttpError(404, "user_not_found", "User not found");
    }

    const notification = await notificationsRepository.insert({
      userId: String(target.id),
      type: "support.message",
      category: "support",
      title: body.title,
      body: body.body,
      actorId: auth.userId,
      actorType: auth.actorType,
      actorKey: auth.userId,
      metadata: {
        supportUserId: auth.userId,
      },
    });

    await auditRepository.insert({
      actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
      action: "support.message.sent",
      targetType: "notification",
      targetId: notification.id,
      metadata: { userId: String(target.id) },
    });

    return ok({ notification, message: "Support message sent" });
  }, {
    body: t.Object({
      title: t.String(),
      body: t.String(),
    }),
  });
