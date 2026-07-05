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

export const clientRequestRoutes = new Elysia()
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
          is_voice_note, duration_seconds,
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
        f.is_voice_note,
        f.duration_seconds,
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

;
