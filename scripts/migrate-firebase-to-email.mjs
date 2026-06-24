import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const envFile = new URL("../.env", import.meta.url);

function readEnvFile() {
  try {
    return readFileSync(envFile, "utf8");
  } catch {
    return "";
  }
}

const envText = readEnvFile();

function readEnv(name) {
  return envText
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}

function resolveUrl() {
  const value =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    readEnv("DATABASE_URL") ??
    readEnv("DATABASE_URL_DEV");
  if (!value) {
    throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL, or define DATABASE_URL in users/.env");
  }
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (databaseName !== "cognizap") {
    throw new Error(`Refusing to migrate database '${databaseName}'. Target database must be 'cognizap'.`);
  }
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const apply = hasFlag("--apply");
const yes = hasFlag("--yes");
const sql = postgres(resolveUrl(), { max: 1, prepare: false });

async function tableStats() {
  const [users] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE provider = 'firebase')::int AS firebase_users,
      count(*) FILTER (WHERE provider = 'email')::int AS email_users,
      count(*) FILTER (WHERE provider_uid IS NOT NULL)::int AS users_with_provider_uid,
      count(*) FILTER (WHERE avatar_url ILIKE '%googleusercontent.com%')::int AS google_avatar_users
    FROM auth.users
  `;

  const [authCodesExists] = await sql`SELECT to_regclass('auth.auth_codes') AS table_name`;
  const authCodes = authCodesExists.table_name
    ? (await sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE verified = FALSE AND expires_at > NOW())::int AS active_unverified,
          count(*) FILTER (WHERE verified = TRUE)::int AS verified
        FROM auth.auth_codes
      `)[0]
    : { total: null, active_unverified: null, verified: null };

  return {
    users: {
      total: users.total,
      firebaseUsers: users.firebase_users,
      emailUsers: users.email_users,
      usersWithProviderUid: users.users_with_provider_uid,
      googleAvatarUsers: users.google_avatar_users,
    },
    authCodes: {
      total: authCodes.total,
      activeUnverified: authCodes.active_unverified,
      verified: authCodes.verified,
    },
  };
}

async function previewRows() {
  return sql`
    SELECT id, email, provider, provider_uid, email_verified
    FROM auth.users
    WHERE provider = 'firebase'
    ORDER BY created_at
    LIMIT 20
  `;
}

async function confirmApply(count) {
  if (yes) {
    return true;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `This will convert ${count} Firebase account(s) to email auth in cognizap.auth.users. Type MIGRATE to continue: `,
    );
    return answer.trim() === "MIGRATE";
  } finally {
    rl.close();
  }
}

try {
  const before = await tableStats();
  const rows = await previewRows();

  console.log("Firebase to email auth migration");
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", before, preview: rows }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to mutate data, and --yes to skip the prompt.");
    process.exit(0);
  }

  if (!(await confirmApply(before.users.firebaseUsers))) {
    console.log("Migration cancelled.");
    process.exit(1);
  }

  const updated = await sql.begin(async (tx) => {
    return tx`
      UPDATE auth.users
      SET provider = 'email',
          provider_uid = NULL,
          providers = ARRAY['email']::text[],
          is_sso_user = FALSE,
          email_verified = TRUE,
          confirmed_at = COALESCE(confirmed_at, NOW()),
          raw_app_meta_data = jsonb_set(
            COALESCE(raw_app_meta_data, '{}'::jsonb),
            '{provider}',
            '"email"'::jsonb,
            TRUE
          ),
          raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) - 'firebase' - 'firebase_uid',
          identity_data = (
            COALESCE(identity_data, '{}'::jsonb)
            - 'provider_id'
            - 'provider_uid'
            - 'firebase_uid'
            - 'picture'
            - 'avatar_url'
          )
            || jsonb_build_object('provider', 'email', 'email_verified', TRUE, 'migrated_from', 'firebase'),
          avatar_url = CASE
            WHEN avatar_url ILIKE '%googleusercontent.com%' THEN NULL
            ELSE avatar_url
          END,
          updated_at = NOW()
      WHERE provider = 'firebase'
         OR avatar_url ILIKE '%googleusercontent.com%'
      RETURNING id, email
    `;
  });

  const after = await tableStats();
  console.log(JSON.stringify({ migrated: updated.length, after }, null, 2));
} finally {
  await sql.end();
}
