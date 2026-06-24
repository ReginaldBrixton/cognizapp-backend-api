import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

async function findUser() {
  console.log("Finding master user in database...\n");
  
  const users = await db`
    SELECT id, email, role, display_name 
    FROM auth.users 
    WHERE email = 'reginaldbrixton@gmail.com'
    OR email LIKE '%reginald%'
  `;
  
  console.log("Found users:");
  for (const u of users) {
    console.log(`  ID: ${u.id}`);
    console.log(`  Email: ${u.email}`);
    console.log(`  Role: ${u.role}`);
    console.log(`  Name: ${u.display_name}`);
    console.log("---");
  }

  await closeDb();
}

findUser().catch(console.error);