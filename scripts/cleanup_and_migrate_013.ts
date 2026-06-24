import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function cleanupLegacyTables() {
  console.log("Cleaning up legacy tables from migration 007...\n");

  // Drop legacy tables
  const tables = ["documents", "research_projects", "tasks"];
  for (const table of tables) {
    try {
      await db`DROP TABLE IF EXISTS ${db(table)} CASCADE`;
      console.log(`  Dropped table: ${table}`);
    } catch (e) {
      console.log(`  Table ${table} not found or already dropped`);
    }
  }

  // Drop legacy views
  const views = ["workspace_projects", "project_documents", "project_tasks"];
  for (const view of views) {
    try {
      await db`DROP VIEW IF EXISTS ${db(view)}`;
      console.log(`  Dropped view: ${view}`);
    } catch (e) {
      console.log(`  View ${view} not found or already dropped`);
    }
  }
}

async function applyMigration013() {
  console.log("\nApplying migration 013 - project_diagram...\n");

  const sql = `
    CREATE TABLE IF NOT EXISTS project_diagrams (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id      UUID        REFERENCES workspace_projects(id) ON DELETE CASCADE,
      owner_uid       TEXT        NOT NULL,
      title           TEXT        NOT NULL DEFAULT 'Untitled',
      diagram_type    TEXT        NOT NULL DEFAULT 'mermaid',
      diagram_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
      version         INTEGER     NOT NULL DEFAULT 1,
      collaborators   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
      is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
      share_token     TEXT,
      share_expires_at TIMESTAMPTZ,
      status          TEXT        NOT NULL DEFAULT 'active',
      metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_pdiag_project ON project_diagrams(project_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pdiag_owner   ON project_diagrams(owner_uid);
  `;

  await db.unsafe(sql);
  console.log("  Created project_diagrams table with indexes");
}

async function verifyTables() {
  console.log("\nVerifying tables...\n");

  const tables = await db`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    AND table_name IN ('workspace_projects', 'project_documents', 'project_slides', 'project_notes', 'project_tasks', 'project_diagrams')
    ORDER BY table_name
  `;

  console.log("  Current project tables:");
  for (const t of tables) {
    console.log(`    - ${t.table_name}`);
  }
}

async function main() {
  try {
    await cleanupLegacyTables();
    await applyMigration013();
    await verifyTables();
    console.log("\n✓ Cleanup and migration complete!\n");
  } catch (error) {
    console.error("\n✗ Error:", error);
  } finally {
    await closeDb();
  }
}

main();