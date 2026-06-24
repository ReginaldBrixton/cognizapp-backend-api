import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function checkUsers() {
  const users = await db`
    SELECT id, email, role FROM auth.users LIMIT 5
  `;
  
  console.log("Users in DB:");
  for (const u of users) {
    console.log(`  - ${u.email} (${u.role}): ${u.id}`);
  }

  await closeDb();
}

checkUsers().catch(console.error);