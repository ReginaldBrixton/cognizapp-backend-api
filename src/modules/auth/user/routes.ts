import { Elysia, t } from "elysia";

import { env } from "../../../config/env";
import { HttpError } from "../../../lib/errors";
import { fail, ok } from "../../../lib/http";
import { isTransientDbError } from "../../../lib/db";
import { resolveAuth } from "../middleware";
import { getForwardedIp, readHeader, refreshCookie } from "../helpers";
import { otpService } from "./otp-service";
import { userAuthService } from "./service";

const otpRequestBody = t.Object({
  email: t.String({ format: "email" }),
  requirePrivilegedAccess: t.Optional(t.Boolean()),
  selectedRole: t.Optional(t.String()),
});

const otpVerifyBody = t.Object({
  email: t.String({ format: "email" }),
  code: t.String({ minLength: 6, maxLength: 6 }),
  selectedRole: t.Optional(t.String()),
});

const magicLinkVerifyBody = t.Object({
  token: t.String({ minLength: 16 }),
  selectedRole: t.Optional(t.String()),
});

const firebaseExchangeBody = t.Object({
  firebaseToken: t.String(),
  selectedRole: t.Optional(t.String()),
});

export const userAuthRoutes = new Elysia({ prefix: "/api/auth", tags: ["auth"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION" || code === "PARSE") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
    if (isTransientDbError(error)) {
      console.error("[auth:user] transient DB error", {
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      set.status = 503;
      return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
    }
    console.error("[auth:user] unhandled route error", {
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: env.isDevelopment && error instanceof Error ? error.stack : undefined,
    });
    set.status = 500;
    return fail("Internal server error", "internal_error");
  })
  .get("/health", () => ok({ status: "ok", service: "auth" }))
  .post(
    "/firebase/exchange",
    async ({ body, headers, request, server, set, cookie }) => {
      try {
        const metadata = {
          ipAddress: getForwardedIp(headers, request, server),
          userAgent: readHeader(headers, "user-agent"),
          selectedRole: body.selectedRole,
        };
        const res = await userAuthService.loginWithGoogle(body.firebaseToken, headers, metadata);
        set.status = res.isNewUser ? 201 : 200;
        if (res.refreshToken) {
          cookie.refresh_token.set(refreshCookie(res.refreshToken));
        }
        return ok({
          accessToken: res.accessToken,
          expiresIn: res.expiresIn,
          authAction: res.authAction,
          isNewUser: res.isNewUser,
        });
      } catch (error) {
        console.error("Error in firebase/exchange:", error);
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        set.status = 500;
        return fail("Failed to exchange firebase token", "exchange_failed");
      }
    },
    {
      body: firebaseExchangeBody,
    },
  )
  .post(
    "/otp/request",
    async ({ body, headers, request, server, set }) => {
      try {
        return await otpService.requestOtp(
          body.email,
          getForwardedIp(headers, request, server),
          readHeader(headers, "user-agent"),
          body.requirePrivilegedAccess ?? false,
          body.selectedRole,
        );
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        if (isTransientDbError(error)) {
          console.error("[auth:user] OTP request DB error:", error instanceof Error ? error.message : String(error));
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        console.error("[auth:user] OTP request failed:", error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
        set.status = 500;
        return fail("Failed to send OTP", "otp_request_failed");
      }
    },
    { body: otpRequestBody },
  )
  .post(
    "/otp/resend",
    async ({ body, headers, request, server, set }) => {
      try {
        return await otpService.requestOtp(
          body.email,
          getForwardedIp(headers, request, server),
          readHeader(headers, "user-agent"),
          body.requirePrivilegedAccess ?? false,
          body.selectedRole,
        );
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        if (isTransientDbError(error)) {
          console.error("[auth:user] OTP resend DB error:", error instanceof Error ? error.message : String(error));
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        console.error("[auth:user] OTP resend failed:", error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
        set.status = 500;
        return fail("Failed to send OTP", "otp_request_failed");
      }
    },
    { body: otpRequestBody },
  )
  .post(
    "/otp/verify",
    async ({ body, headers, request, server, cookie, set }) => {
      try {
        const response = await otpService.verifyOtp(
          body.email,
          body.code,
          headers,
          getForwardedIp(headers, request, server),
          readHeader(headers, "user-agent"),
          body.selectedRole,
        );
        if (response.refreshToken) {
          cookie.refresh_token.set(refreshCookie(response.refreshToken));
        }
        return response;
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        if (isTransientDbError(error)) {
          console.error("[auth:user] OTP verify DB error:", error instanceof Error ? error.message : String(error));
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        set.status = 500;
        return fail("OTP verification failed", "otp_verify_failed");
      }
    },
    { body: otpVerifyBody },
  )
  .post(
    "/magic-link/verify",
    async ({ body, headers, request, server, cookie, set }) => {
      try {
        const response = await otpService.verifyMagicLink(
          body.token,
          headers,
          getForwardedIp(headers, request, server),
          readHeader(headers, "user-agent"),
          body.selectedRole,
        );
        if (response.refreshToken) {
          cookie.refresh_token.set(refreshCookie(response.refreshToken));
        }
        return response;
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        if (isTransientDbError(error)) {
          console.error("[auth:user] magic-link verify DB error:", error instanceof Error ? error.message : String(error));
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        set.status = 500;
        return fail("Magic link verification failed", "magic_link_verify_failed");
      }
    },
    { body: magicLinkVerifyBody },
  )
  .post(
    "/refresh",
    async ({ body, headers, cookie, set }) => {
      const token = String(cookie.refresh_token.value ?? body.refreshToken ?? body.refresh_token ?? "");
      if (!token) {
        set.status = 401;
        return fail("Missing refresh token", "missing_refresh_token");
      }

      try {
        const response = await userAuthService.refresh(token, headers);
        if (response.refreshToken) {
          cookie.refresh_token.set(refreshCookie(response.refreshToken));
        }
        return response;
      } catch (error) {
        cookie.refresh_token.remove();
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        set.status = 401;
        return fail("Refresh token is invalid or expired", "invalid_refresh_token");
      }
    },
    {
      body: t.Object({
        refreshToken: t.Optional(t.String()),
        refresh_token: t.Optional(t.String()),
      }),
    },
  )
  .post('/logout', async ({ headers, cookie }) => {
    // Always clear the refresh token cookie regardless of whether the access
    // token is still valid. Previously, an expired access token would cause
    // resolveAuth to throw 401, leaving the cookie in place even though the
    // user was already logged out in the UI. This ensures the cookie is always
    // purged on any logout attempt.
    try {
      const auth = await resolveAuth(headers)
      await userAuthService.logout(auth.sessionId, auth.userId)
    } catch (error) {
      // Token may already be expired — log and continue to clear the cookie.
      const message = error instanceof Error ? error.message : String(error)
      console.info('[auth:logout] resolveAuth failed (token likely expired), clearing cookie anyway:', message)
    }
    cookie.refresh_token.remove()
    return ok({ message: 'Logged out successfully' })
  })
  .post("/logout-all", async ({ headers, query, cookie }) => {
    const auth = await resolveAuth(headers);
    const keepCurrent = String(query.keep_current ?? "") === "true";
    await userAuthService.logoutAll(auth.userId, keepCurrent ? auth.sessionId : undefined);
    if (!keepCurrent) {
      cookie.refresh_token.remove();
    }
    return ok({ message: "Logged out from all devices" });
  })
  .get("/me", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    return ok({ user: auth.user ?? await userAuthService.me(auth.userId) });
  })
  .get("/sessions", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    return ok({ sessions: await userAuthService.listSessions(auth.userId, auth.sessionId) });
  })
  .delete("/sessions/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const sessionId = String(params.id);
    if (sessionId === auth.sessionId) {
      throw new HttpError(400, "cannot_revoke_current", "Use /logout to revoke current session");
    }
    await userAuthService.revokeSession(sessionId, auth.userId);
    return ok({ message: "Session revoked" });
  })
  .get("/identities", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    return ok({ identities: await userAuthService.identities(auth.userId) });
  });
