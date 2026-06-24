import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL_DEV;
if (!databaseUrl) {
  console.error("DATABASE_URL_DEV not set");
  process.exit(1);
}

const sql = postgres(databaseUrl);

console.log("=== DATABASE INVESTIGATION ===\n");

// 1. Check all users
const users = await sql`
  SELECT id, email, display_name, role, status, storage_tier, storage_quota_bytes, storage_used_bytes
  FROM auth.users
  WHERE deleted_at IS NULL
  ORDER BY created_at DESC
`;
console.log("USERS:", users.length);
for (const u of users) {
  console.log(`  - ${u.email} (${u.id}) | role: ${u.role} | status: ${u.status}`);
}

// 2. Check all workspaces
const workspaces = await sql`
  SELECT w.id, w.name, w.owner_uid, w.status, w.is_default, w.slug, w.deleted_at,
         (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.deleted_at IS NULL) AS member_count
  FROM workspaces w
  ORDER BY w.created_at DESC
`;
console.log("\nWORKSPACES:", workspaces.length);
for (const w of workspaces) {
  console.log(`  - ${w.name} (${w.id}) | owner: ${w.owner_uid} | members: ${w.member_count} | default: ${w.is_default} | status: ${w.status}`);
}

// 3. Check workspace_members
const members = await sql`
  SELECT wm.workspace_id, wm.user_uid, wm.role, wm.status, wm.email, w.name AS workspace_name
  FROM workspace_members wm
  JOIN workspaces w ON w.id = wm.workspace_id
  WHERE wm.deleted_at IS NULL
  ORDER BY wm.workspace_id, wm.role
`;
console.log("\nWORKSPACE MEMBERS:", members.length);
for (const m of members) {
  console.log(`  - Workspace: ${m.workspace_name} | User: ${m.user_uid} (${m.email}) | Role: ${m.role} | Status: ${m.status}`);
}

// 4. Check projects
const projects = await sql`
  SELECT wp.id, wp.title, wp.workspace_id, wp.owner_uid, wp.status, w.name AS workspace_name
  FROM workspace_projects wp
  JOIN workspaces w ON w.id = wp.workspace_id
  WHERE wp.deleted_at IS NULL
  ORDER BY wp.created_at DESC
`;
console.log("\nPROJECTS:", projects.length);
for (const p of projects) {
  console.log(`  - ${p.title} (${p.id}) | workspace: ${p.workspace_name} | owner: ${p.owner_uid} | status: ${p.status}`);
}

// 5. Check collections
const collections = await sql`
  SELECT wc.id, wc.name, wc.workspace_id, wc.owner_uid, wc.collection_type, w.name AS workspace_name
  FROM workspace_collections wc
  JOIN workspaces w ON w.id = wc.workspace_id
  WHERE wc.deleted_at IS NULL
  ORDER BY wc.created_at DESC
`;
console.log("\nCOLLECTIONS:", collections.length);
for (const c of collections) {
  console.log(`  - ${c.name} (${c.id}) | workspace: ${c.workspace_name} | owner: ${c.owner_uid} | type: ${c.collection_type}`);
}

// 6. Check analysis
const analysis = await sql`
  SELECT wa.id, wa.title, wa.workspace_id, wa.owner_uid, wa.analysis_type, wa.status, w.name AS workspace_name
  FROM workspace_analysis wa
  JOIN workspaces w ON w.id = wa.workspace_id
  WHERE wa.deleted_at IS NULL
  ORDER BY wa.created_at DESC
`;
console.log("\nANALYSIS:", analysis.length);
for (const a of analysis) {
  console.log(`  - ${a.title} (${a.id}) | workspace: ${a.workspace_name} | owner: ${a.owner_uid} | type: ${a.analysis_type} | status: ${a.status}`);
}

// 7. Check dashboard stats table
const dashboardStats = await sql`
  SELECT * FROM user_dashboard_stats
  ORDER BY last_computed_at DESC
`;
console.log("\nDASHBOARD STATS:", dashboardStats.length);
for (const d of dashboardStats) {
  console.log(`  - User: ${d.user_id}`);
  console.log(`    Workspaces: ${d.owned_workspaces} owned, ${d.member_workspaces} member, ${d.total_workspaces} total`);
  console.log(`    Projects: ${d.total_projects} total, ${d.active_projects} active`);
  console.log(`    Collections: ${d.total_collections} total`);
  console.log(`    Analysis: ${d.total_analysis} total, ${d.pending_analysis} pending`);
  console.log(`    Activity: ${d.total_activity} events`);
  console.log(`    Sessions: ${d.total_sessions} total, ${d.active_sessions} active`);
  console.log(`    Notifications: ${d.unread_notifications} unread`);
  console.log(`    Storage: ${d.storage_used_bytes} / ${d.storage_quota_bytes} (${d.storage_tier})`);
}

// 8. CROSS-CHECK: Compare actual counts vs dashboard stats
console.log("\n=== CROSS-CHECK: ACTUAL COUNTS vs DASHBOARD STATS ===\n");

for (const u of users) {
  const userId = u.id;
  const stats = dashboardStats.find(d => String(d.user_id) === userId);

  // Actual workspace counts
  const actualOwned = await sql`SELECT COUNT(*)::int AS count FROM workspaces WHERE owner_uid = ${userId} AND deleted_at IS NULL`;
  const actualMember = await sql`
    SELECT COUNT(DISTINCT w.id)::int AS count
    FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id
    WHERE m.user_uid = ${userId} AND m.deleted_at IS NULL AND w.deleted_at IS NULL AND w.owner_uid != ${userId}
  `;
  const actualProjects = await sql`
    SELECT COUNT(*)::int AS count FROM workspace_projects wp
    JOIN workspaces w ON w.id = wp.workspace_id
    WHERE w.owner_uid = ${userId} AND wp.deleted_at IS NULL AND w.deleted_at IS NULL
  `;
  const actualCollections = await sql`
    SELECT COUNT(*)::int AS count FROM workspace_collections wc
    JOIN workspaces w ON w.id = wc.workspace_id
    WHERE w.owner_uid = ${userId} AND wc.deleted_at IS NULL AND w.deleted_at IS NULL
  `;
  const actualAnalysis = await sql`
    SELECT COUNT(*)::int AS count FROM workspace_analysis wa
    JOIN workspaces w ON w.id = wa.workspace_id
    WHERE w.owner_uid = ${userId} AND wa.deleted_at IS NULL AND w.deleted_at IS NULL
  `;
  const actualActivity = await sql`
    SELECT COUNT(*)::int AS count FROM workspace_activity wa
    JOIN workspaces w ON w.id = wa.workspace_id
    WHERE w.owner_uid = ${userId} AND w.deleted_at IS NULL
  `;
  const actualSessions = await sql`SELECT COUNT(*)::int AS count FROM auth.sessions WHERE user_id = ${userId}`;
  const actualActiveSessions = await sql`SELECT COUNT(*)::int AS count FROM auth.sessions WHERE user_id = ${userId} AND is_revoked = FALSE AND expires_at > NOW()`;
  const actualUnreadNotifs = await sql`SELECT COUNT(*)::int AS count FROM auth.notifications WHERE user_id = ${userId} AND is_read = FALSE AND is_archived = FALSE`;

  console.log(`User: ${u.email} (${userId})`);
  console.log(`  Workspaces - Actual: ${actualOwned[0].count} owned, ${actualMember[0].count} member | Stats: ${stats?.owned_workspaces} owned, ${stats?.member_workspaces} member | ${actualOwned[0].count === stats?.owned_workspaces ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Projects   - Actual: ${actualProjects[0].count} | Stats: ${stats?.total_projects} | ${actualProjects[0].count === stats?.total_projects ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Collections - Actual: ${actualCollections[0].count} | Stats: ${stats?.total_collections} | ${actualCollections[0].count === stats?.total_collections ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Analysis   - Actual: ${actualAnalysis[0].count} | Stats: ${stats?.total_analysis} | ${actualAnalysis[0].count === stats?.total_analysis ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Activity   - Actual: ${actualActivity[0].count} | Stats: ${stats?.total_activity} | ${actualActivity[0].count === stats?.total_activity ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Sessions   - Actual: ${actualSessions[0].count} total, ${actualActiveSessions[0].count} active | Stats: ${stats?.total_sessions} total, ${stats?.active_sessions} active | ${actualSessions[0].count === stats?.total_sessions ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Notifs     - Actual: ${actualUnreadNotifs[0].count} unread | Stats: ${stats?.unread_notifications} | ${actualUnreadNotifs[0].count === stats?.unread_notifications ? '✅' : '❌ MISMATCH'}`);
  console.log("");
}

// 9. Check for orphaned records
console.log("=== ORPHANED RECORDS CHECK ===\n");

const orphanedProjects = await sql`
  SELECT wp.id, wp.title, wp.workspace_id, wp.owner_uid
  FROM workspace_projects wp
  LEFT JOIN workspaces w ON w.id = wp.workspace_id
  WHERE w.id IS NULL AND wp.deleted_at IS NULL
`;
console.log("Orphaned projects (no workspace):", orphanedProjects.length);

const orphanedCollections = await sql`
  SELECT wc.id, wc.name, wc.workspace_id, wc.owner_uid
  FROM workspace_collections wc
  LEFT JOIN workspaces w ON w.id = wc.workspace_id
  WHERE w.id IS NULL AND wc.deleted_at IS NULL
`;
console.log("Orphaned collections (no workspace):", orphanedCollections.length);

const orphanedAnalysis = await sql`
  SELECT wa.id, wa.title, wa.workspace_id, wa.owner_uid
  FROM workspace_analysis wa
  LEFT JOIN workspaces w ON w.id = wa.workspace_id
  WHERE w.id IS NULL AND wa.deleted_at IS NULL
`;
console.log("Orphaned analysis (no workspace):", orphanedAnalysis.length);

const orphanedMembers = await sql`
  SELECT wm.id, wm.workspace_id, wm.user_uid
  FROM workspace_members wm
  LEFT JOIN workspaces w ON w.id = wm.workspace_id
  WHERE w.id IS NULL AND wm.deleted_at IS NULL
`;
console.log("Orphaned members (no workspace):", orphanedMembers.length);

const orphanedInvitations = await sql`
  SELECT wi.id, wi.workspace_id, wi.email
  FROM workspace_invitations wi
  LEFT JOIN workspaces w ON w.id = wi.workspace_id
  WHERE w.id IS NULL
`;
console.log("Orphaned invitations (no workspace):", orphanedInvitations.length);

const orphanedActivity = await sql`
  SELECT wa.id, wa.workspace_id, wa.activity_type
  FROM workspace_activity wa
  LEFT JOIN workspaces w ON w.id = wa.workspace_id
  WHERE w.id IS NULL
`;
console.log("Orphaned activity (no workspace):", orphanedActivity.length);

// 10. Check for workspace owner mismatches
console.log("\n=== WORKSPACE OWNER MISMATCHES ===\n");

const ownerMismatches = await sql`
  SELECT w.id, w.name, w.owner_uid, wm.user_uid AS member_owner_uid
  FROM workspaces w
  LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
  WHERE w.owner_uid != wm.user_uid AND wm.user_uid IS NOT NULL AND w.deleted_at IS NULL
`;
console.log("Workspace owner mismatches:", ownerMismatches.length);
for (const m of ownerMismatches) {
  console.log(`  - ${m.name}: owner_uid=${m.owner_uid} but member owner=${m.member_owner_uid}`);
}

// 11. Check workspace counters consistency
console.log("\n=== WORKSPACE COUNTERS CHECK ===\n");

for (const w of workspaces) {
  const actualProjects = await sql`SELECT COUNT(*)::int AS count FROM workspace_projects WHERE workspace_id = ${w.id} AND deleted_at IS NULL`;
  const actualCollections = await sql`SELECT COUNT(*)::int AS count FROM workspace_collections WHERE workspace_id = ${w.id} AND deleted_at IS NULL`;
  const actualAnalysis = await sql`SELECT COUNT(*)::int AS count FROM workspace_analysis WHERE workspace_id = ${w.id} AND deleted_at IS NULL`;
  const actualMembers = await sql`SELECT COUNT(*)::int AS count FROM workspace_members WHERE workspace_id = ${w.id} AND deleted_at IS NULL`;

  const counters = w.counters || {};
  const wsProjects = Number(counters.projects || 0);
  const wsCollections = Number(counters.collections || 0);
  const wsMembers = Number(counters.members || 0);

  console.log(`Workspace: ${w.name} (${w.id})`);
  console.log(`  Projects: actual=${actualProjects[0].count} | counters=${wsProjects} | ${actualProjects[0].count === wsProjects ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Collections: actual=${actualCollections[0].count} | counters=${wsCollections} | ${actualCollections[0].count === wsCollections ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Members: actual=${actualMembers[0].count} | counters=${wsMembers} | ${actualMembers[0].count === wsMembers ? '✅' : '❌ MISMATCH'}`);
}

await sql.end();
console.log("\n=== INVESTIGATION COMPLETE ===");
