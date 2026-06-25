import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { env } from "../config/env";
import { ok } from "../lib/http";
import { runMigrations } from "../lib/migrations";
import { uploadthingConfigured } from "../lib/uploadthing";
import { adminRoutes } from "../modules/admin/routes";
import { aiBotRoutes } from "../modules/ai-bot/routes";
import { adminAuthRoutes } from "../modules/auth/admin/routes";
import { userAuthRoutes } from "../modules/auth/user/routes";
import { billingRoutes } from "../modules/billing/routes";
import { feedbackRoutes } from "../modules/feedback/routes";
import { notificationRoutes } from "../modules/notifications/routes";
import { onboardingRoutes } from "../modules/onboarding/routes";
import { projectDashboardRoutes } from "../modules/project-dashboard/routes";
import { diagramRoutes } from "../modules/project-diagram/routes";
import { documentCommentRoutes } from "../modules/project-document-comments/routes";
import { documentRoutes } from "../modules/project-documents/routes";
import { noteRoutes } from "../modules/project-notes/routes";
import { slideRoutes } from "../modules/project-slides/routes";
import { taskRoutes } from "../modules/project-tasks/routes";
import { referralRoutes } from "../modules/referrals/routes";
import { supportRoutes } from "../modules/support/routes";
import { supportAiRoutes } from "../modules/support-inbox/ai-routes";
import { providerSettingsRoutes, supportInboxRoutes } from "../modules/support-inbox/routes";
import { supportMessagesRoutes } from "../modules/support-messages/routes";
import { systemService } from "../modules/system/service";
import { taskListRoutes } from "../modules/task-lists/routes";
import { testingRoutes } from "../modules/testing/routes";
import { dashboardRoutes } from "../modules/user-dashboard/routes";
import { settingsRoutes } from "../modules/user-settings/routes";
import { workspaceRoutes } from "../modules/workspace/routes";
import { analysisRoutes } from "../modules/workspace-analysis/routes";
import { collectionRoutes } from "../modules/workspace-collections/routes";
import { projectRoutes } from "../modules/workspace-projects/routes";
import { workspaceSettingsRoutes } from "../modules/workspace-settings/routes";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://cognizapp.com",
  "https://www.cognizapp.com",
  "https://admin.cognizapp.com",
  "https://provider.cognizapp.com",
]);
const requestStartTimes = new WeakMap<Request, number>();

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getLoggedUserId(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const [, token] = authorization.match(/^Bearer\s+(.+)$/i) ?? [];
  if (!token) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(token.split(".")[1] ?? ""));
    return String(payload.userId ?? payload.sub ?? payload.uid ?? "") || null;
  } catch {
    return null;
  }
}

function redactLogPreview(value: string) {
  return value
    .replace(/("?(?:password|token|secret|key|authorization)"?\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
}

function logApiEvent(event: string, payload: Record<string, unknown>) {
  const entry = {
    event,
    timestamp: new Date().toISOString(),
    environment: env.environment,
    ...payload,
  };

  if (env.isProduction) {
    console.log(JSON.stringify(entry));
    return;
  }

  console.log(`[${event}]`, entry);
}

function isDevelopmentLoopbackOrigin(origin: string) {
  if (!env.isDevelopment) {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function resolveAllowedOrigin(origin: string) {
  return ALLOWED_ORIGINS.has(origin) || isDevelopmentLoopbackOrigin(origin) ? origin : "";
}

export async function createApp() {
  await runMigrations();
  await systemService.ensureDefaultActor();

  logApiEvent("startup.database", {
    databaseMode: env.isProduction ? "production" : "development",
  });
  logApiEvent("startup.integrations", {
    uploadthingConfigured: uploadthingConfigured(),
    emailWebhookConfigured: Boolean(env.n8nGmailSendWebhookUrl),
    gmailWebhookConfigured: Boolean(env.n8nGmailSendWebhookUrl),
  });

  const app = new Elysia()
    .onRequest(({ request, set }) => {
      const origin = resolveAllowedOrigin(
        request?.headers?.get("origin") ?? request?.headers?.get("Origin") ?? "",
      );
      if (origin) {
        set.headers["Access-Control-Allow-Origin"] = origin;
        set.headers.Vary = "Origin";
      }
      set.headers["Access-Control-Allow-Credentials"] = "true";
      set.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
      set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      set.headers["X-Content-Type-Options"] = "nosniff";
      set.headers["X-Frame-Options"] = "DENY";
      set.headers["Referrer-Policy"] = "no-referrer";
      set.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
      set.headers["Cross-Origin-Resource-Policy"] = "same-site";
      if (env.isProduction) {
        set.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload";
      }

      if (request?.method === "OPTIONS") {
        set.status = 204;
        return "";
      }
    })
    .onBeforeHandle(async ({ request }) => {
      requestStartTimes.set(request, Date.now());
      const url = new URL(request.url);
      logApiEvent("api.request.start", {
        method: request.method,
        path: url.pathname,
        query: url.search || "",
        userId: getLoggedUserId(request),
      });
      console.log(`\n[API →] ${request.method} ${url.pathname}${url.search}`);
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        try {
          const cloned = request.clone();
          const body = await cloned.text();
          if (body) {
            const preview = body.length > 300 ? `${body.substring(0, 300)}...` : body;
            logApiEvent("api.request.body_preview", {
              method: request.method,
              path: url.pathname,
              userId: getLoggedUserId(request),
              preview: redactLogPreview(preview),
            });
            console.log(`[API ->] Body: ${redactLogPreview(preview)}`);
          }
        } catch {
          // body already consumed or unavailable
        }
      }
    })
    .onAfterResponse(({ request, set }) => {
      const start = requestStartTimes.get(request);
      const duration = start ? Date.now() - start : 0;
      const url = new URL(request.url);
      const statusStr = String(set.status || "200");
      const statusCode = parseInt(statusStr, 10);
      logApiEvent("api.request.finish", {
        method: request.method,
        path: url.pathname,
        statusCode,
        outcome: statusCode >= 400 ? "failed" : statusCode >= 300 ? "redirect" : "ok",
        durationMs: duration,
        userId: getLoggedUserId(request),
        plainEnglish:
          statusCode >= 500
            ? "The backend hit a server-side problem while handling this request."
            : statusCode >= 400
              ? "The backend rejected this request. Check auth, request body, or permissions."
              : "The backend handled this request successfully.",
      });
      const statusColor = statusCode >= 400 ? "❌" : statusCode >= 300 ? "↗️" : "✅";
      console.log(
        `[API ${statusColor}] ${request.method} ${url.pathname} → ${statusCode} (${duration}ms)`,
      );
    })
    .get("/", () => ok({ status: "ok", message: "CognizApp Users API is running" }))
    .get("/health", () => "OK")
    .use(userAuthRoutes)
    .use(adminAuthRoutes)
    .use(workspaceRoutes)
    .use(projectRoutes)
    .use(analysisRoutes)
    .use(collectionRoutes)
    .use(workspaceSettingsRoutes)
    .use(notificationRoutes)
    .use(settingsRoutes)
    .use(dashboardRoutes)
    .use(onboardingRoutes)
    .use(adminRoutes)
    .use(billingRoutes)
    .use(feedbackRoutes)
    .use(referralRoutes)
    .use(supportRoutes)
    .use(providerSettingsRoutes)
    .use(supportInboxRoutes)
    .use(supportAiRoutes)
    .use(supportMessagesRoutes)
    .use(documentRoutes)
    .use(documentCommentRoutes)
    .use(slideRoutes)
    .use(noteRoutes)
    .use(taskRoutes)
    .use(taskListRoutes)
    .use(projectDashboardRoutes)
    .use(diagramRoutes)
    .use(aiBotRoutes);

  if (env.isDevelopment) {
    app.use(
      swagger({
        path: "/docs",
        documentation: {
          info: { title: "CognizApp Users API", version: "1.0.0" },
        },
      }),
    );
    app.get(env.localTestingPath, () =>
      ok({
        status: "ok",
        message: "CognizApp Users local smoke test endpoint is running",
        environment: env.environment,
        docs: "/docs",
        health: "/health",
      }),
    );
    app.use(testingRoutes);
  }

  return app;
}
