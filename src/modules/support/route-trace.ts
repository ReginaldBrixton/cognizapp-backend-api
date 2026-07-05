/**
 * Route tracing wrapper for the support module.
 *
 * Wraps an Elysia route handler so that every invocation automatically logs:
 *  - request start (with operation, method, path, params, query)
 *  - request completion (with status, duration)
 *  - request failure (with error details, status)
 *
 * The wrapper preserves the handler's return value and re-throws errors so the
 * Elysia `onError` handler still runs normally.
 *
 * Usage:
 *   .post("/cost-estimate", traceRoute("cost-estimate", async ({ headers, body }) => {
 *     ...
 *   }), { body: t.Record(t.String(), t.Any()) })
 *
 * The `traceRoute` wrapper also exposes the logger on the context via
 * `ctx.log` so handlers can add structured logs inside their body:
 *
 *   .post("/checkout", traceRoute("payments.checkout", async ({ headers, body, log }) => {
 *     log.info("creating checkout session", { paymentType: body.paymentType });
 *     ...
 *   }))
 */

import { HttpError } from "../../lib/errors";
import { createSupportLogger, type SupportLogger } from "./logger";

type ElysiaContext = {
	headers?: Record<string, string | undefined>;
	params?: Record<string, string>;
	query?: Record<string, unknown>;
	body?: unknown;
	set?: { status?: number };
	request?: Request;
	[key: string]: unknown;
};

type TracedHandler<C extends ElysiaContext = ElysiaContext> = (
	ctx: C & { log: SupportLogger },
) => Promise<unknown> | unknown;

type TraceMeta = Record<string, unknown>;

function safeRouteContext(ctx: ElysiaContext): TraceMeta {
	const meta: TraceMeta = {};
	if (ctx.params) meta.params = ctx.params;
	if (ctx.query && typeof ctx.query === "object" && Object.keys(ctx.query).length > 0) {
		meta.query = ctx.query;
	}
	try {
		if (ctx.request) {
			const url = new URL(ctx.request.url);
			meta.method = ctx.request.method;
			meta.path = url.pathname;
		}
	} catch {
		// ignore URL parse errors
	}
	return meta;
}

/**
 * Wrap a route handler with automatic structured logging.
 *
 * @param operation  Dotted operation name, e.g. "payments.checkout", "files.upload"
 * @param handler    The original Elysia handler. Receives an augmented context with `log`.
 */
export function traceRoute<C extends ElysiaContext>(
	operation: string,
	handler: TracedHandler<C>,
): (ctx: C) => Promise<unknown> {
	return async (ctx: C) => {
		const log = createSupportLogger(operation);
		const contextMeta = safeRouteContext(ctx);

		// Attach logger to context so the handler can use it
		const augmentedCtx = Object.assign(ctx, { log }) as C & { log: SupportLogger };

		log.info("request.start", contextMeta);
		try {
			const result = await handler(augmentedCtx);
			const status = ctx.set?.status ?? 200;
			log.done(status);
			return result;
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			const errorMeta: TraceMeta = { status };
			if (error instanceof HttpError) {
				errorMeta.errorCode = error.code;
			}
			log.error("request.failed", error, errorMeta);
			throw error;
		}
	};
}
