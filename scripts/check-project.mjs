import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL_DEV || process.env.DATABASE_URL);

async function checkProject(projectId) {
  console.log(`Checking project: ${projectId}`);
  
  const project = await sql`
    SELECT * FROM workspace_projects WHERE id = ${projectId}
  `;
  console.log('Project:', JSON.stringify(project[0], null, 2));
  
  if (project[0]) {
    console.log('\nChecking workspace:', project[0].workspace_id);
    const workspace = await sql`
      SELECT * FROM workspaces WHERE id = ${project[0].workspace_id}
    `;
    console.log('Workspace:', JSON.stringify(workspace[0], null, 2));
  }

  await sql.end();
}

const projectId = process.argv[2] || '3e92e5a0-35d9-4de6-996c-8149d26cc1ca';
checkProject(projectId).catch(console.error);
