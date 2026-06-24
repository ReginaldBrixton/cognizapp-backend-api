import { readFileSync } from "node:fs";
import postgres from "postgres";

const confirmed = process.argv.includes("--yes");

if (!confirmed) {
  console.error("Refusing to reset support requests without --yes.");
  process.exit(1);
}

const envText = readFileSync(".env", "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).trim()];
    }),
);

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in users/.env");
}

const sql = postgres(env.DATABASE_URL, { max: 1 });

const tables = [
  "support_requests",
  "support_payments",
  "support_events",
  "support_files",
  "support_message_threads",
  "support_messages",
  "support_quotes",
  "support_orders",
  "support_deliveries",
  "support_revisions",
  "support_referrals",
  "support_refund_requests",
  "support_request_versions",
  "paystack_transactions",
];

async function tableCounts() {
  const rows = [];

  for (const table of tables) {
    const tableName = `app.${table}`;
    const [exists] = await sql.unsafe("SELECT to_regclass($1) AS regclass", [
      tableName,
    ]);

    if (!exists.regclass) {
      rows.push({ table: tableName, exists: false });
      continue;
    }

    const [count] = await sql.unsafe(
      `SELECT count(*)::int AS count FROM app."${table.replaceAll('"', '""')}"`,
    );
    rows.push({ table: tableName, exists: true, count: count.count });
  }

  return rows;
}

try {
  const before = await tableCounts();

  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM app.paystack_transactions
      WHERE purpose = 'support_payment'
        OR support_request_id IN (SELECT id FROM app.support_requests)
        OR support_payment_id IN (SELECT id FROM app.support_payments)
    `;
    await tx`
      DELETE FROM app.support_message_threads
      WHERE request_id IN (SELECT id FROM app.support_requests)
    `;
    await tx`
      DELETE FROM app.support_referrals
      WHERE request_id IN (SELECT id FROM app.support_requests)
    `;
    await tx`DELETE FROM app.support_requests`;
  });

  const after = await tableCounts();

  console.log(JSON.stringify({ before, after }, null, 2));
} finally {
  await sql.end();
}
