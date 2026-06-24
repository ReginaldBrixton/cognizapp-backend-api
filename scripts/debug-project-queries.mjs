import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL_DEV || process.env.DATABASE_URL);

async function testQueries() {
  const projectId = '3e92e5a0-35d9-4de6-996c-8149d26cc1ca';
  const userId = '08e46ef8-bb00-43db-b4cb-54b7b58fc526';
  
  console.log('Testing queries for project:', projectId, 'user:', userId);
  
  // Test 1: Get workspace
  const workspace = await sql`
    SELECT w.* FROM workspaces w
    JOIN workspace_projects wp ON wp.workspace_id = w.id
    WHERE wp.id = ${projectId}
  `;
  console.log('\n1. Workspace:', workspace[0]?.id, 'owner:', workspace[0]?.owner_uid);
  
  // Test 2: Check membership
  const member = await sql`
    SELECT * FROM workspace_members 
    WHERE workspace_id = ${workspace[0]?.id} AND user_uid = ${userId}
    AND deleted_at IS NULL
  `;
  console.log('2. Member:', member.length > 0 ? 'found' : 'not found');
  
  // Test 3: Get project
  const project = await sql`
    SELECT * FROM workspace_projects WHERE id = ${projectId}
  `;
  console.log('3. Project:', project[0]?.id, 'workspace_id:', project[0]?.workspace_id);
  
  // Test 4: Query documents
  console.log('\n4. Querying documents...');
  try {
    const docs = await sql`
      SELECT * FROM project_documents
      WHERE project_id = ${projectId}
      AND deleted_at IS NULL
    `;
    console.log('   Documents found:', docs.length);
  } catch (err) {
    console.log('   ERROR:', err.message);
  }
  
  // Test 5: Query diagrams
  console.log('\n5. Querying diagrams...');
  try {
    const diags = await sql`
      SELECT * FROM project_diagrams
      WHERE project_id = ${projectId}
      AND deleted_at IS NULL
    `;
    console.log('   Diagrams found:', diags.length);
  } catch (err) {
    console.log('   ERROR:', err.message);
  }
  
  // Test 6: Query slides
  console.log('\n6. Querying slides...');
  try {
    const slides = await sql`
      SELECT * FROM project_slides
      WHERE project_id = ${projectId}
      AND deleted_at IS NULL
    `;
    console.log('   Slides found:', slides.length);
  } catch (err) {
    console.log('   ERROR:', err.message);
  }
  
  await sql.end();
}

testQueries().catch(console.error);
