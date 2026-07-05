import { getDb } from "../../lib/db";
import type { SessionRecord, UserRecord } from "./types";
import { normalizeRole } from "./policy";
import { isDefaultAdminEmail } from "./privileged-defaults";

function defaultRoleForEmail(email: string) {
  return isDefaultAdminEmail(email)
    ? normalizeRole("admin")
    : normalizeRole("user");
}

function parseUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    phone: row.phone ? String(row.phone) : null,
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    role: String(row.role),
    status: String(row.status),
    bannedUntil: row.banned_until ? String(row.banned_until) : null,
    isAnonymous: Boolean(row.is_anonymous),
    isSsoUser: Boolean(row.is_sso_user),
    displayName: String(row.display_name ?? ""),
    fullName: String(row.full_name ?? ""),
    avatarUrl: String(row.avatar_url ?? ""),
    appMetadata: (row.raw_app_meta_data as Record<string, unknown> | null) ?? null,
    userMetadata: (row.raw_user_meta_data as Record<string, unknown> | null) ?? null,
    providers: (row.providers as string[] | null) ?? [],
    provider: String(row.provider ?? ""),
    providerUid: String(row.provider_uid ?? ""),
    identityData: (row.identity_data as Record<string, unknown> | null) ?? null,
    permissions: Array.isArray(row.permissions) ? (row.permissions as string[]) : [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
    lastSignInAt: row.last_sign_in_at ? String(row.last_sign_in_at) : null,
    loginCount: Number(row.login_count ?? 0),
    failedLogins: Number(row.failed_logins ?? 0),
    lockedUntil: row.locked_until ? String(row.locked_until) : null,
    username: row.username ? String(row.username) : null,
    pinHash: row.pin_hash ? String(row.pin_hash) : null,
    pinFailedLogins: Number(row.pin_failed_logins ?? 0),
    pinLockedUntil: row.pin_locked_until ? String(row.pin_locked_until) : null,
    pinSetAt: row.pin_set_at ? String(row.pin_set_at) : null,
    lastPinFailedAt: row.last_pin_failed_at ? String(row.last_pin_failed_at) : null,
  };
}

function parseSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    email: String(row.email),
    role: String(row.role),
    tokenHash: String(row.token_hash),
    refreshTokenHash: String(row.refresh_token_hash),
    expiresAt: new Date(String(row.expires_at)),
    refreshExpiresAt: row.refresh_expires_at ? new Date(String(row.refresh_expires_at)) : null,
    ipAddress: String(row.ip_address),
    userAgent: String(row.user_agent),
    deviceFingerprint: row.device_fingerprint ? String(row.device_fingerprint) : null,
    deviceName: row.device_name ? String(row.device_name) : null,
    deviceType: row.device_type ? String(row.device_type) : null,
    browser: row.browser ? String(row.browser) : null,
    os: row.os ? String(row.os) : null,
    isRevoked: Boolean(row.is_revoked),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    revokedReason: row.revoked_reason ? String(row.revoked_reason) : null,
    reuseDetectedAt: row.reuse_detected_at ? new Date(String(row.reuse_detected_at)) : null,
    createdAt: row.created_at ? new Date(String(row.created_at)) : new Date(),
    lastActive: row.last_active ? new Date(String(row.last_active)) : null,
    deviceId: row.device_id ? String(row.device_id) : null,
  };
}

async function withAuthQueryTiming<T>(
  name: string,
  context: Record<string, unknown>,
  query: () => Promise<T>,
) {
  const startedAt = Date.now();
  let result: T | undefined;
  try {
    result = await query();
    return result;
  } finally {
    const durationMs = Date.now() - startedAt;
    const rowCount = Array.isArray(result) ? result.length : undefined;
    if (durationMs > 200) {
      console.warn("[auth:db] slow query", {
        query: name,
        durationMs,
        rowCount,
        ...context,
      });
    }
  }
}

export const authRepository = {
  async getUserByProvider(provider: string, providerUid: string) {
    const db = getDb();
    const rows = await db`
      SELECT * FROM auth.users
      WHERE provider = ${provider} AND provider_uid = ${providerUid}
      LIMIT 1
    `;
    return rows[0] ? parseUser(rows[0]) : null;
  },

  async getUserByEmail(email: string) {
    const db = getDb();
    const rows = await db`SELECT * FROM auth.users WHERE email = ${email} LIMIT 1`;
    return rows[0] ? parseUser(rows[0]) : null;
  },

  async getUserById(id: string) {
    const db = getDb();
    const rows = await withAuthQueryTiming(
      "getUserById",
      { id },
      () => db`SELECT * FROM auth.users WHERE id = ${id} LIMIT 1`,
    );
    return rows[0] ? parseUser(rows[0]) : null;
  },

  async getUserByUsername(username: string) {
    const db = getDb();
    const rows = await db`
      SELECT * FROM auth.users
      WHERE lower(username) = lower(${username})
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ? parseUser(rows[0]) : null;
  },

  async isUsernameTaken(username: string, exceptUserId?: string) {
    const db = getDb();
    const rows = await db`
      SELECT 1 FROM auth.users
      WHERE lower(username) = lower(${username})
        AND deleted_at IS NULL
        ${exceptUserId ? db`AND id <> ${exceptUserId}::uuid` : db``}
      LIMIT 1
    `;
    return rows.length > 0;
  },

  async setPinCredentials(userId: string, username: string, pinHash: string) {
    const db = getDb();
    const rows = await db`
      UPDATE auth.users
      SET username = ${username},
          pin_hash = ${pinHash},
          pin_set_at = NOW(),
          pin_failed_logins = 0,
          pin_locked_until = NULL,
          last_pin_failed_at = NULL,
          updated_at = NOW()
      WHERE id = ${userId}::uuid
      RETURNING *
    `;
    return rows[0] ? parseUser(rows[0]) : null;
  },

  async clearPinHash(userId: string) {
    const db = getDb();
    await db`
      UPDATE auth.users
      SET pin_hash = NULL,
          pin_set_at = NULL,
          pin_failed_logins = 0,
          pin_locked_until = NULL,
          last_pin_failed_at = NULL,
          updated_at = NOW()
      WHERE id = ${userId}::uuid
    `;
  },

  async registerPinFailure(userId: string, failedLogins: number, lockedUntil: Date | null) {
    const db = getDb();
    const rows = await db`
      UPDATE auth.users
      SET pin_failed_logins = ${failedLogins},
          pin_locked_until = ${lockedUntil},
          last_pin_failed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${userId}::uuid
      RETURNING pin_failed_logins, pin_locked_until
    `;
    return rows[0] ?? null;
  },

  async resetPinFailure(userId: string) {
    const db = getDb();
    await db`
      UPDATE auth.users
      SET pin_failed_logins = 0,
          pin_locked_until = NULL,
          last_pin_failed_at = NULL,
          updated_at = NOW()
      WHERE id = ${userId}::uuid
    `;
  },

  async recordPinAttempt(input: {
    userId: string | null;
    usernameAttempted: string;
    ipAddress: string;
    userAgent: string;
    deviceId: string | null;
    success: boolean;
    failureReason?: string | null;
  }) {
    const db = getDb();
    const userId = input.userId ?? null;
    const failureReason = input.failureReason ?? null;
    await db`
      INSERT INTO auth.pin_login_attempts (
        user_id, username_attempted, ip_address, user_agent, device_id, success, failure_reason
      ) VALUES (
        ${userId}::uuid, ${input.usernameAttempted}, ${input.ipAddress}, ${input.userAgent},
        ${input.deviceId}, ${input.success}, ${failureReason}
      )
    `;
  },

  async countRecentPinFailuresByIp(ipAddress: string, since: Date) {
    const db = getDb();
    if (!ipAddress) return 0;
    const rows = await db`
      SELECT COUNT(*)::int AS total
      FROM auth.pin_login_attempts
      WHERE ip_address = ${ipAddress}
        AND success = FALSE
        AND created_at >= ${since}
    `;
    return Number(rows[0]?.total ?? 0);
  },

  async countRecentPinFailuresByDevice(deviceId: string, since: Date) {
    const db = getDb();
    if (!deviceId) return 0;
    const rows = await db`
      SELECT COUNT(*)::int AS total
      FROM auth.pin_login_attempts
      WHERE device_id = ${deviceId}
        AND success = FALSE
        AND created_at >= ${since}
    `;
    return Number(rows[0]?.total ?? 0);
  },

  async listUsers() {
    const db = getDb();
    const rows = await db`SELECT * FROM auth.users ORDER BY created_at DESC`;
    return rows.map(parseUser);
  },

  async upsertUser(input: {
    email: string;
    emailVerified: boolean;
    displayName: string;
    avatarUrl: string;
    provider: string;
    providerUid: string | null;
    providers: string[];
    userMetadata: Record<string, unknown>;
    appMetadata: Record<string, unknown>;
    identityData: Record<string, unknown>;
    roleOverride?: string;
  }) {
    const db = getDb();
    const assignedRole = input.roleOverride ? normalizeRole(input.roleOverride) : defaultRoleForEmail(input.email);
    const hasRoleOverride = Boolean(input.roleOverride);
    const appMetadata = db.json(input.appMetadata as any);
    const userMetadata = db.json(input.userMetadata as any);
    const identityData = db.json(input.identityData as any);
    const providerUid = input.providerUid || null;
    const rows = await db`
      INSERT INTO auth.users (
        email, email_verified, role, permissions, status, is_anonymous, is_sso_user,
        display_name, full_name, avatar_url, raw_app_meta_data, raw_user_meta_data,
        providers, provider, provider_uid, identity_data, referral_code, confirmed_at,
        last_sign_in_at, login_count, created_at, updated_at
      ) VALUES (
        ${input.email}, ${input.emailVerified}, ${assignedRole},
        COALESCE((
          SELECT jsonb_agg(permission ORDER BY permission)
          FROM role_permissions
          WHERE role = ${assignedRole}
        ), '[]'::jsonb),
        'active', false, ${input.provider !== "email"},
        ${input.displayName}, ${input.displayName}, ${input.avatarUrl}, ${appMetadata},
        ${userMetadata}, ${input.providers}, ${input.provider}, ${providerUid},
        ${identityData}, 'COGNI-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
        NOW(), NOW(), 1, NOW(), NOW()
      )
      ON CONFLICT (email) DO UPDATE SET
        email_verified = EXCLUDED.email_verified OR auth.users.email_verified,
        display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), auth.users.display_name),
        full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), auth.users.full_name),
        avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), auth.users.avatar_url),
        raw_app_meta_data = COALESCE(EXCLUDED.raw_app_meta_data, auth.users.raw_app_meta_data),
        raw_user_meta_data = COALESCE(EXCLUDED.raw_user_meta_data, auth.users.raw_user_meta_data),
        provider = COALESCE(NULLIF(EXCLUDED.provider, ''), auth.users.provider),
        provider_uid = CASE
          WHEN EXCLUDED.provider = 'email' THEN NULL
          ELSE COALESCE(NULLIF(EXCLUDED.provider_uid, ''), auth.users.provider_uid)
        END,
        identity_data = COALESCE(EXCLUDED.identity_data, auth.users.identity_data),
        role = CASE
          WHEN ${hasRoleOverride} AND EXISTS (
            SELECT 1
            FROM auth.privileged_access_grants pag
            WHERE lower(pag.email) = lower(auth.users.email)
              AND pag.status = 'active'
              AND pag.role = ${assignedRole}
          ) THEN ${assignedRole}
          WHEN ${isDefaultAdminEmail(input.email)} THEN ${assignedRole}
          ELSE auth.users.role
        END,
        permissions = COALESCE((
          SELECT jsonb_agg(permission ORDER BY permission)
          FROM role_permissions
          WHERE role = CASE
            WHEN ${hasRoleOverride} AND EXISTS (
              SELECT 1
              FROM auth.privileged_access_grants pag
              WHERE lower(pag.email) = lower(auth.users.email)
                AND pag.status = 'active'
                AND pag.role = ${assignedRole}
            ) THEN ${assignedRole}
            WHEN ${isDefaultAdminEmail(input.email)} THEN ${assignedRole}
            ELSE auth.users.role
          END
        ), auth.users.permissions, '[]'::jsonb),
        last_sign_in_at = NOW(),
        login_count = auth.users.login_count + 1,
        updated_at = NOW()
      RETURNING *
    `;
    return parseUser(rows[0]);
  },

  async createSession(input: {
    userId: string;
    email: string;
    role: string;
    tokenHash: string;
    refreshTokenHash: string;
    expiresAt: Date;
    refreshExpiresAt: Date;
    ipAddress: string;
    userAgent: string;
    deviceFingerprint: string;
    deviceName: string;
    deviceType: string;
    browser: string;
    os: string;
    deviceId?: string | null;
  }) {
    const db = getDb();
    const deviceId = input.deviceId ?? null;
    const rows = await db`
      INSERT INTO auth.sessions (
        user_id, email, role, token_hash, refresh_token_hash, expires_at, refresh_expires_at,
        ip_address, user_agent, device_fingerprint, device_name, device_type, browser, os, device_id
      ) VALUES (
        ${input.userId}, ${input.email}, ${input.role}, ${input.tokenHash}, ${input.refreshTokenHash},
        ${input.expiresAt}, ${input.refreshExpiresAt}, ${input.ipAddress}, ${input.userAgent},
        ${input.deviceFingerprint}, ${input.deviceName}, ${input.deviceType}, ${input.browser}, ${input.os},
        ${deviceId}
      )
      RETURNING *
    `;
    return parseSession(rows[0]);
  },

  async getSessionById(sessionId: string) {
    const db = getDb();
    const rows = await db`SELECT * FROM auth.sessions WHERE id = ${sessionId} LIMIT 1`;
    return rows[0] ? parseSession(rows[0]) : null;
  },

  async getSessionAndUser(sessionId: string, userId: string) {
    const db = getDb();
    const rows = await withAuthQueryTiming(
      "getSessionAndUser",
      { sessionId, userId },
      () => db`
        SELECT
          s.id, s.user_id, s.email, s.role, s.token_hash, s.refresh_token_hash,
          s.expires_at, s.refresh_expires_at, s.ip_address, s.user_agent,
          s.device_fingerprint, s.device_name, s.device_type, s.browser, s.os,
          s.is_revoked, s.revoked_at, s.revoked_reason, s.reuse_detected_at,
          s.created_at, s.last_active, s.device_id,
          u.id AS u_id, u.email AS u_email, u.phone AS u_phone,
          u.email_verified AS u_email_verified, u.phone_verified AS u_phone_verified,
          u.role AS u_role, u.status AS u_status, u.banned_until AS u_banned_until,
          u.is_anonymous AS u_is_anonymous, u.is_sso_user AS u_is_sso_user,
          u.display_name AS u_display_name, u.full_name AS u_full_name,
          u.avatar_url AS u_avatar_url, u.raw_app_meta_data AS u_raw_app_meta_data,
          u.raw_user_meta_data AS u_raw_user_meta_data, u.providers AS u_providers,
          u.provider AS u_provider, u.provider_uid AS u_provider_uid,
          u.identity_data AS u_identity_data, u.permissions AS u_permissions,
          u.created_at AS u_created_at, u.updated_at AS u_updated_at,
          u.confirmed_at AS u_confirmed_at, u.last_sign_in_at AS u_last_sign_in_at,
          u.login_count AS u_login_count, u.failed_logins AS u_failed_logins,
          u.locked_until AS u_locked_until,
          u.username AS u_username, u.pin_hash AS u_pin_hash,
          u.pin_failed_logins AS u_pin_failed_logins,
          u.pin_locked_until AS u_pin_locked_until,
          u.pin_set_at AS u_pin_set_at,
          u.last_pin_failed_at AS u_last_pin_failed_at
        FROM auth.sessions s
        INNER JOIN auth.users u ON u.id = s.user_id
        WHERE s.id = ${sessionId}
          AND s.user_id = ${userId}
        LIMIT 1
      `,
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      session: parseSession({
        id: row.id, user_id: row.user_id, email: row.email, role: row.role,
        token_hash: row.token_hash, refresh_token_hash: row.refresh_token_hash,
        expires_at: row.expires_at, refresh_expires_at: row.refresh_expires_at,
        ip_address: row.ip_address, user_agent: row.user_agent,
        device_fingerprint: row.device_fingerprint, device_name: row.device_name,
        device_type: row.device_type, browser: row.browser, os: row.os,
        is_revoked: row.is_revoked, revoked_at: row.revoked_at,
        revoked_reason: row.revoked_reason, reuse_detected_at: row.reuse_detected_at,
        created_at: row.created_at, last_active: row.last_active,
        device_id: row.device_id,
      } as Record<string, unknown>),
      user: parseUser({
        id: row.u_id, email: row.u_email, phone: row.u_phone,
        email_verified: row.u_email_verified, phone_verified: row.u_phone_verified,
        role: row.u_role, status: row.u_status, banned_until: row.u_banned_until,
        is_anonymous: row.u_is_anonymous, is_sso_user: row.u_is_sso_user,
        display_name: row.u_display_name, full_name: row.u_full_name,
        avatar_url: row.u_avatar_url, raw_app_meta_data: row.u_raw_app_meta_data,
        raw_user_meta_data: row.u_raw_user_meta_data, providers: row.u_providers,
        provider: row.u_provider, provider_uid: row.u_provider_uid,
        identity_data: row.u_identity_data, permissions: row.u_permissions,
        created_at: row.u_created_at, updated_at: row.u_updated_at,
        confirmed_at: row.u_confirmed_at, last_sign_in_at: row.u_last_sign_in_at,
        login_count: row.u_login_count, failed_logins: row.u_failed_logins,
        locked_until: row.u_locked_until,
        username: row.u_username,
        pin_hash: row.u_pin_hash,
        pin_failed_logins: row.u_pin_failed_logins,
        pin_locked_until: row.u_pin_locked_until,
        pin_set_at: row.u_pin_set_at,
        last_pin_failed_at: row.u_last_pin_failed_at,
      } as Record<string, unknown>),
    };
  },

  async listActiveSessionsByUser(userId: string) {
    const db = getDb();
    await db`
      DELETE FROM auth.sessions
      WHERE user_id = ${userId} AND refresh_expires_at < NOW()
    `;
    const rows = await db`
      SELECT * FROM auth.sessions
      WHERE user_id = ${userId}
        AND is_revoked = false
        AND (refresh_expires_at IS NULL OR refresh_expires_at > NOW())
      ORDER BY created_at DESC
    `;
    return rows.map(parseSession);
  },

  async updateSessionTokens(sessionId: string, accessHash: string, refreshHash: string, accessExpiry: Date, refreshExpiry: Date) {
    const db = getDb();
    await db`
      UPDATE auth.sessions
      SET token_hash = ${accessHash},
          refresh_token_hash = ${refreshHash},
          expires_at = ${accessExpiry},
          refresh_expires_at = ${refreshExpiry},
          last_active = NOW()
      WHERE id = ${sessionId}
    `;
  },

  async updateActiveSessionRoles(userId: string, role: string) {
    const db = getDb();
    await db`
      UPDATE auth.sessions
      SET role = ${role}
      WHERE user_id = ${userId} AND is_revoked = FALSE
    `;
  },

  async revokeSession(sessionId: string, userId: string, reason: string) {
    const db = getDb();
    // Pass the revocation reason to the DB function for accurate audit trails
    await db`SELECT revoke_session_and_cleanup(${sessionId}::uuid, ${userId}::uuid, ${reason})`;
  },

  async revokeAllSessions(userId: string, reason: string, exceptSessionId?: string) {
    const db = getDb();
    // Pass the revocation reason to the DB function for accurate audit trails
    if (exceptSessionId) {
      await db`SELECT revoke_all_sessions(${userId}::uuid, ${exceptSessionId}::uuid, ${reason})`;
    } else {
      await db`SELECT revoke_all_sessions(${userId}::uuid, NULL::uuid, ${reason})`;
    }
  },

  async markReuseDetected(sessionId: string) {
    const db = getDb();
    await db`
      UPDATE auth.sessions
      SET reuse_detected_at = NOW(), is_revoked = true, revoked_at = NOW(), revoked_reason = 'token_reuse_detected'
      WHERE id = ${sessionId}
    `;
  },

  async insertActivity(userId: string, activityType: string, description: string, sessionId: string | null, metadata: Record<string, unknown>) {
    const db = getDb();
    const metadataJson = db.json(metadata as any);
    await db`
      INSERT INTO auth.activity_log (user_id, activity_type, description, session_id, metadata)
      VALUES (${userId}, ${activityType}, ${description}, ${sessionId}, ${metadataJson})
    `;
  },
};
