import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function checkData() {
  console.log("Checking workspaces and users...\n");
  
  const workspaces = await db`
    SELECT w.id, w.name, w.owner_uid, u.email 
    FROM workspaces w 
    LEFT JOIN auth.users u ON u.id::text = w.owner_uid 
    WHERE w.deleted_at IS NULL 
    LIMIT 5
  `;
  
  console.log("Workspaces:");
  for (const w of workspaces) {
    console.log(`  - ${w.name} (${w.id}) owner: ${w.email || w.owner_uid}`);
  }

  console.log("\nChecking for test data project...");
  
  const [project] = await db`
    SELECT id, title, workspace_id 
    FROM workspace_projects 
    WHERE deleted_at IS NULL 
    ORDER BY created_at DESC 
    LIMIT 1
  `;
  
  if (project) {
    console.log(`\nLatest project: ${project.title} (${project.id})`);
    console.log(`Workspace: ${project.workspace_id}`);
  } else {
    console.log("\nNo projects found");
  }

  await closeDb();
}

checkData().catch(console.error);