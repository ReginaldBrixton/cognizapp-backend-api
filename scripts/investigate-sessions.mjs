import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL_DEV;
if (!databaseUrl) { console.error("DATABASE_URL_DEV not set"); process.exit(1); }
const sql = postgres(databaseUrl);

console.log("=== SESSION & OWNERSHIP INVESTIGATION ===\n");

// 1. Check all sessions
const sessions = await sql`
  SELECT s.id, s.user_id, u.email, s.device_name, s.browser, s.os, s.ip_address,
    s.is_revoked, s.expires_at, s.last_active, s.created_at,
    CASE WHEN s.expires_at < NOW() THEN 'expired'
         WHEN s.is_revoked THEN 'revoked'
         ELSE 'active'
    END AS session_status
  FROM auth.sessions s
  LEFT JOIN auth.users u ON u.id = s.user_id
  ORDER BY s.user_id, s.created_at DESC
`;
console.log("TOTAL SESSIONS:", sessions.length);
const activeSessions = sessions.filter(s => s.session_status === "active");
const expiredSessions = sessions.filter(s => s.session_status === "expired");
const revokedSessions = sessions.filter(s => s.session_status === "revoked");
console.log("  Active:", activeSessions.length);
console.log("  Expired:", expiredSessions.length);
console.log("  Revoked:", revokedSessions.length);

// 2. Check workspace ownership consistency
console.log("\n=== WORKSPACE OWNERSHIP CHECK ===\n");
const workspaces = await sql`
  SELECT w.id, w.name, w.owner_uid, w.status, w.deleted_at,
    u.email AS owner_email, u.status AS owner_status,
    (SELECT COUNT(*)::int FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.deleted_at IS NULL) AS member_count
  FROM workspaces w
  LEFT JOIN auth.users u ON u.id::text = w.owner_uid
  ORDER BY w.owner_uid, w.created_at
`;
for (const w of workspaces) {
  const isDeleted = w.deleted_at ? "DELETED" : "active";
  const ownerExists = w.owner_email ? "✅" : "❌ NO OWNER";
  console.log(`  ${w.name} | owner: ${w.owner_email || "NULL"} (${w.owner_status || "unknown"}) | status: ${isDeleted} | ${ownerExists}`);
}

// 3. Check for workspaces with no valid owner
const orphanedWorkspaces = await sql`
  SELECT w.id, w.name, w.owner_uid
  FROM workspaces w
  LEFT JOIN auth.users u ON u.id::text = w.owner_uid
  WHERE u.id IS NULL
`;
console.log("\nOrphaned workspaces (no owner in users table):", orphanedWorkspaces.length);

// 4. Check for duplicate workspace members
const duplicateMembers = await sql`
  SELECT workspace_id, user_uid, COUNT(*) AS count
  FROM workspace_members
  WHERE deleted_at IS NULL
  GROUP BY workspace_id, user_uid
  HAVING COUNT(*) > 1
`;
console.log("Duplicate workspace members:", duplicateMembers.length);

// 5. Check session counts per user
const sessionCounts = await sql`
  SELECT u.email, u.id,
    (SELECT COUNT(*)::int FROM auth.sessions s WHERE s.user_id = u.id AND s.is_revoked = FALSE AND s.expires_at > NOW()) AS active_count,
    (SELECT COUNT(*)::int FROM auth.sessions s WHERE s.user_id = u.id AND s.is_revoked = TRUE) AS revoked_count,
    (SELECT COUNT(*)::int FROM auth.sessions s WHERE s.user_id = u.id AND s.expires_at < NOW()) AS expired_count
  FROM auth.users u
  WHERE u.deleted_at IS NULL
  ORDER BY u.email
`;
console.log("\n=== SESSION COUNTS PER USER ===");
for (const s of sessionCounts) {
  console.log(`  ${s.email}: active=${s.active_count} | revoked=${s.revoked_count} | expired=${s.expired_count}`);
}

// 6. Check old expired sessions that should be cleaned
const oldExpired = await sql`
  SELECT COUNT(*)::int AS count, MIN(expires_at) AS oldest_expiry
  FROM auth.sessions
  WHERE expires_at < NOW() - INTERVAL '7 days'
`;
console.log("\nExpired sessions older than 7 days:", oldExpired[0].count);
console.log("Oldest expired:", oldExpired[0].oldest_expiry);

// 7. Check old revoked sessions
const oldRevoked = await sql`
  SELECT COUNT(*)::int AS count, MIN(revoked_at) AS oldest_revoked
  FROM auth.sessions
  WHERE is_revoked = TRUE AND revoked_at < NOW() - INTERVAL '7 days'
`;
console.log("Revoked sessions older than 7 days:", oldRevoked[0].count);
console.log("Oldest revoked:", oldRevoked[0].oldest_revoked);

await sql.end();
console.log("\n=== INVESTIGATION COMPLETE ===");
