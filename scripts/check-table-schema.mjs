import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL_DEV || process.env.DATABASE_URL);

async function checkTable(tableName) {
  console.log(`\n=== ${tableName} ===`);
  
  const columns = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns 
    WHERE table_name = ${tableName} AND table_schema = 'public'
    ORDER BY ordinal_position
  `;
  
  console.log('Columns:');
  for (const col of columns) {
    console.log(`  ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? '(nullable)' : ''}`);
  }
  
  const data = await sql`SELECT * FROM ${sql(tableName)} LIMIT 2`;
  console.log('\nSample data:');
  for (const row of data) {
    console.log(JSON.stringify(row, null, 2));
  }
}

checkTable('project_diagrams').then(() => sql.end()).catch(console.error);
