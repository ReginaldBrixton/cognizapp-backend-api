/**
 * Support routes — thin assembler.
 *
 * This file was previously a 3,758-line monolith. It now simply:
 *  1. Creates the parent Elysia instance with the `/api/support` prefix.
 *  2. Registers structured request/response logging hooks (auto-tracing).
 *  3. Wires up the domain-specific sub-routers from `./routes/`.
 *
 * To debug a specific route, look in the corresponding file under `routes/`:
 *   - routes/misc.ts             — cost-estimate, status checks, paystack config/webhook, payment-settings
 *   - routes/codes.ts            — discount/referral code validation
 *   - routes/client-requests.ts  — request CRUD, submit, cancel, drafts, files list, events, history
 *   - routes/payments.ts         — paystack checkout, mobile-money, OTP, PIN, verify, cancel, refund-requests
 *   - routes/files.ts            — file upload, patch, delete, download
 *   - routes/quotes.ts           — quote list, detail, accept, decline
 *   - routes/orders.ts           — order list, detail
 *   - routes/deliveries.ts       — delivery list, download
 *   - routes/previews.ts         — preview list, preview-page content, preview content
 *   - routes/milestones.ts       — milestone list, detail, accept, history
 *   - routes/revisions.ts        — revision requests
 *
 * Every request is automatically logged with a unique `requestId` that appears
 * in all log lines for that request. Search logs by `requestId` to trace a
 * single request end-to-end.
 */

import { Elysia } from "elysia";

import { env } from "../../config/env";
import { HttpError } from "../../lib/errors";
import { fail } from "../../lib/http";
import { isRequestBodyParseError } from "./utils";
import { generateRequestId, emit } from "./logger";

import { miscRoutes } from "./routes/misc";
import { codesRoutes } from "./routes/codes";
import { clientRequestRoutes } from "./routes/client-requests";
import { paymentRoutes } from "./routes/payments";
import { fileRoutes } from "./routes/files";
import { quoteRoutes } from "./routes/quotes";
import { orderRoutes } from "./routes/orders";
import { deliveryRoutes } from "./routes/deliveries";
import { previewRoutes } from "./routes/previews";
import { milestoneRoutes } from "./routes/milestones";
import { revisionRoutes } from "./routes/revisions";

// ── Per-request log context (correlated via the Request object) ──────────────

type RequestLogCtx = {
	requestId: string;
	startedAt: number;
	method: string;
	path: string;
};

const requestLogMap = new WeakMap<Request, RequestLogCtx>();

function routeContextFromRequest(request: Request | undefined): Partial<RequestLogCtx> {
	if (!request) return {};
	try {
		const url = new URL(request.url);
		return { method: request.method, path: url.pathname };
	} catch {
		return {};
	}
}

// ── Parent Elysia with prefix, auto-logging, and error handling ──────────────

export const supportRoutes = new Elysia({
	prefix: "/api/support",
	tags: ["support"],
})
  // ── Request start: generate requestId and log ───────────────────────────
  .onRequest(({ request }) => {
	const requestId = generateRequestId();
	const ctx: RequestLogCtx = {
		requestId,
		startedAt: Date.now(),
		...routeContextFromRequest(request),
	} as RequestLogCtx;
	requestLogMap.set(request, ctx);
	emit("info", {
		message: "request.start",
		module: "support",
		...ctx,
	});
})
  // ── Successful completion: log duration + status ───────────────────────
  .onAfterHandle(({ request, set }) => {
	const ctx = requestLogMap.get(request);
	if (!ctx) return;
	emit("info", {
		message: "request.completed",
		module: "support",
		...ctx,
		status: set.status ?? 200,
		durationMs: Date.now() - ctx.startedAt,
	});
	requestLogMap.delete(request);
})
  // ── Error handler: log error with requestId, return structured response ─
  .onError(({ code, error, set, request }) => {
	const ctx = requestLogMap.get(request);
	const requestId = ctx?.requestId;
	const routeCtx = ctx ? { method: ctx.method, path: ctx.path } : routeContextFromRequest(request);

	if (error instanceof HttpError) {
		emit("warn", {
			message: "request.error",
			module: "support",
			requestId,
			...routeCtx,
			status: error.status,
			errorCode: error.code,
			errorMessage: error.message,
		});
		set.status = error.status;
		return fail(error.message, error.code, error.details);
	}
	if (code === "VALIDATION" || code === "PARSE" || isRequestBodyParseError(error)) {
		emit("warn", {
			message: "request.error",
			module: "support",
			requestId,
			...routeCtx,
			status: 400,
			errorCode: "invalid_request",
		});
		set.status = 400;
		return fail("Invalid request body", "invalid_request");
	}
	emit("error", {
		message: "request.error",
		module: "support",
		requestId,
		...routeCtx,
		code,
		errorMessage: error instanceof Error ? error.message : String(error),
		stack: env.isDevelopment && error instanceof Error ? error.stack : undefined,
	});
	set.status = 500;
	return fail("Support request failed", "support_internal_error");
})
  // ── Wire up domain sub-routers ──────────────────────────────────────────
  .use(miscRoutes)
  .use(codesRoutes)
  .use(clientRequestRoutes)
  .use(paymentRoutes)
  .use(fileRoutes)
  .use(quoteRoutes)
  .use(orderRoutes)
  .use(deliveryRoutes)
  .use(previewRoutes)
  .use(milestoneRoutes)
  .use(revisionRoutes);
