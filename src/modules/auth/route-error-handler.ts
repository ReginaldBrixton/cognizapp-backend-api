/**
 * Shared Elysia error handler for auth route groups.
 *
 * Both `users/routes.ts` and `providers/routes.ts` mount Elysia instances under
 * the `/api/auth` prefix. Rather than duplicate the ~20-line onError block in
 * each file, we extract it here and parameterize the log label.
 */

import { env } from "../../config/env";
import { HttpError } from "../../lib/errors";
import { fail } from "../../lib/http";
import { isTransientDbError } from "../../lib/db";

// Elysia's onError callback signature is complex and version-specific. We use
// `any` here so the handler works across Elysia versions without import churn.
// The runtime contract is: { code, error, set }.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function authErrorHandler(label: string) {
  return ({ code, error, set }: any) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION" || code === "PARSE") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
    if (isTransientDbError(error)) {
      console.error(`[${label}] transient DB error`, {
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      set.status = 503;
      return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
    }
    console.error(`[${label}] unhandled route error`, {
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: env.isDevelopment && error instanceof Error ? error.stack : undefined,
    });
    set.status = 500;
    return fail("Internal server error", "internal_error");
  };
}
