import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL_DEV;
if (!databaseUrl) {
  console.error("DATABASE_URL_DEV not set");
  process.exit(1);
}

const sql = postgres(databaseUrl);

console.log("Checking workspace counters...\n");

const rows = await sql`
  SELECT w.id, w.name, w.counters,
    (SELECT COUNT(*)::int FROM workspace_members WHERE workspace_id = w.id AND deleted_at IS NULL) AS actual_members,
    (SELECT COUNT(*)::int FROM workspace_projects WHERE workspace_id = w.id AND deleted_at IS NULL) AS actual_projects
  FROM workspaces w
  WHERE w.deleted_at IS NULL
  ORDER BY w.name
`;

for (const r of rows) {
  console.log("Workspace:", r.name);
  console.log("  Raw counters:", JSON.stringify(r.counters, null, 2));
  console.log("  Actual members:", r.actual_members);
  console.log("  Actual projects:", r.actual_projects);
  console.log("");
}

await sql.end();
