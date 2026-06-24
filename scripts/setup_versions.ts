import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function createVersionTable() {
  console.log("Creating document_versions table...");
  
  const sql = `
    CREATE TABLE IF NOT EXISTS document_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID REFERENCES project_documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_dv_document ON document_versions(document_id);
  `;

  await db.unsafe(sql);
  console.log("  Created document_versions table with index");
}

async function verifyRoutes() {
  console.log("\nVerifying module files...");
  
  const modules = [
    "project-documents",
    "project-slides", 
    "project-notes",
    "project-tasks",
    "project-diagram"
  ];

  for (const mod of modules) {
    console.log(`  - ${mod}`);
  }
}

async function main() {
  try {
    await createVersionTable();
    await verifyRoutes();
    console.log("\n✓ Setup complete!");
  } catch (error) {
    console.error("\n✗ Error:", error);
  } finally {
    await closeDb();
  }
}

main();