import { HttpError } from "../../../lib/errors";
import { normalizeRole } from "../policy";
import { authRepository } from "../repository";
import type { ExchangeResponse, UserRecord } from "../types";
import {
  assertPrivilegedUserCanAuthenticate,
  assertUserCanAuthenticate,
  createAuthenticatedSession,
  normalizeEmail,
} from "../helpers";

type HeaderBag = Headers | Record<string, string | undefined>;

export const adminAuthService = {
  async simulateLogin(
    input: { userId?: string; email?: string },
    options: { headers: HeaderBag; ipAddress: string },
  ): Promise<ExchangeResponse> {
    const hasUserId = Boolean(input.userId);
    const hasEmail = Boolean(input.email);
    if (Number(hasUserId) + Number(hasEmail) !== 1) {
      throw new HttpError(400, "invalid_request", "Provide exactly one of userId or email");
    }

    const user = input.userId
      ? await authRepository.getUserById(String(input.userId))
      : await authRepository.getUserByEmail(normalizeEmail(String(input.email)));

    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }

    assertUserCanAuthenticate(user);
    await assertPrivilegedUserCanAuthenticate(user);

    return createAuthenticatedSession(user, {
      headers: options.headers,
      ipAddressOverride: options.ipAddress,
      provider: user.provider || "email",
      simulated: true,
      activityType: "dev_login_simulation",
      activityDescription: "Development simulated login issued",
      activityMetadata: {
        lookup: hasUserId ? "user_id" : "email",
      },
    });
  },

  async impersonateForDevelopment(
    input: { userId?: string; email?: string; reason?: string },
    options: { headers: HeaderBag; ipAddress: string; allowPrivileged: boolean; allowedEmails: string[] },
  ): Promise<ExchangeResponse> {
    const hasUserId = Boolean(input.userId);
    const hasEmail = Boolean(input.email);
    if (Number(hasUserId) + Number(hasEmail) !== 1) {
      throw new HttpError(400, "invalid_request", "Provide exactly one of userId or email");
    }

    const user = input.userId
      ? await authRepository.getUserById(String(input.userId))
      : await authRepository.getUserByEmail(normalizeEmail(String(input.email)));

    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }

    const normalizedEmail = normalizeEmail(user.email);
    if (options.allowedEmails.length > 0 && !options.allowedEmails.includes(normalizedEmail)) {
      throw new HttpError(403, "impersonation_email_not_allowed", "This user is not in the development impersonation allow-list");
    }

    const role = normalizeRole(user.role);
    if (!options.allowPrivileged && ["ADMIN_USER", "SUPPORT_PROVIDER_USER", "DEV_USER", "SYSTEM_USER"].includes(role)) {
      throw new HttpError(403, "privileged_impersonation_blocked", "Privileged account impersonation is disabled");
    }

    assertUserCanAuthenticate(user);
    await assertPrivilegedUserCanAuthenticate(user);

    return createAuthenticatedSession(user, {
      headers: options.headers,
      ipAddressOverride: options.ipAddress,
      provider: user.provider || "email",
      simulated: true,
      activityType: "developer_impersonation",
      activityDescription: "Development impersonation session issued",
      activityMetadata: {
        lookup: hasUserId ? "user_id" : "email",
        reason: input.reason?.trim() || "development testing",
        target_user_id: user.id,
        target_email: user.email,
        allow_privileged: options.allowPrivileged,
      },
    });
  },
};
