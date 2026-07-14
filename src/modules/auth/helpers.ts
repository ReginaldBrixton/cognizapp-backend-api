import { env } from "../../config/env";
import { deviceFingerprint, hashToken, signAccessToken, signRefreshToken } from "../../lib/crypto";
import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { workspaceService } from "../workspace/service";
import { authorizationService, normalizeRole } from "./policy";
import { cache } from "../../lib/cache";
import { authRepository } from "./repository";
import type { ExchangeResponse, UserRecord } from "./types";
import { isDefaultAdminEmail } from "./privileged-defaults";

export type HeaderBag = Headers | Record<string, string | undefined>;

export type ServerWithRequestIp = {
  requestIP?: (request: Request) => { address?: string | null } | null;
};

const MAX_INTERACTIVE_SESSION_DAYS = 30;

export function interactiveSessionDays() {
  return Math.min(env.jwtRefreshExpiryDays, MAX_INTERACTIVE_SESSION_DAYS);
}

export function readHeader(headers: HeaderBag | undefined, name: string) {
  if (!headers) return "";
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") {
    return maybeGet.call(headers, name) ?? "";
  }
  const headerBag = headers as Record<string, string | undefined>;
  return headerBag[name] ?? headerBag[name.toLowerCase()] ?? "";
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function getDeviceInfo(userAgent: string) {
  const value = userAgent.toLowerCase();
  let browser = "Unknown";
  let os = "Unknown";
  let type = "desktop";

  if (value.includes("edg/")) browser = "Edge";
  else if (value.includes("chrome/")) browser = "Chrome";
  else if (value.includes("firefox/")) browser = "Firefox";
  else if (value.includes("safari/") && !value.includes("chrome")) browser = "Safari";

  if (value.includes("windows")) os = "Windows";
  else if (value.includes("mac os")) os = "macOS";
  else if (value.includes("android")) {
    os = "Android";
    type = "mobile";
  } else if (value.includes("iphone")) {
    os = "iOS";
    type = "mobile";
  } else if (value.includes("linux")) os = "Linux";

  return {
    browser,
    os,
    type,
    name: browser !== "Unknown" && os !== "Unknown" ? `${browser} on ${os}` : "Unknown Device",
  };
}

export function isLoopbackAddress(address: string) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function getRequestIpAddress(request: Request, server: unknown) {
  if (typeof server !== "object" || server === null) {
    return "";
  }

  const maybeServer = server as ServerWithRequestIp;
  return maybeServer.requestIP?.(request)?.address ?? "";
}

export function getForwardedIp(headers: HeaderBag, request: Request, server: unknown) {
  const forwarded = readHeader(headers, "x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "";
  }
  return readHeader(headers, "x-real-ip") || getRequestIpAddress(request, server);
}

export function getClientIp(headers: HeaderBag | undefined, fallback = "") {
  if (!headers) return fallback;
  const forwarded = readHeader(headers, "x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? fallback;
  }
  return readHeader(headers, "x-real-ip") || fallback;
}

export function refreshCookie(value: string) {
  const maxAgeSeconds = interactiveSessionDays() * 24 * 60 * 60;
  return {
    value,
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
    expires: new Date(Date.now() + maxAgeSeconds * 1000),
  };
}

export async function ensureUserData(user: UserRecord) {
  await workspaceService.ensureBootstrap(user.id, user.email, user.displayName || user.fullName || user.email);
}

export function assertUserCanAuthenticate(user: UserRecord) {
  if (!authorizationService.isInteractiveRole(user.role)) {
    throw new HttpError(403, "system_account", "System accounts cannot use interactive authentication");
  }
  if (user.status === "banned") {
    throw new HttpError(403, "account_banned", "Your account has been suspended");
  }
  if (user.status === "deleted" || user.status === "disabled") {
    throw new HttpError(403, "account_disabled", "Your account is no longer active");
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    throw new HttpError(403, "account_locked", "Account is temporarily locked. Try again later.");
  }
  if (user.bannedUntil && new Date(user.bannedUntil) > new Date()) {
    throw new HttpError(403, "account_suspended", "Account is temporarily suspended. Try again later.");
  }
}

export async function assertPrivilegedUserCanAuthenticate(user: UserRecord) {
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
    await cache.deletePattern(`auth:resolved:*:${user.id}`);
    throw new HttpError(403, "privileged_access_not_allowed", "This Gmail account is not approved for this privileged portal");
  }
}

function addAuthResponseAliases(response: ExchangeResponse): ExchangeResponse {
  const authAction = response.authAction ?? response.auth_action ?? (response.isNewUser ? "register" : "login");

  return {
    ...response,
    user_id: response.userId,
    display_name: response.displayName,
    avatar_url: response.avatarUrl,
    session_id: response.sessionId,
    access_token: response.accessToken,
    refresh_token: response.refreshToken,
    expires_in: response.expiresIn,
    expires_at: response.expiresAt,
    is_new_user: response.isNewUser,
    authAction,
    auth_action: authAction,
  };
}

export type SessionCreationOptions = {
  headers: HeaderBag | undefined;
  provider: string;
  activityType: string;
  activityDescription: string;
  activityMetadata: Record<string, unknown>;
  ipAddressOverride?: string;
  simulated?: boolean;
  isNewUser?: boolean;
  deviceId?: string | null;
};

export async function createAuthenticatedSession(
  user: UserRecord,
  {
    headers,
    provider,
    activityType,
    activityDescription,
    activityMetadata,
    ipAddressOverride,
    simulated = false,
    isNewUser = false,
    deviceId: deviceIdInput,
  }: SessionCreationOptions,
): Promise<ExchangeResponse> {
  const userAgent = readHeader(headers, "user-agent");
  const acceptLanguage = readHeader(headers, "accept-language");
  const ipAddress = ipAddressOverride ?? getClientIp(headers);
  const currentFingerprint = deviceFingerprint(`${userAgent}${acceptLanguage}${ipAddress}`);
  const device = getDeviceInfo(userAgent);
  const deviceId = deviceIdInput ?? null;
  const placeholderSession = await authRepository.createSession({
    userId: user.id,
    email: user.email,
    role: normalizeRole(user.role),
    tokenHash: `pending_${Date.now()}`,
    refreshTokenHash: `pending_${Date.now()}_refresh`,
    expiresAt: new Date(Date.now() + env.jwtAccessExpiryMinutes * 60 * 1000),
    refreshExpiresAt: new Date(Date.now() + interactiveSessionDays() * 24 * 60 * 60 * 1000),
    ipAddress,
    userAgent,
    deviceFingerprint: currentFingerprint,
    browser: device.browser,
    os: device.os,
    deviceType: device.type,
    deviceName: device.name,
    deviceId,
  });

  const accessExpiry = new Date(Date.now() + env.jwtAccessExpiryMinutes * 60 * 1000);
  const refreshExpiry = new Date(Date.now() + interactiveSessionDays() * 24 * 60 * 60 * 1000);
  const accessToken = await signAccessToken({
    userId: user.id,
    sessionId: placeholderSession.id,
    role: normalizeRole(user.role),
    email: user.email,
    provider: user.provider ?? undefined,
    deviceFingerprint: currentFingerprint,
  });
  const refreshToken = await signRefreshToken({
    userId: user.id,
    sessionId: placeholderSession.id,
  });

  await authRepository.updateSessionTokens(
    placeholderSession.id,
    hashToken(accessToken),
    hashToken(refreshToken),
    accessExpiry,
    refreshExpiry,
  );

  await ensureUserData(user);
  await authRepository.insertActivity(user.id, activityType, activityDescription, placeholderSession.id, {
    ...activityMetadata,
    simulated,
    device_id: deviceId,
    device_name: device.name,
    device_type: device.type,
    browser: device.browser,
    os: device.os,
    accept_language: acceptLanguage || undefined,
  });

  const authAction = isNewUser ? "register" : "login";

  return addAuthResponseAliases({
    success: true,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: normalizeRole(user.role),
    provider,
    sessionId: placeholderSession.id,
    accessToken,
    refreshToken,
    expiresIn: env.jwtAccessExpiryMinutes * 60,
    expiresAt: Math.floor(accessExpiry.getTime() / 1000),
    isNewUser,
    authAction,
    simulated: simulated || undefined,
  });
}
