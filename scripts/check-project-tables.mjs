import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL_DEV || process.env.DATABASE_URL);

async function checkTables() {
  const tables = [
    'project_documents',
    'project_slides',
    'project_diagrams',
    'project_tasks',
    'project_notes'
  ];

  for (const table of tables) {
    console.log(`\n=== Checking ${table} ===`);
    try {
      const result = await sql`
        SELECT COUNT(*) as count FROM ${sql(table)}
      `;
      console.log(`  Row count: ${result[0]?.count || 0}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  await sql.end();
}

checkTables().catch(console.error);
