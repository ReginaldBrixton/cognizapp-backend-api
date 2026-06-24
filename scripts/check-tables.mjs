import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL_DEV);

const tables = await sql`
  SELECT table_name
  FROM information_schema.columns 
  WHERE table_schema = 'public' AND column_name = 'updated_at'
  ORDER BY table_name
`;

console.log("Tables with updated_at column:");
for (const { table_name } of tables) {
  console.log(" - " + table_name);
}

await sql.end();
