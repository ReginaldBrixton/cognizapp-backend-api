import { Elysia, t } from "elysia";

import { HttpError } from "../../lib/errors";
import { emailDelivery } from "../../lib/email-delivery";
import { fail, ok } from "../../lib/http";
import { resolveAuth } from "../auth/middleware";
import { settingsRepository } from "../user-settings/repository";

export const feedbackRoutes = new Elysia({
  prefix: "/api/feedback",
  tags: ["feedback"],
})
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })

  // ── POST /api/feedback/submit ───────────────────────────────────────────────
  .post(
    "/submit",
    async ({ headers, body, request }) => {
      const auth = await resolveAuth(headers);
      
      const { feedback, category, source, pageUrl } = body as {
        feedback: string;
        category?: string;
        source?: string;
        pageUrl?: string;
      };
      
      if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
        throw new HttpError(400, "invalid_feedback", "Feedback text is required");
      }

      const userAgent = request.headers.get("user-agent") ?? "Unknown";
      const settings = await settingsRepository.getUserSettings(auth.userId).catch((error) => {
        console.warn("[feedback] Failed to load user settings for feedback context", {
          userId: auth.userId,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      const user = auth.user;
      const profile = (settings?.profile ?? {}) as Record<string, unknown>;
      const institution = (settings?.institution ?? {}) as Record<string, unknown>;
      const userName =
        user?.displayName ||
        user?.fullName ||
        String(profile.display_name ?? profile.displayName ?? profile.full_name ?? profile.fullName ?? "") ||
        auth.email;
      
      const result = await emailDelivery.sendFeedbackEmail({
        feedback: feedback.trim(),
        category,
        source,
        pageUrl,
        userEmail: auth.email,
        userId: auth.userId,
        userName,
        userRole: auth.role,
        userStatus: user?.status,
        institution,
        profile,
        userAgent,
      });

      if (!result.ok) {
        throw new HttpError(500, "email_failed", "Failed to send feedback email");
      }

      return ok({ message: "Feedback sent successfully" });
    },
    {
      body: t.Object({
        feedback: t.String(),
        category: t.Optional(t.String()),
        source: t.Optional(t.String()),
        pageUrl: t.Optional(t.String()),
      }),
    },
  );
