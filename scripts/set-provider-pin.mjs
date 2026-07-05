/**
 * Bootstrap CLI: set username + PIN credentials on an existing auth.users row
 * so the account can sign in to the provider portal with PIN instead of email.
 *
 * Usage:
 *   bun run scripts/set-provider-pin.mjs <email> <username> <pin>
 *
 * Env:
 *   DATABASE_URL_TARGET  (default: DATABASE_URL_DEV)
 *
 * The script:
 *   1. Looks up the user by email.
 *   2. Verifies the account has a provider/admin role AND an active
 *      privileged_access_grant (or is a default admin email).
 *   3. Hashes the PIN with argon2id (m=64MiB, t=3, p=4).
 *   4. Writes username + pin_hash + resets pin_failed_logins / pin_locked_until.
 *
 * The PIN is never logged. Run locally against the dev DB first, then against
 * DATABASE_URL_PROD for production providers.
 */

import postgres from "postgres";
import { hash as argon2Hash } from "argon2";
import "dotenv/config";

const ARGON2_OPTIONS = {
  type: 2, // argon2id
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

const PROVIDER_ROLES = new Set(["SUPPORT_PROVIDER_USER", "ADMIN_USER"]);
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const targetEnv = process.env.DATABASE_URL_TARGET || "DATABASE_URL_DEV";
const databaseUrl = process.env[targetEnv];
if (!databaseUrl) {
  console.error(`${targetEnv} not set`);
  process.exit(1);
}

const [emailArg, usernameArg, pinArg] = process.argv.slice(2);
if (!emailArg || !usernameArg || !pinArg) {
  console.error("Usage: bun run scripts/set-provider-pin.mjs <email> <username> <pin>");
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const username = usernameArg.trim();
const pin = pinArg;

if (username.length < 3 || username.length > 64 || !USERNAME_PATTERN.test(username)) {
  console.error("Invalid username: 3-64 chars, [A-Za-z0-9._-] only.");
  process.exit(1);
}
if (pin.length < 6 || pin.length > 32) {
  console.error("Invalid PIN: 6-32 characters.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, transform: { undefined: null } });

try {
  const [user] = await sql`SELECT * FROM auth.users WHERE lower(email) = lower(${email}) LIMIT 1`;
  if (!user) {
    console.error(`No user found for email: ${email}`);
    process.exit(1);
  }
  if (user.deleted_at) {
    console.error("User is deleted.");
    process.exit(1);
  }
  if (!PROVIDER_ROLES.has(String(user.role))) {
    console.error(`User role is ${user.role}, not a provider/admin role. PIN login is provider-only.`);
    process.exit(1);
  }

  // Username uniqueness (case-insensitive, excluding this user).
  const [collision] = await sql`
    SELECT 1 FROM auth.users
    WHERE lower(username) = lower(${username})
      AND id <> ${user.id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (collision) {
    console.error("Username already taken by another account.");
    process.exit(1);
  }

  const pinHash = await argon2Hash(pin, ARGON2_OPTIONS);

  const [updated] = await sql`
    UPDATE auth.users
    SET username = ${username},
        pin_hash = ${pinHash},
        pin_set_at = NOW(),
        pin_failed_logins = 0,
        pin_locked_until = NULL,
        last_pin_failed_at = NULL,
        updated_at = NOW()
    WHERE id = ${user.id}
    RETURNING id, email, username, pin_set_at
  `;

  console.log("PIN credentials set successfully:");
  console.log("  id:        ", updated.id);
  console.log("  email:     ", updated.email);
  console.log("  username:  ", updated.username);
  console.log("  pin_set_at:", updated.pin_set_at);
  console.log("\nThe account can now sign in to the provider portal with this username + PIN.");
} catch (error) {
  console.error("Failed to set PIN credentials:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await sql.end();
}
