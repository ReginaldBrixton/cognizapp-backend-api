/**
 * PIN Authentication Service (provider portal)
 *
 * Username + PIN login for the provider portal. The PIN is hashed with
 * argon2id (memory-hard KDF) so the stored value cannot be reversed or
 * brute-forced offline if the database leaks.
 *
 * Security controls:
 *  - argon2id hashing (m=64 MiB, t=3, p=4) — ~50-150 ms per verify, defeating
 *    online guessing.
 *  - Account lockout: 5 failed attempts → 15-minute lockout.
 *  - IP throttle: >= 10 failed attempts from one IP within 60s → 429.
 *  - Device throttle: >= 10 failed attempts from one device_id within 60s → 429.
 *  - Generic error messages to avoid username enumeration.
 *  - Every attempt (success or failure, known or unknown username) is recorded
 *    in auth.pin_login_attempts and surfaced in auth.activity_log for the
 *    account owner's activity log, including device_id, IP, browser, and OS.
 */

import { hash as argon2Hash, verify as argon2Verify, argon2id } from "argon2";

import { HttpError } from "../../../lib/errors";
import { withDbRetry } from "../../../lib/db";
import { authRepository } from "../repository";
import {
  assertPrivilegedUserCanAuthenticate,
  assertUserCanAuthenticate,
  createAuthenticatedSession,
  getClientIp,
  readHeader,
} from "../helpers";
import { normalizeRole } from "../policy";
import type { ExchangeResponse, UserRecord } from "../types";

type HeaderBag = Headers | Record<string, string | undefined>;

// ── Tunables ────────────────────────────────────────────────────────────────
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 32;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// Allow any printable ASCII in the PIN (letters, digits, symbols) plus space.
const PIN_PATTERN = /^[\x20-\x7E]+$/;

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MINUTES = 15;
export const IP_FAILED_ATTEMPTS_PER_MINUTE = 10;
export const DEVICE_FAILED_ATTEMPTS_PER_MINUTE = 10;

const ARGON2_OPTIONS = {
  type: argon2id, // argon2id (type 2) — memory-hard, side-channel resistant
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
};

type PinLoginMetadata = {
  ipAddress: string;
  userAgent: string;
  deviceId: string | null;
};

function normalizeUsername(input: string) {
  return input.trim();
}

function validateUsername(input: string): string {
  const username = normalizeUsername(input);
  if (
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH ||
    !USERNAME_PATTERN.test(username)
  ) {
    throw new HttpError(
      400,
      "invalid_username",
      `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters and only contain letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return username;
}

function validatePin(input: string): string {
  const pin = input ?? "";
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    throw new HttpError(
      400,
      "invalid_pin",
      `PIN must be between ${PIN_MIN_LENGTH} and ${PIN_MAX_LENGTH} characters.`,
    );
  }
  if (!PIN_PATTERN.test(pin)) {
    throw new HttpError(400, "invalid_pin", "PIN contains invalid characters.");
  }
  return pin;
}

function isAccountLocked(user: UserRecord): { locked: boolean; retryAfterSeconds: number } {
  if (!user.pinLockedUntil) return { locked: false, retryAfterSeconds: 0 };
  const lockedUntil = new Date(user.pinLockedUntil).getTime();
  const now = Date.now();
  if (lockedUntil <= now) return { locked: false, retryAfterSeconds: 0 };
  return {
    locked: true,
    retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
  };
}

function isProviderRole(role: string): boolean {
  const normalized = normalizeRole(role);
  return normalized === "SUPPORT_PROVIDER_USER" || normalized === "ADMIN_USER";
}

async function assertIpAndDeviceNotThrottled(metadata: PinLoginMetadata) {
  const since = new Date(Date.now() - 60_000);
  const deviceId = metadata.deviceId;
  const [ipFailures, deviceFailures] = await Promise.all([
    withDbRetry(() => authRepository.countRecentPinFailuresByIp(metadata.ipAddress, since)),
    deviceId
      ? withDbRetry(() => authRepository.countRecentPinFailuresByDevice(deviceId, since))
      : Promise.resolve(0),
  ]);
  if (ipFailures >= IP_FAILED_ATTEMPTS_PER_MINUTE) {
    throw new HttpError(
      429,
      "pin_rate_limited",
      "Too many failed attempts from this network. Please try again later.",
      { retryAfterSeconds: 60 },
    );
  }
  if (deviceFailures >= DEVICE_FAILED_ATTEMPTS_PER_MINUTE) {
    throw new HttpError(
      429,
      "pin_rate_limited",
      "Too many failed attempts from this device. Please try again later.",
      { retryAfterSeconds: 60 },
    );
  }
}

export const pinService = {
  /**
   * Hash a PIN with argon2id. Exposed for the bootstrap CLI and the set/change
   * endpoints.
   */
  async hashPin(pin: string): Promise<string> {
    return argon2Hash(validatePin(pin), ARGON2_OPTIONS);
  },

  /**
   * Authenticate a provider with username + PIN. On success issues a full
   * CognizApp session (access + refresh tokens) and records a `login` activity
   * with device metadata. On failure records a `pin_login_failed` activity and
   * applies account/IP/device throttling.
   */
  async loginWithPin(
    usernameInput: string,
    pinInput: string,
    headers: HeaderBag | undefined,
    metadata: PinLoginMetadata,
  ): Promise<ExchangeResponse> {
    const usernameAttempted = normalizeUsername(usernameInput);
    // Validate shapes first — but return generic 401 for unknown usernames so
    // the response is indistinguishable from a bad PIN.
    const pin = pinInput ?? "";

    await assertIpAndDeviceNotThrottled(metadata);

    const user = usernameAttempted
      ? await withDbRetry(() => authRepository.getUserByUsername(usernameAttempted))
      : null;

    // Helper to record an attempt and throw a generic invalid-credentials error.
    const fail = async (reason: string, status: number = 401) => {
      await withDbRetry(() =>
        authRepository.recordPinAttempt({
          userId: user?.id ?? null,
          usernameAttempted: usernameAttempted || "",
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          deviceId: metadata.deviceId,
          success: false,
          failureReason: reason,
        }),
      );
      if (user) {
        await withDbRetry(() =>
          authRepository.insertActivity(
            user.id,
            "pin_login_failed",
            "Failed PIN login attempt",
            null,
            {
              provider: "pin",
              username_attempted: usernameAttempted,
              ip_address: metadata.ipAddress,
              user_agent: metadata.userAgent,
              device_id: metadata.deviceId,
              failure_reason: reason,
            },
          ),
        );
      }
      if (status === 429) {
        throw new HttpError(429, "pin_rate_limited", "Too many failed attempts. Please try again later.", {
          retryAfterSeconds: 60,
        });
      }
      throw new HttpError(401, "invalid_credentials", "Invalid username or PIN.");
    };

    if (!user) {
      await fail("username_not_found");
    }

    // User is guaranteed non-null below.
    const u = user as UserRecord;

    // Account-level auth checks (banned/disabled/system). These errors are
    // surfaced to the user verbatim (they already know their username), so we
    // rethrow the original HttpError after recording the attempt.
    try {
      assertUserCanAuthenticate(u);
    } catch (error) {
      const reason = (error as HttpError).code || "account_not_allowed";
      await withDbRetry(() =>
        authRepository.recordPinAttempt({
          userId: u.id,
          usernameAttempted: usernameAttempted,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          deviceId: metadata.deviceId,
          success: false,
          failureReason: reason,
        }),
      );
      throw error;
    }

    // Only provider/admin accounts may use PIN login. Use a generic message to
    // avoid leaking which usernames exist with which roles.
    if (!isProviderRole(u.role)) {
      await fail("role_not_allowed");
    }

    // Ensure the privileged grant is still active (revocation check). Surface
    // the real reason so the provider knows their access was revoked.
    try {
      await assertPrivilegedUserCanAuthenticate(u);
    } catch (error) {
      const reason = (error as HttpError).code || "privileged_access_not_allowed";
      await withDbRetry(() =>
        authRepository.recordPinAttempt({
          userId: u.id,
          usernameAttempted: usernameAttempted,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          deviceId: metadata.deviceId,
          success: false,
          failureReason: reason,
        }),
      );
      throw error;
    }

    // Account lockout from prior failures.
    const lock = isAccountLocked(u);
    if (lock.locked) {
      await withDbRetry(() =>
        authRepository.recordPinAttempt({
          userId: u.id,
          usernameAttempted: usernameAttempted,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          deviceId: metadata.deviceId,
          success: false,
          failureReason: "account_locked",
        }),
      );
      throw new HttpError(
        429,
        "account_locked",
        "Account is temporarily locked due to too many failed attempts. Try again later.",
        { retryAfterSeconds: lock.retryAfterSeconds },
      );
    }

    if (!u.pinHash) {
      await withDbRetry(() =>
        authRepository.recordPinAttempt({
          userId: u.id,
          usernameAttempted: usernameAttempted,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          deviceId: metadata.deviceId,
          success: false,
          failureReason: "pin_not_set",
        }),
      );
      await withDbRetry(() =>
        authRepository.insertActivity(
          u.id,
          "pin_login_failed",
          "Failed PIN login attempt",
          null,
          {
            provider: "pin",
            username_attempted: usernameAttempted,
            ip_address: metadata.ipAddress,
            user_agent: metadata.userAgent,
            device_id: metadata.deviceId,
            failure_reason: "pin_not_set",
          },
        ),
      );
      throw new HttpError(
        403,
        "pin_not_set",
        "No PIN is set on this account. Ask an administrator to set up PIN sign-in.",
      );
    }

    // Shape validation for the PIN (after the user-exists path so the error
    // timing stays similar). A malformed PIN still counts as a failed attempt.
    let pinValidShape = true;
    try {
      validatePin(pin);
    } catch {
      pinValidShape = false;
    }

    let pinMatches = false;
    if (pinValidShape && u.pinHash) {
      try {
        pinMatches = await argon2Verify(u.pinHash, pin);
      } catch {
        pinMatches = false;
      }
    }

    if (!pinMatches) {
      const nextFailed = u.pinFailedLogins + 1;
      const shouldLock = nextFailed >= PIN_MAX_ATTEMPTS;
      const lockedUntil = shouldLock
        ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000)
        : null;
      await withDbRetry(() =>
        authRepository.registerPinFailure(u.id, nextFailed, lockedUntil),
      );
      await withDbRetry(() =>
        authRepository.recordPinAttempt({
          userId: u.id,
          usernameAttempted: usernameAttempted,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          deviceId: metadata.deviceId,
          success: false,
          failureReason: shouldLock ? "account_locked_after_failures" : "invalid_pin",
        }),
      );
      await withDbRetry(() =>
        authRepository.insertActivity(
          u.id,
          "pin_login_failed",
          "Failed PIN login attempt",
          null,
          {
            provider: "pin",
            username_attempted: usernameAttempted,
            ip_address: metadata.ipAddress,
            user_agent: metadata.userAgent,
            device_id: metadata.deviceId,
            failed_attempts: nextFailed,
            account_locked: shouldLock,
          },
        ),
      );
      if (shouldLock) {
        throw new HttpError(
          429,
          "account_locked",
          "Too many failed attempts. Your account is locked for 15 minutes.",
          { retryAfterSeconds: PIN_LOCKOUT_MINUTES * 60, attemptsRemaining: 0 },
        );
      }
      const attemptsRemaining = Math.max(PIN_MAX_ATTEMPTS - nextFailed, 0);
      throw new HttpError(401, "invalid_credentials", "Invalid username or PIN.", {
        attemptsRemaining,
      });
    }

    // ── Success ─────────────────────────────────────────────────────────────
    await withDbRetry(() => authRepository.resetPinFailure(u.id));
    await withDbRetry(() =>
      authRepository.recordPinAttempt({
        userId: u.id,
        usernameAttempted: usernameAttempted,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        deviceId: metadata.deviceId,
        success: true,
      }),
    );

    return createAuthenticatedSession(u, {
      headers,
      provider: "pin",
      isNewUser: false,
      activityType: "login",
      activityDescription: "User logged in with PIN",
      activityMetadata: {
        provider: "pin",
        username: u.username ?? usernameAttempted,
        ip_address: metadata.ipAddress,
        user_agent: metadata.userAgent,
        device_id: metadata.deviceId,
        is_new_user: false,
      },
      deviceId: metadata.deviceId,
    });
  },

  /**
   * Set (or replace) the username + PIN for an authenticated user. Used by the
   * provider portal's "set PIN" screen and by the bootstrap CLI.
   */
  async setPin(userId: string, usernameInput: string, pinInput: string): Promise<UserRecord> {
    const username = validateUsername(usernameInput);
    validatePin(pinInput);

    const existing = await withDbRetry(() => authRepository.getUserById(userId));
    if (!existing) {
      throw new HttpError(404, "user_not_found", "User not found.");
    }
    if (!isProviderRole(existing.role)) {
      throw new HttpError(
        403,
        "role_not_allowed",
        "PIN login is only available for provider and admin accounts.",
      );
    }

    const taken = await withDbRetry(() => authRepository.isUsernameTaken(username, userId));
    if (taken) {
      throw new HttpError(409, "username_taken", "That username is already in use.");
    }

    const pinHash = await this.hashPin(pinInput);
    const updated = await withDbRetry(() => authRepository.setPinCredentials(userId, username, pinHash));
    if (!updated) {
      throw new HttpError(500, "pin_set_failed", "Could not save PIN credentials.");
    }

    await withDbRetry(() =>
      authRepository.insertActivity(
        userId,
        "pin_set",
        "PIN login credentials were set",
        null,
        {
          provider: "pin",
          username,
          ip_address: "",
          user_agent: "",
        },
      ),
    );
    return updated;
  },

  /**
   * Change the PIN (and optionally the username) after verifying the current PIN.
   */
  async changePin(
    userId: string,
    currentPinInput: string,
    newPinInput: string,
    newUsernameInput?: string,
  ): Promise<UserRecord> {
    const existing = await withDbRetry(() => authRepository.getUserById(userId));
    if (!existing) {
      throw new HttpError(404, "user_not_found", "User not found.");
    }
    if (!isProviderRole(existing.role)) {
      throw new HttpError(403, "role_not_allowed", "PIN login is only available for provider and admin accounts.");
    }
    if (!existing.pinHash) {
      throw new HttpError(403, "pin_not_set", "No PIN is set on this account.");
    }

    let currentMatches = false;
    try {
      currentMatches = await argon2Verify(existing.pinHash, currentPinInput ?? "");
    } catch {
      currentMatches = false;
    }
    if (!currentMatches) {
      await withDbRetry(() =>
        authRepository.insertActivity(
          userId,
          "pin_change_failed",
          "Failed attempt to change PIN",
          null,
          { provider: "pin", reason: "invalid_current_pin" },
        ),
      );
      throw new HttpError(401, "invalid_current_pin", "Your current PIN is incorrect.");
    }

    validatePin(newPinInput);
    const username = newUsernameInput ? validateUsername(newUsernameInput) : existing.username;
    if (!username) {
      throw new HttpError(400, "invalid_username", "A username is required.");
    }
    const taken = await withDbRetry(() => authRepository.isUsernameTaken(username, userId));
    if (taken) {
      throw new HttpError(409, "username_taken", "That username is already in use.");
    }

    const pinHash = await this.hashPin(newPinInput);
    const updated = await withDbRetry(() => authRepository.setPinCredentials(userId, username, pinHash));
    if (!updated) {
      throw new HttpError(500, "pin_change_failed", "Could not save PIN credentials.");
    }

    await withDbRetry(() =>
      authRepository.insertActivity(
        userId,
        "pin_changed",
        "PIN login credentials were changed",
        null,
        { provider: "pin", username },
      ),
    );
    return updated;
  },

  /**
   * Remove PIN login credentials for a user (e.g. when an admin revokes a
   * provider grant). The user can still sign in via email OTP.
   */
  async clearPin(userId: string): Promise<void> {
    await withDbRetry(() => authRepository.clearPinHash(userId));
    await withDbRetry(() =>
      authRepository.insertActivity(
        userId,
        "pin_cleared",
        "PIN login credentials were removed",
        null,
        { provider: "pin" },
      ),
    );
  },

  // Exposed for tests / routes.
  _validateUsername: validateUsername,
  _validatePin: validatePin,
  _isProviderRole: isProviderRole,
};

// Re-exported so routes can build metadata from headers without duplicating logic.
export function pinLoginMetadataFromHeaders(
  headers: HeaderBag | undefined,
  deviceId: string | null,
): PinLoginMetadata {
  return {
    ipAddress: getClientIp(headers),
    userAgent: readHeader(headers, "user-agent"),
    deviceId,
  };
}
