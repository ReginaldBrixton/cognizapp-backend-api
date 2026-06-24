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
  }) {
    const db = getDb();
    const rows = await db`
      INSERT INTO auth.sessions (
        user_id, email, role, token_hash, refresh_token_hash, expires_at, refresh_expires_at,
        ip_address, user_agent, device_fingerprint, device_name, device_type, browser, os
      ) VALUES (
        ${input.userId}, ${input.email}, ${input.role}, ${input.tokenHash}, ${input.refreshTokenHash},
        ${input.expiresAt}, ${input.refreshExpiresAt}, ${input.ipAddress}, ${input.userAgent},
        ${input.deviceFingerprint}, ${input.deviceName}, ${input.deviceType}, ${input.browser}, ${input.os}
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
          to_jsonb(s.*) AS session,
          to_jsonb(u.*) AS user
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
      session: parseSession(row.session as Record<string, unknown>),
      user: parseUser(row.user as Record<string, unknown>),
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
