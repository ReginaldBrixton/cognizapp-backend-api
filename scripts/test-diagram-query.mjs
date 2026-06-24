import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL_DEV || process.env.DATABASE_URL);

async function testDiagramQuery() {
  const projectId = '3e92e5a0-35d9-4de6-996c-8149d26cc1ca';
  
  console.log(`Testing query for project: ${projectId}`);
  
  const result = await sql`
    SELECT * FROM project_diagrams
    WHERE project_id = ${projectId}
    AND deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  
  console.log('Result:', JSON.stringify(result, null, 2));
  
  await sql.end();
}

testDiagramQuery().catch(console.error);
