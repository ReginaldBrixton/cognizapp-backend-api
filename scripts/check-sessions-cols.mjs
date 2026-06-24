import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_DEV);
const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'cognizap' AND table_name = 'sessions' ORDER BY ordinal_position`;
for (const c of cols) { console.log(c.column_name); }
await sql.end();
