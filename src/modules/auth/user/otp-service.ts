import { randomInt } from "node:crypto";

import { env } from "../../../config/env";
import { hashToken, safeEqualString } from "../../../lib/crypto";
import { emailDelivery } from "../../../lib/email-delivery";
import { HttpError } from "../../../lib/errors";
import { getDb } from "../../../lib/db";
import { normalizeEmail } from "../helpers";
import { otpRepository } from "./otp-repository";
import {
  assertSelectedRoleMatchesGrant,
  normalizeSelectedPrivilegedRole,
  type PrivilegedPortalRole,
} from "./portal-role";
import { userAuthService } from "./service";
import { defaultPrivilegedRoleForEmail, isDefaultAdminEmail } from "../privileged-defaults";

type HeaderBag = Headers | Record<string, string | undefined>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  const maskedLocal = local.length <= 2 ? `${local[0] ?? ""}***` : `${local.slice(0, 2)}***`;
  return `${maskedLocal}@${domain}`;
}

async function assertEmailHasPrivilegedGrant(email: string, selectedRole?: PrivilegedPortalRole) {
  if (isDefaultAdminEmail(email)) {
    const defaultRole = defaultPrivilegedRoleForEmail(email);
    assertSelectedRoleMatchesGrant(selectedRole, defaultRole ?? "ADMIN_USER");
    return defaultRole ?? "ADMIN_USER";
  }

  const [grant] = selectedRole
    ? await getDb()`
      SELECT id, role
      FROM auth.privileged_access_grants
      WHERE lower(email) = lower(${email})
        AND status = 'active'
        AND role = ${selectedRole}
      LIMIT 1
    `
    : await getDb()`
      SELECT id, role
      FROM auth.privileged_access_grants
      WHERE lower(email) = lower(${email})
        AND status = 'active'
      LIMIT 1
    `;
  if (!grant) {
    throw new HttpError(403, "privileged_access_not_allowed", "This email is not approved for privileged portal access.");
  }
  assertSelectedRoleMatchesGrant(selectedRole, String(grant.role));
  return grant.role as string;
}

export const otpService = {
  generateOtpCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
  },

  hashOtpCode(code: string) {
    return hashToken(code);
  },

  validateEmail(email: string) {
    const normalized = normalizeEmail(email);
    if (!emailPattern.test(normalized) || normalized.length > 254) {
      throw new HttpError(400, "invalid_email", "A valid email address is required");
    }
    return normalized;
  },

  async sendOtpEmail(email: string, code: string, ipAddress: string, userAgent: string) {
    if (!emailDelivery.isConfigured()) {
      throw new HttpError(503, "email_not_configured", "Email delivery is not configured");
    }

    const result = await emailDelivery.sendOtpEmail({
      to: email,
      code,
      expiresInMinutes: env.otpCodeExpiryMinutes,
      ipAddress,
      userAgent,
    });

    if (!result.ok) {
      console.warn("[Auth] OTP email webhook failed:", result.status, result.data);
      throw new HttpError(502, "otp_email_failed", "Failed to send login code. Please try again.");
    }
  },

  async requestOtp(emailInput: string, ipAddress: string, userAgent: string, requirePrivilegedAccess = false, selectedRole?: string) {
    const email = this.validateEmail(emailInput);
    const selectedPortalRole = normalizeSelectedPrivilegedRole(selectedRole);
    await otpRepository.cleanupExpiredCodes();

    if (requirePrivilegedAccess || selectedPortalRole) {
      await assertEmailHasPrivilegedGrant(email, selectedPortalRole);
    }

    const lastSent = await otpRepository.getLastSentCode(email);
    if (lastSent) {
      const elapsedSeconds = Math.floor((Date.now() - lastSent.lastSentAt.getTime()) / 1000);
      if (elapsedSeconds < env.otpResendCooldownSeconds) {
        throw new HttpError(429, "otp_resend_cooldown", "Please wait before requesting another code", {
          retryAfterSeconds: env.otpResendCooldownSeconds - elapsedSeconds,
        });
      }
    }

    const recentCount = await otpRepository.countRecentRequests(email, ipAddress, new Date(Date.now() - 60_000));
    if (recentCount >= env.otpRateLimitPerMinute) {
      throw new HttpError(429, "otp_rate_limited", "Too many login code requests. Please try again soon.");
    }

    const code = this.generateOtpCode();
    await otpRepository.createOtpCode({
      email,
      codeHash: this.hashOtpCode(code),
      expiresAt: new Date(Date.now() + env.otpCodeExpiryMinutes * 60 * 1000),
      ipAddress,
      userAgent,
    });

    try {
      await this.sendOtpEmail(email, code, ipAddress, userAgent);
    } catch (error) {
      if (!env.isDevelopment) {
        throw error;
      }

      const reason = error instanceof HttpError ? error.code : "otp_email_failed";
      console.warn("[Auth] Development OTP email delivery failed; returning code in response", {
        email: maskEmail(email),
        reason,
        message: error instanceof Error ? error.message : String(error),
      });

      return {
        success: true,
        message: `Development login code: ${code}`,
        email: maskEmail(email),
        expiresInMinutes: env.otpCodeExpiryMinutes,
        resendCooldownSeconds: env.otpResendCooldownSeconds,
        devCode: code,
        delivery: {
          mode: "development_fallback",
          emailDeliveryFailed: true,
          reason,
        },
      };
    }

    return {
      success: true,
      message: "THE CODE HAS BEEN SENT TO YOUR EMAIL",
      email: maskEmail(email),
      expiresInMinutes: env.otpCodeExpiryMinutes,
      resendCooldownSeconds: env.otpResendCooldownSeconds,
    };
  },

  async verifyOtp(emailInput: string, codeInput: string, headers: HeaderBag | undefined, ipAddress: string, userAgent: string, selectedRole?: string) {
    const email = this.validateEmail(emailInput);
    const selectedPortalRole = normalizeSelectedPrivilegedRole(selectedRole);
    const code = codeInput.trim();
    if (!/^\d{6}$/.test(code)) {
      throw new HttpError(400, "invalid_otp_code", "Enter the 6-digit login code");
    }

    const activeCodes = await otpRepository.getActiveOtpCodes(email);
    if (activeCodes.length === 0) {
      throw new HttpError(401, "otp_not_found", "Login code is invalid or expired");
    }

    const availableCodes = activeCodes.filter((activeCode) => activeCode.attempts < env.otpMaxAttempts);
    if (availableCodes.length === 0) {
      throw new HttpError(429, "otp_attempts_exceeded", "Too many incorrect attempts. Request a new code.");
    }

    const codeHash = this.hashOtpCode(code);
    const matchingCode = availableCodes.find((activeCode) => safeEqualString(activeCode.codeHash, codeHash));
    if (!matchingCode) {
      const newestCode = availableCodes[0];
      const updated = await otpRepository.incrementOtpAttempts(newestCode.id);
      const attemptsRemaining = Math.max(env.otpMaxAttempts - (updated?.attempts ?? newestCode.attempts + 1), 0);
      throw new HttpError(401, "invalid_otp_code", "Login code is invalid or expired", { attemptsRemaining });
    }

    if (selectedPortalRole) {
      await assertEmailHasPrivilegedGrant(email, selectedPortalRole);
    }

    await otpRepository.markOtpVerified(matchingCode.id);
    await otpRepository.markOtherActiveCodesVerified(email, matchingCode.id);
    return userAuthService.loginWithEmailOtp(email, headers, {
      ipAddress,
      userAgent,
      otpCodeId: matchingCode.id,
      selectedRole: selectedPortalRole,
    });
  },
};
