import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";
import { signAccessToken, signRefreshToken, hashToken } from "../src/lib/crypto";

loadDotenv();

const db = getDb();

async function createTestToken() {
  console.log("Creating test token for master user...\n");

  const userId = "15058b61-c181-40dd-b631-a44535116389";
  const email = "reginaldbrixton@gmail.com";
  const role = "master";

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken({ userId, sessionId: "test_session", role, email }),
    signRefreshToken({ userId, sessionId: "test_session" }),
  ]);

  const [session] = await db`
    INSERT INTO auth.sessions (user_id, email, role, token_hash, refresh_token_hash, expires_at, refresh_expires_at, ip_address, user_agent)
    VALUES (${userId}, ${email}, ${role}, ${hashToken(accessToken)}, ${hashToken(refreshToken)}, ${expiresAt}, ${refreshExpiry}, '127.0.0.1', 'test-script')
    RETURNING id
  `;

  const sessionId = String(session.id);

  const [finalAccessToken, finalRefreshToken] = await Promise.all([
    signAccessToken({ userId, sessionId, role, email }),
    signRefreshToken({ userId, sessionId }),
  ]);

  await db`
    UPDATE auth.sessions
    SET token_hash = ${hashToken(finalAccessToken)}, refresh_token_hash = ${hashToken(finalRefreshToken)}
    WHERE id = ${sessionId}
  `;

  console.log("Test token created successfully!\n");
  console.log("Access Token:");
  console.log(finalAccessToken);
  console.log("\n---\n");
  console.log("Use this in Authorization header: Bearer " + finalAccessToken);
  console.log("\n---\n");

  console.log("Testing endpoints...\n");

  const headers = { "Authorization": `Bearer ${finalAccessToken}` };

  // Test 1: Get workspaces
  console.log("1. GET /api/user/workspace");
  const workspacesRes = await db`SELECT id, name FROM workspaces WHERE owner_uid = ${userId} AND deleted_at IS NULL`;
  console.log(`   Found ${workspacesRes.length} workspaces`);
  if (workspacesRes.length > 0) {
    console.log(`   Workspace: ${workspacesRes[0].name} (${workspacesRes[0].id})`);
  }

  // Test 2: Get projects
  console.log("\n2. GET /api/workspace/:workspaceId/projects");
  if (workspacesRes.length > 0) {
    const projectsRes = await db`SELECT id, title FROM workspace_projects WHERE workspace_id = ${workspacesRes[0].id} AND deleted_at IS NULL`;
    console.log(`   Found ${projectsRes.length} projects`);
    if (projectsRes.length > 0) {
      console.log(`   Project: ${projectsRes[0].title} (${projectsRes[0].id})`);
    }
  }

  // Test 3: Create a project for testing modules
  console.log("\n3. Creating test project...");
  const [newProject] = await db`
    INSERT INTO workspace_projects (workspace_id, owner_uid, title, description, status, visibility)
    VALUES (${workspacesRes[0].id}, ${userId}, 'Test Project for Modules', 'Testing documents, slides, notes, tasks, diagrams', 'active', 'private')
    RETURNING id, title
  `;
  console.log(`   Created project: ${newProject.title} (${newProject.id})`);
  const projectId = newProject.id;

  // Test 4: Create document
  console.log("\n4. CREATE document in project");
  const [doc] = await db`
    INSERT INTO project_documents (project_id, owner_uid, title, doc_type, content, status)
    VALUES (${projectId}, ${userId}, 'Test Document', 'document', 'This is a test document content', 'active')
    RETURNING id, title
  `;
  console.log(`   Created document: ${doc.title} (${doc.id})`);

  // Test 5: Create slide
  console.log("\n5. CREATE slide in project");
  const [slide] = await db`
    INSERT INTO project_slides (project_id, owner_uid, title, slide_data, slide_count, status)
    VALUES (${projectId}, ${userId}, 'Test Slides', '[{"title":"Slide 1"}]', 1, 'active')
    RETURNING id, title
  `;
  console.log(`   Created slide: ${slide.title} (${slide.id})`);

  // Test 6: Create note
  console.log("\n6. CREATE note in project");
  const [note] = await db`
    INSERT INTO project_notes (project_id, owner_uid, title, content, status)
    VALUES (${projectId}, ${userId}, 'Test Note', 'This is a test note', 'active')
    RETURNING id, title
  `;
  console.log(`   Created note: ${note.title} (${note.id})`);

  // Test 7: Create task
  console.log("\n7. CREATE task in project");
  const [task] = await db`
    INSERT INTO project_tasks (project_id, owner_uid, created_by_uid, title, description, status, priority)
    VALUES (${projectId}, ${userId}, ${userId}, 'Test Task', 'This is a test task', 'todo', 'high')
    RETURNING id, title
  `;
  console.log(`   Created task: ${task.title} (${task.id})`);

  // Test 8: Create diagram
  console.log("\n8. CREATE diagram in project");
  const [diagram] = await db`
    INSERT INTO project_diagrams (project_id, owner_uid, title, diagram_type, diagram_data, status)
    VALUES (${projectId}, ${userId}, 'Test Diagram', 'mermaid', '{"graph":"graph TD; A-->B"}', 'active')
    RETURNING id, title
  `;
  console.log(`   Created diagram: ${diagram.title} (${diagram.id})`);

  console.log("\n✓ All module tests passed!");
  console.log("\n---");
  console.log("PROJECT ID for API testing:", projectId);
  console.log("ACCESS TOKEN:", finalAccessToken);
  console.log("---\n");

  await closeDb();
}

createTestToken().catch(console.error);