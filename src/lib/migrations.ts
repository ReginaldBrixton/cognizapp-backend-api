import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

import { env } from "../config/env";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_MIGRATION_ATTEMPTS = 3;

function assertCognizapDatabase(databaseUrl: string) {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (databaseName !== "cognizap") {
    throw new Error(
      `Migration database URL must point to the cognizap database, not ${databaseName || "an empty database name"}`,
    );
  }
}

function directNeonUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.)/, "");
  return parsed.toString();
}

function migrationDatabaseUrl() {
  const configuredUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ?? process.env.DATABASE_URL_DIRECT?.trim();
  const databaseUrl = configuredUrl || directNeonUrl(env.databaseUrl);
  assertCognizapDatabase(databaseUrl);
  return databaseUrl;
}

function createMigrationDb() {
  return postgres(migrationDatabaseUrl(), {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 30,
    prepare: false,
    onnotice: (notice) => {
      if (!["42P06", "42P07", "42710"].includes(notice.code ?? "")) {
        console.warn("[pg notice]", notice.message);
      }
    },
    transform: {
      undefined: null,
    },
  });
}

function isConnectionClosedError(error: unknown) {
  const candidate = error as { code?: string; errno?: string; message?: string };
  return (
    candidate.code === "CONNECTION_CLOSED" ||
    candidate.errno === "CONNECTION_CLOSED" ||
    candidate.message?.includes("CONNECTION_CLOSED")
  );
}

function isConcurrentMigrationConflict(error: unknown) {
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "XX000" &&
    /tuple concurrently updated/i.test(candidate.message ?? "")
  );
}

function statementsForMigration(sql: string) {
  if (!/CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql)) {
    return [sql];
  }

  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function runMigrations() {
  const migrationsDir = join(__dirname, "..", "sql", "migrations");
  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b));

  let db: Sql | null = createMigrationDb();

  try {
    for (const file of migrationFiles) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      for (let attempt = 1; attempt <= MAX_MIGRATION_ATTEMPTS; attempt += 1) {
        try {
          console.log(`  Executing migration ${file}...`);
          for (const statement of statementsForMigration(sql)) {
            await db.unsafe(statement);
          }
          console.log(`  Successfully executed migration ${file}`);
          break;
        } catch (e: any) {
          if (e.code === "23505" || e.message?.includes("already exists")) {
            console.log(`  Migration ${file} already applied, skipping`);
            break;
          }

          if (
            (isConnectionClosedError(e) || isConcurrentMigrationConflict(e)) &&
            attempt < MAX_MIGRATION_ATTEMPTS
          ) {
            console.warn(
              `  Migration ${file} hit a transient database conflict; reconnecting and retrying (${attempt}/${MAX_MIGRATION_ATTEMPTS})`,
            );
            await db.end().catch(() => undefined);
            db = createMigrationDb();
            continue;
          }

          throw e;
        }
      }
    }
  } finally {
    await db.end().catch(() => undefined);
  }
}
