import { config as loadDotenv } from "dotenv";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { closeDb, getDb } from "../src/lib/db";

loadDotenv();

const db = getDb();

type SyntheticUser = {
  id: string;
  email: string;
  provider_uid: string | null;
};

function isSyntheticEmail(email: string) {
  return email.trim().toLowerCase().endsWith("@example.com");
}

async function runSection(title: string, fn: () => Promise<void>) {
  console.log(`\n${"-".repeat(72)}`);
  console.log(`> ${title}`);
  console.log("-".repeat(72));
  await fn();
  console.log("ok");
}

async function deleteDatabaseTestUsers() {
  const users = await db<SyntheticUser[]>`
    SELECT id::text, email, provider_uid::text
    FROM auth.users
    WHERE email LIKE ${"%@example.com"}
    ORDER BY created_at
  `;

  console.log(`  synthetic db users found: ${users.length}`);
  for (const user of users) {
    console.log(`    ${user.email}`);
  }

  if (users.length === 0) {
    return;
  }

  const ids = users.map((user) => user.id);

  await db`DELETE FROM workspaces WHERE owner_uid = ANY(${ids}::text[])`;
  await db`DELETE FROM user_settings WHERE user_id = ANY(${ids}::text[])`;
  await db`DELETE FROM user_onboarding WHERE user_id = ANY(${ids}::text[])`.catch(() => null);
  await db`DELETE FROM auth.users WHERE id = ANY(${ids}::uuid[])`;

  console.log(`  deleted db users: ${users.length}`);
}

async function purgeInvalidWorkspaces() {
  const candidates = await db<{
    id: string;
    name: string;
    owner_uid: string;
    active_members: number;
    deleted_at: string | null;
    owner_exists: boolean;
  }[]>`
    SELECT
      w.id::text,
      w.name,
      w.owner_uid::text,
      (
        SELECT COUNT(*)::int
        FROM workspace_members wm
        WHERE wm.workspace_id = w.id
          AND wm.deleted_at IS NULL
      ) AS active_members,
      w.deleted_at::text,
      EXISTS (
        SELECT 1
        FROM auth.users u
        WHERE u.id::text = w.owner_uid::text
      ) AS owner_exists
    FROM workspaces w
    WHERE w.deleted_at IS NOT NULL
       OR NOT EXISTS (
            SELECT 1
            FROM auth.users u
            WHERE u.id::text = w.owner_uid::text
          )
       OR NOT EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.workspace_id = w.id
              AND wm.deleted_at IS NULL
          )
  `;

  console.log(`  invalid workspaces found: ${candidates.length}`);
  for (const workspace of candidates) {
    console.log(
      `    ${workspace.name} | owner=${workspace.owner_uid} | owner_exists=${workspace.owner_exists} | members=${workspace.active_members} | deleted=${workspace.deleted_at ?? "no"}`,
    );
  }

  if (candidates.length === 0) {
    return;
  }

  const workspaceIds = candidates.map((workspace) => workspace.id);
  await db`DELETE FROM workspaces WHERE id = ANY(${workspaceIds}::uuid[])`;
  console.log(`  deleted workspaces: ${workspaceIds.length}`);
}

async function purgeStaleSessions() {
  const stale = await db<{ cnt: number }[]>`
    SELECT COUNT(*)::int AS cnt
    FROM auth.sessions
    WHERE is_revoked = TRUE
       OR expires_at < NOW()
  `;

  await db`
    DELETE FROM auth.sessions
    WHERE is_revoked = TRUE
       OR expires_at < NOW()
  `;

  console.log(`  stale sessions removed: ${stale[0]?.cnt ?? 0}`);
}

async function runNewMigrations() {
  const migrationsDir = join(process.cwd(), "src", "sql", "migrations");
  for (const file of ["005_onboarding.sql", "006_roles_permissions.sql", "007_research_platform.sql"]) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await db.unsafe(sql);
    console.log(`  applied ${file}`);
  }
}

async function promoteUsersAndSyncPermissions() {
  const promotions = [
    { email: "reginaldbrixton@gmail.com", role: "master", label: "primary owner" },
    { email: "emmanuelreginaldquansah@gmail.com", role: "admin", label: "co-admin" },
  ] as const;

  for (const promotion of promotions) {
    const updated = await db`
      UPDATE auth.users u
      SET role = ${promotion.role},
          permissions = COALESCE((
            SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
            FROM role_permissions rp
            WHERE rp.role = ${promotion.role}
          ), '[]'::jsonb),
          role_assigned_at = NOW(),
          role_assigned_by = 'db_cleanup_script',
          updated_at = NOW()
      WHERE u.email = ${promotion.email}
      RETURNING u.id, u.email, u.role
    `;

    if (updated.length === 0) {
      console.log(`  skipped ${promotion.email} (${promotion.label})`);
      continue;
    }

    const userId = String(updated[0].id);
    await db`
      UPDATE auth.sessions
      SET role = ${promotion.role}
      WHERE user_id = ${userId}::uuid
        AND is_revoked = FALSE
    `;

    console.log(`  promoted ${promotion.email} -> ${promotion.role}`);
  }

  await db`
    UPDATE auth.users u
    SET permissions = COALESCE((
      SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
      FROM role_permissions rp
      WHERE rp.role = u.role
    ), '[]'::jsonb)
  `;
  console.log("  user permission cache synced");
}

async function reportStats() {
  const [users] = await db<{ cnt: number }[]>`SELECT COUNT(*)::int AS cnt FROM auth.users`;
  const [workspaces] = await db<{ cnt: number }[]>`SELECT COUNT(*)::int AS cnt FROM workspaces WHERE deleted_at IS NULL`;
  const [sessions] = await db<{ cnt: number }[]>`
    SELECT COUNT(*)::int AS cnt
    FROM auth.sessions
    WHERE is_revoked = FALSE
      AND expires_at > NOW()
  `;
  const [onboarding] = await db<{ cnt: number }[]>`SELECT COUNT(*)::int AS cnt FROM user_onboarding`;
  const [permissions] = await db<{ cnt: number }[]>`SELECT COUNT(*)::int AS cnt FROM permissions`;
  const [rolePermissions] = await db<{ cnt: number }[]>`SELECT COUNT(*)::int AS cnt FROM role_permissions`;
  const roles = await db<{ role: string; cnt: number }[]>`
    SELECT role, COUNT(*)::int AS cnt
    FROM auth.users
    GROUP BY role
    ORDER BY cnt DESC, role ASC
  `;

  console.log(`  users: ${users?.cnt ?? 0}`);
  console.log(`  workspaces: ${workspaces?.cnt ?? 0}`);
  console.log(`  active sessions: ${sessions?.cnt ?? 0}`);
  console.log(`  onboarding rows: ${onboarding?.cnt ?? 0}`);
  console.log(`  permissions: ${permissions?.cnt ?? 0}`);
  console.log(`  role permission mappings: ${rolePermissions?.cnt ?? 0}`);
  console.log("  users by role:");
  for (const row of roles) {
    console.log(`    ${row.role}: ${row.cnt}`);
  }
}

async function main() {
  console.log("cognizap database cleanup");

  await runSection("delete synthetic database users", deleteDatabaseTestUsers);
  await runSection("purge soft-deleted, orphaned, and empty workspaces", purgeInvalidWorkspaces);
  await runSection("purge stale sessions", purgeStaleSessions);
  await runSection("run migrations 005-007", runNewMigrations);
  await runSection("promote admins and sync permissions", promoteUsersAndSyncPermissions);
  await runSection("report post-cleanup statistics", reportStats);

  await closeDb();
}

main().catch(async (error) => {
  console.error("cleanup failed:", error);
  await closeDb().catch(() => null);
  process.exit(1);
});
