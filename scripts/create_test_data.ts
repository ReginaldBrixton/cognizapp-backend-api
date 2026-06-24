import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function createTestData() {
  console.log("Creating test data...\n");

  const userId = "15058b61-c181-40dd-b631-a44535116389";

  // Get a workspace for the user
  const [workspace] = await db`
    SELECT id FROM workspaces 
    WHERE owner_uid = ${userId} 
    AND deleted_at IS NULL 
    LIMIT 1
  `;

  if (!workspace) {
    console.log("No workspace found, creating one...");
    const [ws] = await db`
      INSERT INTO workspaces (owner_uid, name, slug, description, status, is_default, counters)
      VALUES (${userId}, 'Personal Workspace', 'personal-workspace', 'Default workspace', 'active', true, 
        '{"projects":0,"members":0,"collections":0,"tasks":0,"notes":0,"storageUsed":0}'::jsonb)
      RETURNING id
    `;
    console.log(`Created workspace: ${ws.id}`);
    var workspaceId = ws.id;
  } else {
    console.log(`Using workspace: ${workspace.id}`);
    var workspaceId = workspace.id;
  }

  // Create a project
  const [project] = await db`
    INSERT INTO workspace_projects (workspace_id, owner_uid, title, description, status, visibility)
    VALUES (${workspaceId}, ${userId}, 'Test Project - API Modules', 'Testing all 5 project module APIs', 'active', 'private')
    RETURNING id, title
  `;
  console.log(`Created project: ${project.title} (${project.id})`);

  const projectId = project.id;

  // Create sample data for each module
  console.log("\nCreating sample data for each module...\n");

  // Documents
  const [doc] = await db`
    INSERT INTO project_documents (project_id, owner_uid, title, doc_type, content, status)
    VALUES (${projectId}, ${userId}, 'Welcome Document', 'document', 'Welcome to your new project! This is a test document.', 'active')
    RETURNING id, title
  `;
  console.log(`  ✓ Document: ${doc.title} (${doc.id})`);

  // Slides
  const [slide] = await db`
    INSERT INTO project_slides (project_id, owner_uid, title, slide_data, slide_count, status)
    VALUES (${projectId}, ${userId}, 'Welcome Presentation', '[{"title":"Welcome","content":"Welcome to the project"}]', 1, 'active')
    RETURNING id, title
  `;
  console.log(`  ✓ Slide: ${slide.title} (${slide.id})`);

  // Notes
  const [note] = await db`
    INSERT INTO project_notes (project_id, owner_uid, title, content, status)
    VALUES (${projectId}, ${userId}, 'Quick Notes', 'These are some quick notes for the project.', 'active')
    RETURNING id, title
  `;
  console.log(`  ✓ Note: ${note.title} (${note.id})`);

  // Tasks
  const [task] = await db`
    INSERT INTO project_tasks (project_id, owner_uid, created_by_uid, title, description, status, priority)
    VALUES (${projectId}, ${userId}, ${userId}, 'Complete Project Setup', 'Set up all project modules', 'in_progress', 'high')
    RETURNING id, title
  `;
  console.log(`  ✓ Task: ${task.title} (${task.id})`);

  // Diagrams
  const [diagram] = await db`
    INSERT INTO project_diagrams (project_id, owner_uid, title, diagram_type, diagram_data, status)
    VALUES (${projectId}, ${userId}, 'Project Flowchart', 'mermaid', '{"graph":"graph TD;A[Start]-->B[Process]"}', 'active')
    RETURNING id, title
  `;
  console.log(`  ✓ Diagram: ${diagram.title} (${diagram.id})`);

  console.log("\n========================================");
  console.log("TEST DATA CREATED SUCCESSFULLY!");
  console.log("========================================");
  console.log(`\nWorkspace ID: ${workspaceId}`);
  console.log(`Project ID:   ${projectId}`);
  console.log("\n---");
  console.log("API ENDPOINTS (base path):");
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/documents`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/slides`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/notes`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/tasks`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/diagrams`);
  console.log("========================================\n");

  await closeDb();
}

createTestData().catch(console.error);