import { readFileSync } from "node:fs";
import postgres from "postgres";

const envFile = new URL("../.env", import.meta.url);
const envText = readFileSync(envFile, "utf8");

function readEnv(name) {
  return envText
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}

function resolveUrl() {
  const value = process.env.VERIFY_DATABASE_URL ?? readEnv("DATABASE_URL_PROD") ?? readEnv("DATABASE_URL");
  if (!value) {
    throw new Error("Set DATABASE_URL or define DATABASE_URL_PROD in users/.env");
  }
  return value;
}

const sql = postgres(resolveUrl(), { max: 1 });

const tables = [
  ["auth", "users"],
  ["auth", "sessions"],
  ["auth", "activity_log"],
  ["auth", "notifications"],
  ["app", "workspaces"],
  ["app", "workspace_members"],
  ["app", "workspace_settings"],
  ["app", "workspace_activity"],
  ["app", "support_requests"],
];

try {
  const roles = await sql`
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anonymous', 'authenticated', 'authenticator')
    ORDER BY rolname
  `;
  const roleNames = new Set(roles.map((role) => role.rolname));
  const [route] = await sql`
    SELECT current_database(), current_user, current_setting('search_path') AS search_path
  `;
  const schemaNames = await sql`
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname IN ('auth', 'app', 'pgrst')
    ORDER BY nspname
  `;
  const schemas = [];
  for (const schema of schemaNames) {
    schemas.push({
      schema_name: schema.schema_name,
      anonymous_usage: roleNames.has("anonymous")
        ? (await sql`SELECT has_schema_privilege('anonymous', ${schema.schema_name}, 'USAGE') AS value`)[0].value
        : null,
      authenticated_usage: roleNames.has("authenticated")
        ? (await sql`SELECT has_schema_privilege('authenticated', ${schema.schema_name}, 'USAGE') AS value`)[0].value
        : null,
      authenticator_usage: roleNames.has("authenticator")
        ? (await sql`SELECT has_schema_privilege('authenticator', ${schema.schema_name}, 'USAGE') AS value`)[0].value
        : null,
    });
  }

  const counts = [];
  for (const [schema, table] of tables) {
    const [exists] = await sql`SELECT to_regclass(${`${schema}.${table}`}) AS table_regclass`;
    if (!exists.table_regclass) {
      counts.push({ schema, table, count: null });
      continue;
    }

    const [row] = await sql.unsafe(
      `SELECT count(*)::int AS count FROM "${schema.replaceAll('"', '""')}"."${table.replaceAll('"', '""')}"`,
    );
    counts.push({ schema, table, count: row.count });
  }

  console.log(JSON.stringify({ route, roles: [...roleNames], schemas, counts }, null, 2));
} finally {
  await sql.end();
}
