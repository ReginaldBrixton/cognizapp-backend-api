import { Elysia, t } from "elysia";

import { env } from "../../../config/env";
import { safeEqualString } from "../../../lib/crypto";
import { HttpError } from "../../../lib/errors";
import { fail } from "../../../lib/http";
import {
  type HeaderBag,
  getForwardedIp,
  getRequestIpAddress,
  isLoopbackAddress,
  readHeader,
  refreshCookie,
} from "../helpers";
import { adminAuthService } from "./service";

const devTokenBody = t.Object({
  userId: t.Optional(t.String()),
  email: t.Optional(t.String()),
});

const devImpersonationBody = t.Object({
  userId: t.Optional(t.String()),
  email: t.Optional(t.String()),
  reason: t.Optional(t.String()),
});

function assertDevTokenAccess(headers: HeaderBag, request: Request, server: unknown) {
  const providedSecret = readHeader(headers, "x-dev-auth-secret");
  if (!providedSecret) {
    throw new HttpError(401, "missing_dev_auth_secret", "Missing x-dev-auth-secret header");
  }

  if (!safeEqualString(providedSecret, env.devAuthEndpointSecret)) {
    throw new HttpError(401, "invalid_dev_auth_secret", "Invalid development auth secret");
  }

  const ipAddress = getRequestIpAddress(request, server);
  if (!isLoopbackAddress(ipAddress)) {
    throw new HttpError(403, "loopback_only", "Development auth endpoint only accepts loopback requests");
  }

  return ipAddress;
}

function assertDevImpersonationAccess(headers: HeaderBag, request: Request, server: unknown) {
  const providedSecret = readHeader(headers, "x-dev-impersonation-secret");
  if (!providedSecret) {
    throw new HttpError(401, "missing_dev_impersonation_secret", "Missing x-dev-impersonation-secret header");
  }

  if (!safeEqualString(providedSecret, env.devImpersonationSecret)) {
    throw new HttpError(401, "invalid_dev_impersonation_secret", "Invalid development impersonation secret");
  }

  const ipAddress = getRequestIpAddress(request, server);
  if (!isLoopbackAddress(ipAddress)) {
    throw new HttpError(403, "loopback_only", "Development impersonation only accepts loopback requests");
  }

  return ipAddress;
}

const adminAuthRoutesBase = new Elysia({ prefix: "/api/auth", tags: ["auth:admin"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request", "invalid_request");
    }
    console.error("[auth:admin] unhandled route error", {
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: env.isDevelopment && error instanceof Error ? error.stack : undefined,
    });
    set.status = 500;
    return fail("Internal server error", "internal_error");
  });

const adminAuthRoutesWithDevToken =
  env.isDevelopment && env.devAuthEndpointEnabled
    ? adminAuthRoutesBase.post(
      "/dev/token",
      async ({ body, headers, request, server, cookie, set }) => {
        try {
          const ipAddress = assertDevTokenAccess(headers, request, server);
          const response = await adminAuthService.simulateLogin(
            {
              userId: body.userId,
              email: body.email,
            },
            {
              headers,
              ipAddress,
            },
          );

          cookie.refresh_token.set(refreshCookie(response.refreshToken ?? ""));
          return response;
        } catch (error) {
          if (error instanceof HttpError) {
            set.status = error.status;
            return fail(error.message, error.code, error.details);
          }
          set.status = 500;
          return fail("Dev token generation failed", "dev_token_failed");
        }
      },
      {
        body: devTokenBody,
      },
    )
    : adminAuthRoutesBase;

export const adminAuthRoutes =
  env.isDevelopment && env.devImpersonationEnabled
    ? adminAuthRoutesWithDevToken.post(
      "/dev/impersonate",
      async ({ body, headers, request, server, cookie, set }) => {
        try {
          const ipAddress = assertDevImpersonationAccess(headers, request, server);
          const response = await adminAuthService.impersonateForDevelopment(
            {
              userId: body.userId,
              email: body.email,
              reason: body.reason,
            },
            {
              headers,
              ipAddress,
              allowPrivileged: env.devImpersonationAllowPrivileged,
              allowedEmails: env.devImpersonationAllowedEmails,
            },
          );

          cookie.refresh_token.set(refreshCookie(response.refreshToken ?? ""));
          return response;
        } catch (error) {
          if (error instanceof HttpError) {
            set.status = error.status;
            return fail(error.message, error.code, error.details);
          }
          set.status = 500;
          return fail("Dev impersonation failed", "dev_impersonate_failed");
        }
      },
      {
        body: devImpersonationBody,
      },
    )
    : adminAuthRoutesWithDevToken;
