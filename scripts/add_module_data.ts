import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function addModuleData() {
  console.log("Adding module test data...\n");

  const userId = "15058b61-c181-40dd-b631-a44535116389";
  const workspaceId = "74e640c5-7d5e-4d1e-9620-7279a2be5fe8";
  const projectId = "7dcc6f18-4953-460c-8d89-9e42f0f828ca";

  // Documents
  const [doc] = await db`
    INSERT INTO project_documents (project_id, owner_uid, title, doc_type, content, status)
    VALUES (${projectId}, ${userId}, 'Welcome Document', 'document', 'Welcome to your project! This is a test document.', 'active')
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
    VALUES (${projectId}, ${userId}, 'Quick Notes', 'These are quick notes for the project.', 'active')
    RETURNING id, title
  `;
  console.log(`  ✓ Note: ${note.title} (${note.id})`);

  // Tasks
  const [task] = await db`
    INSERT INTO project_tasks (project_id, owner_uid, created_by_uid, title, description, status, priority)
    VALUES (${projectId}, ${userId}, ${userId}, 'Complete Setup', 'Set up all project modules', 'in_progress', 'high')
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
  console.log("MODULE DATA CREATED!");
  console.log("========================================");
  console.log(`\nWorkspace ID: ${workspaceId}`);
  console.log(`Project ID:   ${projectId}`);
  console.log("\n---");
  console.log("API ENDPOINTS:");
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/documents`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/slides`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/notes`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/tasks`);
  console.log(`  /api/workspace/${workspaceId}/projects/${projectId}/diagrams`);
  console.log("========================================\n");

  await closeDb();
}

addModuleData().catch(console.error);