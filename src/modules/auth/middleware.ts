import { HttpError } from "../../lib/errors";
import { verifyAccessToken } from "../../lib/crypto";
import { cache } from "../../lib/cache";
import { getDb } from "../../lib/db";
import { env } from "../../config/env";
import { authRepository } from "./repository";
import { authorizationService, getActorType, normalizeRole, roleHierarchy } from "./policy";
import { readHeader } from "./helpers";
import type { UserRecord } from "./types";
import { isDefaultAdminEmail } from "./privileged-defaults";
import type { AuthContext } from "./context";

export type { AuthContext } from "./context";

async function assertPrivilegedAccessGrant(user: UserRecord) {
  const role = normalizeRole(user.role);
  if (!["ADMIN_USER", "SUPPORT_PROVIDER_USER"].includes(role)) {
    return;
  }
  if (role === "ADMIN_USER" && isDefaultAdminEmail(user.email)) {
    return;
  }
  const [grant] = await getDb()`
    SELECT id
    FROM auth.privileged_access_grants
    WHERE lower(email) = lower(${user.email})
      AND status = 'active'
      AND role = ${role}
    LIMIT 1
  `;
  if (!grant) {
    await authRepository.revokeAllSessions(user.id, "privileged_access_not_allowed");
    await invalidateResolvedAuthCacheForUser(user.id);
    throw new HttpError(403, "privileged_access_not_allowed", "This Gmail account is not approved for this privileged portal");
  }
}

export async function resolveAuth(headers: Headers | Record<string, string | undefined>): Promise<AuthContext> {
  const authorization = readHeader(headers, "authorization");
  const [scheme, token] = authorization.split(" ");

  // ── Test auth bypass (requires explicit enable flag) ─────────────────
  // Allows a static bearer token to skip JWT auth for interface testing.
  // Requires TEST_AUTH_BYPASS_ENABLED=true + token + email (triple safety).
  // The bypass still loads the real user from the DB so ownership checks
  // (user_key_id = auth.userId) work correctly.
  if (
    env.testAuthBypassEnabled &&
    scheme?.toLowerCase() === "bearer" &&
    token === env.testAuthBypassToken
  ) {
    const db = getDb();
    const [row] = await db`
      SELECT * FROM auth.users WHERE lower(email) = ${env.testAuthBypassEmail}
      LIMIT 1
    `;
    if (!row) {
      throw new HttpError(
        401,
        "bypass_user_not_found",
        `Test bypass user not found for email: ${env.testAuthBypassEmail}`,
      );
    }
    const user = row as unknown as UserRecord;
    if (user.status === "banned" || user.status === "deleted" || user.status === "disabled") {
      throw new HttpError(403, "account_disabled", "Test bypass account is not active");
    }
    return {
      actorId: user.id,
      userId: user.id,
      email: user.email,
      role: normalizeRole(user.role),
      actorType: getActorType(user.role),
      permissions: user.permissions ?? [],
      sessionId: "test-bypass-session",
      user,
    };
  }

  // ── Normal JWT auth flow ─────────────────────────────────────────────
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "unauthorized", "Missing or invalid Authorization header");
  }

  // Step 1 — verify JWT signature and claims (jose throws on bad token/expiry)
  let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    throw new HttpError(401, "invalid_token", "Access token is invalid or expired");
  }

  const cacheKey = `auth:resolved:${claims.sessionId}:${claims.userId}`;
  const cached = await cache.getJson<AuthContext>(cacheKey);
  if (cached) {
    return cached;
  }

  // Step 2 — verify session exists and is valid in Postgres
  const authRecord = await authRepository.getSessionAndUser(
    claims.sessionId,
    claims.userId,
  );
  if (!authRecord) {
    throw new HttpError(401, "session_not_found", "Session not found");
  }
  const { session, user } = authRecord;
  if (session.isRevoked) {
    throw new HttpError(401, "session_revoked", "Session has been revoked");
  }
  if (session.refreshExpiresAt && session.refreshExpiresAt < new Date()) {
    await authRepository.revokeSession(session.id, session.userId, "refresh_expired");
    throw new HttpError(401, "session_expired", "Session has expired. Please log in again.");
  }
  // Session userId must match JWT userId (defence against token swapping)
  if (session.userId !== claims.userId) {
    throw new HttpError(401, "session_mismatch", "Token does not match session");
  }

  // Step 3 — verify user account is in good standing
  if (user.status === "banned") {
    throw new HttpError(403, "account_banned", "Your account has been suspended");
  }
  if (user.status === "deleted" || user.status === "disabled") {
    throw new HttpError(403, "account_disabled", "Your account is no longer active");
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    throw new HttpError(403, "account_locked", "Account is temporarily locked due to failed login attempts");
  }
  if (user.bannedUntil && new Date(user.bannedUntil) > new Date()) {
    throw new HttpError(403, "account_suspended", "Your account is temporarily suspended");
  }
  await assertPrivilegedAccessGrant(user);

  const authContext = {
    actorId: claims.userId,
    userId: claims.userId,
    email: claims.email,
    role: normalizeRole(user.role),
    actorType: getActorType(user.role),
    permissions: user.permissions,
    sessionId: claims.sessionId,
    user,
  };
  await cache.setJson(cacheKey, authContext, 120);
  return authContext;
}

export async function invalidateResolvedAuthCache(sessionId: string, userId: string) {
  await cache.deletePattern(`auth:resolved:${sessionId}:${userId}`);
}

export async function invalidateResolvedAuthCacheForUser(userId: string) {
  await cache.deletePattern(`auth:resolved:*:${userId}`);
}

export function requireRole(currentRole: string, requiredRole: string) {
  const normalizedCurrent = normalizeRole(currentRole);
  const normalizedRequired = normalizeRole(requiredRole);
  if ((roleHierarchy[normalizedCurrent] ?? -1) < (roleHierarchy[normalizedRequired] ?? 999)) {
    throw new HttpError(403, "forbidden", "Insufficient permissions");
  }
}

export function requirePermission(auth: AuthContext, permission: Parameters<typeof authorizationService.can>[1]) {
  if (!authorizationService.can(auth, permission)) {
    throw new HttpError(403, "forbidden", "Insufficient permissions");
  }
}
