import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function checkTables() {
  console.log("Checking tables...\n");
  
  const [projects] = await db`SELECT COUNT(*)::int as cnt FROM workspace_projects WHERE deleted_at IS NULL`;
  console.log(`workspace_projects: ${projects.cnt}`);
  
  const [docs] = await db`SELECT COUNT(*) as cnt FROM project_documents WHERE deleted_at IS NULL`;
  console.log(`project_documents: ${docs.cnt}`);
  
  const [slides] = await db`SELECT COUNT(*) as cnt FROM project_slides WHERE deleted_at IS NULL`;
  console.log(`project_slides: ${slides.cnt}`);
  
  const [notes] = await db`SELECT COUNT(*) as cnt FROM project_notes WHERE deleted_at IS NULL`;
  console.log(`project_notes: ${notes.cnt}`);
  
  const [tasks] = await db`SELECT COUNT(*) as cnt FROM project_tasks WHERE deleted_at IS NULL`;
  console.log(`project_tasks: ${tasks.cnt}`);
  
  const [diagrams] = await db`SELECT COUNT(*) as cnt FROM project_diagrams WHERE deleted_at IS NULL`;
  console.log(`project_diagrams: ${diagrams.cnt}`);
  
  console.log("\nGetting latest project...");
  const [project] = await db`
    SELECT id, title FROM workspace_projects 
    WHERE owner_uid = '15058b61-c181-40dd-b631-a44535116389' 
    AND deleted_at IS NULL 
    ORDER BY created_at DESC 
    LIMIT 1
  `;
  
  if (project) {
    console.log(`\nProject ID: ${project.id}`);
    console.log(`Project Title: ${project.title}`);
  } else {
    console.log("\nNo projects found for master user");
  }

  await closeDb();
}

checkTables().catch(console.error);