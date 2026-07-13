import { env } from "../../../config/env";
import { deviceFingerprint, hashToken, signAccessToken, verifyRefreshToken } from "../../../lib/crypto";
import { getDb } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import { invalidateResolvedAuthCache, invalidateResolvedAuthCacheForUser } from "../middleware";
import { normalizeRole } from "../policy";
import { authRepository } from "../repository";
import type { ExchangeResponse, UserRecord } from "../types";
import {
  assertPrivilegedUserCanAuthenticate,
  assertUserCanAuthenticate,
  createAuthenticatedSession,
  interactiveSessionDays,
  normalizeEmail,
  readHeader,
  getClientIp,
} from "../helpers";
import {
  assertSelectedRoleMatchesGrant,
  normalizeSelectedPrivilegedRole,
  privilegedPortalLabel,
  type PrivilegedPortalRole,
} from "../portal-role";
import { defaultPrivilegedRoleForEmail, isDefaultAdminEmail } from "../privileged-defaults";
import { getFirebaseAdminAuth } from "../../../lib/firebase";

type HeaderBag = Headers | Record<string, string | undefined>;

async function getActivePrivilegedGrant(email: string) {
  const defaultRole = defaultPrivilegedRoleForEmail(email);
  if (defaultRole) {
    return { role: defaultRole };
  }

  const [grant] = await getDb()`
    SELECT role
    FROM auth.privileged_access_grants
    WHERE lower(email) = lower(${email})
      AND status = 'active'
    LIMIT 1
  `;
  return grant ? { role: String(grant.role) } : null;
}

async function requireSelectedPortalGrant(email: string, selectedRole: PrivilegedPortalRole) {
  if (isDefaultAdminEmail(email)) {
    assertSelectedRoleMatchesGrant(selectedRole, "ADMIN_USER");
    return { role: "ADMIN_USER" };
  }

  const grant = await getActivePrivilegedGrant(email);
  if (!grant) {
    throw new HttpError(403, "privileged_access_not_allowed", "This email is not approved for privileged portal access.");
  }
  assertSelectedRoleMatchesGrant(selectedRole, grant.role);
  return grant;
}

export const userAuthService = {
  async loginWithEmailOtp(
    emailInput: string,
    headers: HeaderBag | undefined,
    metadata: { ipAddress: string; userAgent: string; otpCodeId: string; selectedRole?: string },
  ): Promise<ExchangeResponse> {
    const email = normalizeEmail(emailInput);
    const selectedPortalRole = normalizeSelectedPrivilegedRole(metadata.selectedRole);
    const existingUser = await authRepository.getUserByEmail(email);
    let roleOverride: string | undefined;

    if (existingUser) {
      assertUserCanAuthenticate(existingUser);
      if (selectedPortalRole) {
        const grant = await requireSelectedPortalGrant(email, selectedPortalRole);
        const existingRole = normalizeRole(existingUser.role);
        if (["ADMIN_USER", "SUPPORT_PROVIDER_USER"].includes(existingRole) && existingRole !== selectedPortalRole) {
          throw new HttpError(
            403,
            "role_mismatch",
            `You selected the ${privilegedPortalLabel(selectedPortalRole)} portal, but your account role is currently ${privilegedPortalLabel(existingRole)}. Ask an admin to update your access.`,
          );
        }
        roleOverride = grant.role;
      } else {
        // Admin logging into regular user portal - no need for privileged assert
      }
    }

    const isNewUser = !existingUser;
    const displayName = existingUser?.displayName || existingUser?.fullName || email.split("@")[0] || email;

    if (isNewUser) {
      const grant = selectedPortalRole
        ? await requireSelectedPortalGrant(email, selectedPortalRole)
        : await getActivePrivilegedGrant(email);
      if (grant) {
        assertSelectedRoleMatchesGrant(selectedPortalRole, grant.role);
        roleOverride = grant.role as string;
      }
    }

    // Build merged providers list — link email to existing account if present
    const mergedProviders = ["email", ...(existingUser?.providers.filter(p => p !== "email") || [])];

    const user = await authRepository.upsertUser({
      email,
      emailVerified: true,
      displayName,
      avatarUrl: existingUser?.avatarUrl ?? "",
      provider: "email",
      providerUid: null,
      providers: mergedProviders,
      appMetadata: {
        provider: "email",
        providers: mergedProviders,
      },
      userMetadata: {
        email,
        name: displayName,
      },
      identityData: {
        provider: "email",
        email,
        email_verified: true,
        verified_with: "otp",
      },
      roleOverride,
    });

    // Detect account linking: existing user who didn't have email provider before
    const wasLinked = !isNewUser && existingUser && !existingUser.providers.includes("email");

    return createAuthenticatedSession(user, {
      headers,
      provider: "email",
      isNewUser,
      activityType: isNewUser ? "registration" : wasLinked ? "account_link" : "login",
      activityDescription: isNewUser
        ? "New user registered with email OTP"
        : wasLinked
          ? "Email OTP linked to existing user"
          : "User logged in with email OTP",
      activityMetadata: {
        provider: "email",
        otp_code_id: metadata.otpCodeId,
        ip_address: metadata.ipAddress,
        user_agent: metadata.userAgent,
        is_new_user: isNewUser,
        account_linked: wasLinked,
        previous_providers: existingUser?.providers || [],
      },
    });
  },

  async loginWithGoogle(
    firebaseToken: string,
    headers: HeaderBag | undefined,
    metadata: { ipAddress: string; userAgent: string; selectedRole?: string },
  ): Promise<ExchangeResponse> {
    const adminAuth = getFirebaseAdminAuth();
    let decodedToken;
    try {
      decodedToken = await adminAuth.verifyIdToken(firebaseToken);
    } catch (error) {
      throw new HttpError(401, "invalid_firebase_token", "Firebase token is invalid or expired");
    }

    const signInProvider = decodedToken.firebase?.sign_in_provider || "google.com";

    // Phone auth: no email, only phone_number and uid
    if (signInProvider === "phone") {
      return userAuthService.loginWithPhone(decodedToken, headers, metadata);
    }

    if (!decodedToken.email) {
      throw new HttpError(400, "email_required", "Google account must have an email address");
    }

    const email = normalizeEmail(decodedToken.email);
    const selectedPortalRole = normalizeSelectedPrivilegedRole(metadata.selectedRole);
    const existingUser = await authRepository.getUserByEmail(email);
    let roleOverride: string | undefined;

    if (existingUser) {
      assertUserCanAuthenticate(existingUser);
      if (selectedPortalRole) {
        const grant = await requireSelectedPortalGrant(email, selectedPortalRole);
        const existingRole = normalizeRole(existingUser.role);
        if (["ADMIN_USER", "SUPPORT_PROVIDER_USER"].includes(existingRole) && existingRole !== selectedPortalRole) {
          throw new HttpError(
            403,
            "role_mismatch",
            `You selected the ${privilegedPortalLabel(selectedPortalRole)} portal, but your account role is currently ${privilegedPortalLabel(existingRole)}. Ask an admin to update your access.`,
          );
        }
        roleOverride = grant.role;
      } else {
        // Admin logging into regular user portal - no need for privileged assert
      }
    }

    const isNewUser = !existingUser;
    const displayName = decodedToken.name || existingUser?.displayName || email.split("@")[0];
    const avatarUrl = decodedToken.picture || existingUser?.avatarUrl || "";
    const providerUid = decodedToken.uid;

    if (isNewUser) {
      const grant = selectedPortalRole
        ? await requireSelectedPortalGrant(email, selectedPortalRole)
        : await getActivePrivilegedGrant(email);
      if (grant) {
        assertSelectedRoleMatchesGrant(selectedPortalRole, grant.role);
        roleOverride = grant.role as string;
      }
    }

    // Build merged providers list — link Google to existing account if present
    const mergedProviders = ["google", ...(existingUser?.providers.filter(p => p !== "google") || [])];

    const user = await authRepository.upsertUser({
      email,
      emailVerified: decodedToken.email_verified ?? true,
      displayName,
      avatarUrl,
      provider: "google",
      providerUid,
      providers: mergedProviders,
      appMetadata: {
        provider: "google",
        providers: mergedProviders,
      },
      userMetadata: {
        email,
        name: displayName,
        avatar_url: avatarUrl,
      },
      identityData: {
        provider: "google",
        email,
        email_verified: decodedToken.email_verified ?? true,
        sub: providerUid,
      },
      roleOverride,
    });

    // Detect account linking: existing user who didn't have google provider before
    const wasLinked = !isNewUser && existingUser && !existingUser.providers.includes("google");

    return createAuthenticatedSession(user, {
      headers,
      provider: "google",
      isNewUser,
      activityType: isNewUser ? "registration" : wasLinked ? "account_link" : "login",
      activityDescription: isNewUser
        ? "New user registered with Google"
        : wasLinked
          ? "Google account linked to existing user"
          : "User logged in with Google",
      activityMetadata: {
        provider: "google",
        ip_address: metadata.ipAddress,
        user_agent: metadata.userAgent,
        is_new_user: isNewUser,
        account_linked: wasLinked,
        previous_providers: existingUser?.providers || [],
      },
    });
  },

  async loginWithPhone(
    decodedToken: Awaited<ReturnType<ReturnType<typeof getFirebaseAdminAuth>["verifyIdToken"]>>,
    headers: HeaderBag | undefined,
    metadata: { ipAddress: string; userAgent: string; selectedRole?: string },
  ): Promise<ExchangeResponse> {
    const phoneNumber = decodedToken.phone_number;
    if (!phoneNumber) {
      throw new HttpError(400, "phone_required", "Phone auth token must contain a phone number");
    }

    const providerUid = decodedToken.uid;
    const selectedPortalRole = normalizeSelectedPrivilegedRole(metadata.selectedRole);

    // Look up existing user by phone first, then by provider uid
    let existingUser = await authRepository.getUserByPhone(phoneNumber);
    if (!existingUser && providerUid) {
      existingUser = await authRepository.getUserByProvider("phone", providerUid);
    }

    let roleOverride: string | undefined;
    if (existingUser) {
      assertUserCanAuthenticate(existingUser);
      if (selectedPortalRole) {
        const grant = await requireSelectedPortalGrant(existingUser.email, selectedPortalRole);
        const existingRole = normalizeRole(existingUser.role);
        if (["ADMIN_USER", "SUPPORT_PROVIDER_USER"].includes(existingRole) && existingRole !== selectedPortalRole) {
          throw new HttpError(
            403,
            "role_mismatch",
            `You selected the ${privilegedPortalLabel(selectedPortalRole)} portal, but your account role is currently ${privilegedPortalLabel(existingRole)}. Ask an admin to update your access.`,
          );
        }
        roleOverride = grant.role;
      }
    }

    const isNewUser = !existingUser;
    // Use a synthetic email for phone-only users so the DB unique constraint is satisfied
    // Must be lowercase to satisfy chk_users_email_shape constraint
    const email = existingUser?.email || `${providerUid.toLowerCase()}@phone.cognizapp.com`;
    const displayName = existingUser?.displayName || phoneNumber;

    if (isNewUser) {
      const grant = selectedPortalRole
        ? await requireSelectedPortalGrant(email, selectedPortalRole)
        : await getActivePrivilegedGrant(email);
      if (grant) {
        assertSelectedRoleMatchesGrant(selectedPortalRole, grant.role);
        roleOverride = grant.role as string;
      }
    }

    // Build merged providers list — link phone to existing account if present
    const mergedProviders = ["phone", ...(existingUser?.providers.filter(p => p !== "phone") || [])];

    const user = await authRepository.upsertUser({
      email,
      emailVerified: existingUser?.emailVerified ?? false,
      displayName,
      avatarUrl: existingUser?.avatarUrl || "",
      provider: "phone",
      providerUid,
      providers: mergedProviders,
      phone: phoneNumber,
      phoneVerified: true,
      appMetadata: {
        provider: "phone",
        providers: mergedProviders,
      },
      userMetadata: {
        email,
        phone: phoneNumber,
        name: displayName,
      },
      identityData: {
        provider: "phone",
        phone: phoneNumber,
        phone_verified: true,
        sub: providerUid,
      },
      roleOverride,
    });

    // Detect account linking: existing user who didn't have phone provider before
    const wasLinked = !isNewUser && existingUser && !existingUser.providers.includes("phone");

    return createAuthenticatedSession(user, {
      headers,
      provider: "phone",
      isNewUser,
      activityType: isNewUser ? "registration" : wasLinked ? "account_link" : "login",
      activityDescription: isNewUser
        ? "New user registered with phone"
        : wasLinked
          ? "Phone linked to existing user"
          : "User logged in with phone",
      activityMetadata: {
        provider: "phone",
        phone: phoneNumber,
        ip_address: metadata.ipAddress,
        user_agent: metadata.userAgent,
        is_new_user: isNewUser,
        account_linked: wasLinked,
        previous_providers: existingUser?.providers || [],
      },
    });
  },

  async refresh(refreshToken: string, headers: HeaderBag | undefined) {
    let claims: Awaited<ReturnType<typeof verifyRefreshToken>>;
    try {
      claims = await verifyRefreshToken(refreshToken);
    } catch {
      throw new HttpError(401, "invalid_refresh_token", "Refresh token is invalid or expired");
    }
    const session = await authRepository.getSessionById(claims.sessionId);
    if (!session || session.userId !== claims.userId) {
      throw new HttpError(401, "session_not_found", "Session not found");
    }
    if (session.isRevoked) {
      throw new HttpError(401, "session_revoked", "Session has been revoked");
    }

    const currentFingerprint = deviceFingerprint(
      `${readHeader(headers, "user-agent")}${readHeader(headers, "accept-language")}${getClientIp(headers)}`,
    );

    if (env.strictDeviceFingerprint && session.deviceFingerprint && session.deviceFingerprint !== currentFingerprint) {
      await authRepository.revokeSession(session.id, session.userId, "device_fingerprint_mismatch");
      await invalidateResolvedAuthCache(session.id, session.userId);
      throw new HttpError(401, "device_mismatch", "Security violation detected. Please login again.");
    }

    if (session.refreshTokenHash !== hashToken(refreshToken)) {
      await authRepository.markReuseDetected(session.id);
      await authRepository.revokeAllSessions(session.userId, "token_reuse_detected");
      await invalidateResolvedAuthCacheForUser(session.userId);
      throw new HttpError(401, "token_reuse_detected", "Security violation detected. Please login again.");
    }

    const user = await authRepository.getUserById(session.userId);
    if (!user) {
      throw new HttpError(401, "user_not_found", "User not found");
    }
    await assertPrivilegedUserCanAuthenticate(user);

    const accessExpiry = new Date(Date.now() + env.jwtAccessExpiryMinutes * 60 * 1000);
    const refreshExpiry = new Date(Date.now() + interactiveSessionDays() * 24 * 60 * 60 * 1000);
    const accessToken = await signAccessToken({
      userId: user.id,
      sessionId: session.id,
      role: normalizeRole(user.role),
      email: user.email,
      deviceFingerprint: session.deviceFingerprint ?? undefined,
    });

    await authRepository.updateSessionTokens(
      session.id,
      hashToken(accessToken),
      hashToken(refreshToken),
      accessExpiry,
      refreshExpiry,
    );
    await invalidateResolvedAuthCache(session.id, session.userId);

    return {
      success: true,
      accessToken,
      refreshToken,
      expiresIn: env.jwtAccessExpiryMinutes * 60,
      expiresAt: Math.floor(accessExpiry.getTime() / 1000),
      authAction: "login",
      auth_action: "login",
    };
  },

  async me(userId: string) {
    const user = await authRepository.getUserById(userId);
    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }
    return user;
  },

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await authRepository.listActiveSessionsByUser(userId);
    return sessions.map((session) => ({
      id: session.id,
      userId: session.userId,
      email: session.email,
      device_name: session.deviceName,
      device_type: session.deviceType,
      browser: session.browser,
      os: session.os,
      ip_address: session.ipAddress,
      created_at: session.createdAt,
      last_active: session.lastActive ?? session.createdAt,
      is_current: session.id === currentSessionId,
    }));
  },

  async revokeSession(sessionId: string, userId: string) {
    const session = await authRepository.getSessionById(sessionId);
    if (!session || session.userId !== userId) {
      throw new HttpError(404, "session_not_found", "Session not found or access denied");
    }
    await authRepository.revokeSession(sessionId, userId, "user_revoked");
    await invalidateResolvedAuthCache(sessionId, userId);
  },

  async logout(sessionId: string, userId: string) {
    await authRepository.revokeSession(sessionId, userId, "user_logout");
    await invalidateResolvedAuthCache(sessionId, userId);
    await authRepository.insertActivity(userId, "logout", "User logged out", sessionId, {});
  },

  async logoutAll(userId: string, exceptSessionId?: string) {
    await authRepository.revokeAllSessions(userId, "user_logout_all", exceptSessionId);
    await invalidateResolvedAuthCacheForUser(userId);
    await authRepository.insertActivity(userId, "logout_all", "User logged out from all devices", exceptSessionId ?? null, {});
  },

  async identities(userId: string) {
    const user = await authRepository.getUserById(userId);
    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }
    return [
      {
        id: user.id,
        provider: user.provider || "email",
        provider_uid: user.providerUid || null,
        email: user.email,
        email_verified: user.emailVerified,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
        last_sign_in_at: user.lastSignInAt,
        identity_data: user.identityData,
      },
    ];
  },
};
