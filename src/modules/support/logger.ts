/**
 * Structured support-module logger.
 *
 * Every route handler in the support module should use `createSupportLogger()`
 * (or the `traceRoute` wrapper from `route-trace.ts`) so that requests can be
 * traced end-to-end via a shared `requestId`.
 *
 * Log lines are emitted as JSON to stdout/stderr so they can be ingested by
 * structured-log aggregators (Vercel logs, Datadog, etc.).
 *
 * Usage:
 *   const log = createSupportLogger("payments.checkout", { requestId });
 *   log.info("starting checkout", { paymentType });
 *   log.warn("paystack fallback", { reference });
 *   log.error("checkout failed", error);
 */

import { env } from "../../config/env";

export type SupportLogLevel = "debug" | "info" | "warn" | "error";

export interface SupportLogContext {
	/** Stable identifier for the logical operation, e.g. "payments.checkout". */
	operation: string;
	/** Per-request correlation ID (auto-generated if absent). */
	requestId?: string;
	/** Extra fields merged into every log line for this context. */
	[key: string]: unknown;
}

let supportRequestCounter = 0;

export function generateRequestId(): string {
	supportRequestCounter = (supportRequestCounter + 1) % 1_000_000;
	return `sup-${Date.now().toString(36)}-${supportRequestCounter.toString(36).padStart(4, "0")}`;
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: env.isDevelopment ? error.stack : undefined,
			cause: error.cause instanceof Error ? error.cause.message : undefined,
		};
	}
	return { message: String(error) };
}

export function emit(level: SupportLogLevel, payload: Record<string, unknown>) {
	const line = JSON.stringify({ level, ts: new Date().toISOString(), ...payload });
	if (level === "error" || level === "warn") {
		console.error(line);
	} else {
		console.log(line);
	}
}

export interface SupportLogger {
	readonly requestId: string;
	readonly operation: string;
	debug(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
	/** Create a child logger that inherits requestId + operation and adds extra context. */
	child(extra: Record<string, unknown>): SupportLogger;
	/** Log completion with duration and status. */
	done(status: number, meta?: Record<string, unknown>): void;
}

export function createSupportLogger(
	operation: string,
	extra?: Record<string, unknown>,
): SupportLogger {
	const requestId = (extra?.requestId as string) || generateRequestId();
	const baseContext: Record<string, unknown> = { module: "support", operation, requestId, ...extra };
	const startedAt = Date.now();

	function log(
		level: SupportLogLevel,
		message: string,
		meta?: Record<string, unknown>,
		errorData?: Record<string, unknown>,
	) {
		emit(level, { message, ...baseContext, ...meta, ...errorData });
	}

	return {
		requestId,
		operation,
		debug(message, meta) {
			if (env.isDevelopment) log("debug", message, meta);
		},
		info(message, meta) {
			log("info", message, meta);
		},
		warn(message, meta) {
			log("warn", message, meta);
		},
		error(message, error?, meta?) {
			log("error", message, meta, error ? { error: serializeError(error) } : undefined);
		},
		child(extraChild) {
			return createSupportLogger(operation, { ...baseContext, ...extraChild });
		},
		done(status, meta) {
			const durationMs = Date.now() - startedAt;
			emit("info", {
				message: "request.completed",
				...baseContext,
				status,
				durationMs,
				...meta,
			});
		},
	};
}
