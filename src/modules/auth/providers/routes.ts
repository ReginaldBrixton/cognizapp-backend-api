import { Elysia, t } from "elysia";

import { HttpError } from "../../../lib/errors";
import { fail, ok } from "../../../lib/http";
import { isTransientDbError } from "../../../lib/db";
import { resolveAuth } from "../middleware";
import { readHeader, refreshCookie } from "../helpers";
import { authErrorHandler } from "../route-error-handler";
import { pinService, pinLoginMetadataFromHeaders } from "./pin-service";

const pinLoginBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 64 }),
  pin: t.String({ minLength: 1, maxLength: 128 }),
  deviceId: t.Optional(t.String({ maxLength: 128 })),
});

const pinSetBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 64 }),
  pin: t.String({ minLength: 6, maxLength: 128 }),
});

const pinChangeBody = t.Object({
  currentPin: t.String({ minLength: 1, maxLength: 128 }),
  newPin: t.String({ minLength: 6, maxLength: 128 }),
  newUsername: t.Optional(t.String({ minLength: 3, maxLength: 64 })),
});

export const providerAuthRoutes = new Elysia({ prefix: "/api/auth", tags: ["auth"] })
  .onError(authErrorHandler("auth:providers"))
  // ── PIN login (provider portal) ──────────────────────────────────────────
  .post(
    "/pin/login",
    async ({ body, headers, cookie, set }) => {
      try {
        const deviceId =
          (body.deviceId && String(body.deviceId).trim()) ||
          readHeader(headers, "x-device-id") ||
          null;
        const metadata = pinLoginMetadataFromHeaders(headers, deviceId);
        const response = await pinService.loginWithPin(
          String(body.username),
          String(body.pin),
          headers,
          metadata,
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
          console.error("[auth:providers] PIN login DB error:", error instanceof Error ? error.message : String(error));
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        console.error("[auth:providers] PIN login failed:", error instanceof Error ? error.message : String(error));
        set.status = 500;
        return fail("PIN login failed", "pin_login_failed");
      }
    },
    { body: pinLoginBody },
  )
  .post(
    "/pin/set",
    async ({ headers, body, set }) => {
      try {
        const auth = await resolveAuth(headers);
        const updated = await pinService.setPin(auth.userId, String(body.username), String(body.pin));
        return ok({
          message: "PIN credentials set successfully",
          username: updated.username,
          pinSetAt: updated.pinSetAt,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        if (isTransientDbError(error)) {
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        console.error("[auth:providers] PIN set failed:", error instanceof Error ? error.message : String(error));
        set.status = 500;
        return fail("Could not set PIN", "pin_set_failed");
      }
    },
    { body: pinSetBody },
  )
  .post(
    "/pin/change",
    async ({ headers, body, set }) => {
      try {
        const auth = await resolveAuth(headers);
        const updated = await pinService.changePin(
          auth.userId,
          String(body.currentPin),
          String(body.newPin),
          body.newUsername ? String(body.newUsername) : undefined,
        );
        return ok({
          message: "PIN changed successfully",
          username: updated.username,
          pinSetAt: updated.pinSetAt,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        if (isTransientDbError(error)) {
          set.status = 503;
          return fail("Service temporarily unavailable. Please try again.", "service_unavailable");
        }
        console.error("[auth:providers] PIN change failed:", error instanceof Error ? error.message : String(error));
        set.status = 500;
        return fail("Could not change PIN", "pin_change_failed");
      }
    },
    { body: pinChangeBody },
  );
