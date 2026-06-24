import { readFileSync } from "node:fs";
import postgres from "postgres";

const envText = readFileSync(".env", "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).trim()];
    }),
);

const sql = postgres(env.DATABASE_URL, { max: 1 });
const tables = [
  "app.support_requests",
  "app.support_payments",
  "app.support_events",
  "app.support_files",
  "app.support_clients",
  "app.workspace_projects",
  "app.workspace_collections",
  "app.collection_items",
  "app.workspace_settings",
  "app.workspace_analysis",
  "app.subscription_plans",
  "app.workspace_subscriptions",
  "app.workspace_usage_ledger",
  "app.paystack_transactions",
  "auth.users",
  "auth.sessions",
  "auth.activity_log",
];

try {
  const stats = [];
  for (const tableName of tables) {
    const [schema, table] = tableName.split(".");
    const existsRows = await sql.unsafe("SELECT to_regclass($1) AS r", [tableName]);
    if (!existsRows[0].r) {
      stats.push({ table: tableName, exists: false });
      continue;
    }

    const countRows = await sql.unsafe(`SELECT count(*)::int AS count FROM "${schema}"."${table}"`);
    stats.push({ table: tableName, exists: true, count: countRows[0].count });
  }

  console.log(JSON.stringify(stats, null, 2));
} finally {
  await sql.end();
}
