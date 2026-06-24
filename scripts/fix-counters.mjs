import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL_DEV;
if (!databaseUrl) {
  console.error("DATABASE_URL_DEV not set");
  process.exit(1);
}

const sql = postgres(databaseUrl);

console.log("Fixing workspace counters...\n");

const workspaces = await sql`
  SELECT w.id, w.name,
    (SELECT COUNT(*)::int FROM workspace_projects WHERE workspace_id = w.id AND deleted_at IS NULL) AS project_count,
    (SELECT COUNT(*)::int FROM workspace_collections WHERE workspace_id = w.id AND deleted_at IS NULL) AS collection_count,
    (SELECT COUNT(*)::int FROM workspace_analysis WHERE workspace_id = w.id AND deleted_at IS NULL) AS analysis_count,
    (SELECT COUNT(*)::int FROM workspace_members WHERE workspace_id = w.id AND deleted_at IS NULL) AS member_count
  FROM workspaces w
`;

for (const w of workspaces) {
  const counters = JSON.stringify({
    projects: w.project_count,
    collections: w.collection_count,
    analysis: w.analysis_count,
    members: w.member_count,
    tasks: 0,
    notes: 0,
    files: 0,
    chats: 0,
    automations: 0,
    storageUsed: 0,
    aiTokensToday: 0,
    apiCallsToday: 0,
  });
  
  await sql.unsafe(
    `UPDATE workspaces SET counters = '${counters.replace(/'/g, "''")}'::jsonb, updated_at = NOW() WHERE id = '${w.id}'`
  );
  console.log(`Updated: ${w.name} | projects=${w.project_count} | collections=${w.collection_count} | analysis=${w.analysis_count} | members=${w.member_count}`);
}

console.log("\nVerifying fixes...\n");

const verify = await sql`
  SELECT w.id, w.name, w.counters,
    (SELECT COUNT(*)::int FROM workspace_projects WHERE workspace_id = w.id AND deleted_at IS NULL) AS actual_projects,
    (SELECT COUNT(*)::int FROM workspace_members WHERE workspace_id = w.id AND deleted_at IS NULL) AS actual_members
  FROM workspaces w
`;

for (const v of verify) {
  const c = v.counters || {};
  const wsProjects = Number(c.projects || 0);
  const wsMembers = Number(c.members || 0);
  const matchProjects = wsProjects === v.actual_projects ? "✅" : "❌";
  const matchMembers = wsMembers === v.actual_members ? "✅" : "❌";
  console.log(`${v.name}: counters.projects=${wsProjects} actual=${v.actual_projects} ${matchProjects} | counters.members=${wsMembers} actual=${v.actual_members} ${matchMembers}`);
}

await sql.end();
console.log("\nDone!");
