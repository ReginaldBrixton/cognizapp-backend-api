import { getDb } from "../../../lib/db";

export type OtpCodeRecord = {
  id: string;
  email: string;
  codeHash: string;
  magicLinkTokenHash: string | null;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
  lastSentAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  verified: boolean;
  verifiedAt: Date | null;
};

function parseOtpCode(row: Record<string, unknown>): OtpCodeRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    codeHash: String(row.code_hash),
    magicLinkTokenHash: row.magic_link_token_hash ? String(row.magic_link_token_hash) : null,
    expiresAt: new Date(String(row.expires_at)),
    attempts: Number(row.attempts ?? 0),
    createdAt: new Date(String(row.created_at)),
    lastSentAt: new Date(String(row.last_sent_at)),
    ipAddress: row.ip_address ? String(row.ip_address) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    verified: Boolean(row.verified),
    verifiedAt: row.verified_at ? new Date(String(row.verified_at)) : null,
  };
}

export const otpRepository = {
  async createOtpCode(input: {
    email: string;
    codeHash: string;
    magicLinkTokenHash?: string | null;
    expiresAt: Date;
    ipAddress: string;
    userAgent: string;
  }) {
    const db = getDb();
    const rows = await db`
      INSERT INTO auth.auth_codes (email, code_hash, magic_link_token_hash, expires_at, ip_address, user_agent)
      VALUES (${input.email}, ${input.codeHash}, ${input.magicLinkTokenHash ?? null}, ${input.expiresAt}, ${input.ipAddress}, ${input.userAgent})
      RETURNING *
    `;
    return parseOtpCode(rows[0]);
  },

  async getActiveOtpCodeByMagicLinkToken(tokenHash: string) {
    const db = getDb();
    const rows = await db`
      SELECT *
      FROM auth.auth_codes
      WHERE magic_link_token_hash = ${tokenHash}
        AND verified = FALSE
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? parseOtpCode(rows[0]) : null;
  },

  async getActiveOtpCodes(email: string) {
    const db = getDb();
    const rows = await db`
      SELECT *
      FROM auth.auth_codes
      WHERE email = ${email}
        AND verified = FALSE
        AND expires_at > NOW()
      ORDER BY created_at DESC
    `;
    return rows.map(parseOtpCode);
  },

  async getActiveOtpCode(email: string) {
    const rows = await this.getActiveOtpCodes(email);
    return rows[0] ?? null;
  },

  async incrementOtpAttempts(id: string) {
    const db = getDb();
    const rows = await db`
      UPDATE auth.auth_codes
      SET attempts = attempts + 1
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? parseOtpCode(rows[0]) : null;
  },

  async markOtpVerified(id: string) {
    const db = getDb();
    await db`
      UPDATE auth.auth_codes
      SET verified = TRUE,
          verified_at = NOW()
      WHERE id = ${id}
    `;
  },

  async markOtherActiveCodesVerified(email: string, verifiedId: string) {
    const db = getDb();
    await db`
      UPDATE auth.auth_codes
      SET verified = TRUE,
          verified_at = COALESCE(verified_at, NOW())
      WHERE email = ${email}
        AND id <> ${verifiedId}
        AND verified = FALSE
        AND expires_at > NOW()
    `;
  },

  async cleanupExpiredCodes() {
    const db = getDb();
    await db`SELECT auth.cleanup_expired_auth_codes()`;
  },

  async getLastSentCode(email: string) {
    const db = getDb();
    const rows = await db`
      SELECT *
      FROM auth.auth_codes
      WHERE email = ${email}
      ORDER BY last_sent_at DESC
      LIMIT 1
    `;
    return rows[0] ? parseOtpCode(rows[0]) : null;
  },

  async countRecentRequests(email: string, ipAddress: string, since: Date) {
    const db = getDb();
    const rows = await db`
      SELECT count(*)::int AS count
      FROM auth.auth_codes
      WHERE created_at >= ${since}
        AND (email = ${email} OR (${ipAddress} <> '' AND ip_address = ${ipAddress}))
    `;
    return Number(rows[0]?.count ?? 0);
  },
};
