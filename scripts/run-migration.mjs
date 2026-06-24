import postgres from "postgres";
import { readFileSync } from "fs";
import "dotenv/config";

const targetEnv = process.env.DATABASE_URL_TARGET || "DATABASE_URL_DEV";
const databaseUrl = process.env[targetEnv];
if (!databaseUrl) {
  console.error(`${targetEnv} not set`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

const migrationFile = process.argv[2];
if (!migrationFile) {
  console.error("Usage: bun run scripts/run-migration.mjs <filename>");
  process.exit(1);
}

console.log("Running migration:", migrationFile);
console.log("Database URL env:", targetEnv);

const migration = readFileSync(migrationFile, "utf8");
const statements = migration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

for (const statement of statements) {
  await sql.unsafe(statement);
}

console.log("Migration completed!");

await sql.end();
