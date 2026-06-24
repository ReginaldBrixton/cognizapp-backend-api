import { readFileSync } from "node:fs";
import postgres from "postgres";
import "dotenv/config";

const envFile = new URL("../.env", import.meta.url);

function readEnvFile(name) {
  try {
    const envText = readFileSync(envFile, "utf8");
    return envText
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim();
  } catch {
    return undefined;
  }
}

const targetEnv = process.env.DATABASE_URL_TARGET || "DATABASE_URL_PROD";
const databaseUrl = process.env[targetEnv] || readEnvFile(targetEnv);
const apply = process.env.APPLY === "1";

if (!databaseUrl) {
  console.error(`${targetEnv} is not set`);
  process.exit(1);
}

if (targetEnv !== "DATABASE_URL_PROD" && process.env.ALLOW_NON_PROD !== "1") {
  console.error(`Refusing to run against ${targetEnv}. Set ALLOW_NON_PROD=1 for non-production repairs.`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

const priceCaseSql = `
  CASE service_tag
    WHEN 'assignment' THEN 10::numeric
    WHEN 'research-diagnostic' THEN 15::numeric
    WHEN 'proposal-review' THEN 60::numeric
    WHEN 'chapter-editing' THEN 90::numeric
    WHEN 'literature-methodology' THEN 80::numeric
    WHEN 'citation-integrity' THEN 45::numeric
    WHEN 'supervisor-comments' THEN 50::numeric
    WHEN 'data-analysis' THEN 125::numeric
    WHEN 'questionnaire-survey' THEN 70::numeric
    WHEN 'thesis-formatting' THEN 60::numeric
    WHEN 'powerpoint-preparation' THEN 50::numeric
    WHEN 'excel-dashboard' THEN 90::numeric
    WHEN 'full-project-support' THEN 250::numeric
    WHEN 'free-diagnostic' THEN 15::numeric
    ELSE NULL::numeric
  END
`;

const eligibleStatuses = [
  "unpaid",
  "failed",
  "deposit_required",
  "final_payment_required",
  "pending",
  "paystack_pending",
  "deposit_pending_verification",
  "final_payment_pending_verification",
];

async function summarize() {
  const staleRows = await sql.unsafe(`
    WITH priced AS (
      SELECT
        r.id,
        r.payment_status,
        r.payment_amount,
        r.deposit_percent,
        r.deposit_amount,
        r.balance_amount,
        COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag
      FROM app.support_requests r
      WHERE COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') IS NOT NULL
        AND r.payment_status = ANY($1::text[])
    ), expected AS (
      SELECT *, ${priceCaseSql} AS expected_amount
      FROM priced
    )
    SELECT
      service_tag,
      expected_amount,
      COALESCE(payment_amount, 0)::numeric AS payment_amount,
      COALESCE(deposit_percent, 0)::int AS deposit_percent,
      COALESCE(deposit_amount, 0)::numeric AS deposit_amount,
      COALESCE(balance_amount, 0)::numeric AS balance_amount,
      count(*)::int AS count
    FROM expected
    WHERE expected_amount IS NOT NULL
      AND (
        COALESCE(payment_amount, 0) != expected_amount
        OR COALESCE(deposit_percent, 0) != 100
        OR COALESCE(deposit_amount, 0) != expected_amount
        OR COALESCE(balance_amount, 0) != 0
      )
    GROUP BY 1,2,3,4,5,6
    ORDER BY service_tag, count DESC
  `, [eligibleStatuses]);

  const [summary] = await sql.unsafe(`
    WITH priced AS (
      SELECT
        r.id,
        COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag,
        r.payment_status,
        r.payment_amount,
        r.deposit_percent,
        r.deposit_amount,
        r.balance_amount
      FROM app.support_requests r
      WHERE COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') IS NOT NULL
        AND r.payment_status = ANY($1::text[])
    ), expected AS (
      SELECT *, ${priceCaseSql} AS expected_amount
      FROM priced
    )
    SELECT
      count(*) FILTER (WHERE expected_amount IS NOT NULL)::int AS eligible_open_requests,
      count(*) FILTER (
        WHERE expected_amount IS NOT NULL AND (
          COALESCE(payment_amount, 0) != expected_amount
          OR COALESCE(deposit_percent, 0) != 100
          OR COALESCE(deposit_amount, 0) != expected_amount
          OR COALESCE(balance_amount, 0) != 0
        )
      )::int AS request_rows_needing_repair
    FROM expected
  `, [eligibleStatuses]);

  const [payments] = await sql.unsafe(`
    WITH priced AS (
      SELECT r.id, COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag
      FROM app.support_requests r
    ), expected AS (
      SELECT *, ${priceCaseSql} AS expected_amount
      FROM priced
    )
    SELECT count(*)::int AS count
    FROM app.support_payments p
    INNER JOIN expected e ON e.id = p.request_id
    WHERE e.expected_amount IS NOT NULL
      AND p.status IN ('pending', 'submitted')
      AND p.verified_at IS NULL
      AND COALESCE(p.amount, 0) != e.expected_amount
  `);

  const [transactions] = await sql.unsafe(`
    WITH priced AS (
      SELECT r.id, COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag
      FROM app.support_requests r
    ), expected AS (
      SELECT *, ${priceCaseSql} AS expected_amount
      FROM priced
    )
    SELECT count(*)::int AS count
    FROM app.paystack_transactions pt
    INNER JOIN expected e ON e.id = pt.support_request_id
    WHERE e.expected_amount IS NOT NULL
      AND pt.status = 'pending'
      AND COALESCE(pt.amount, 0) != e.expected_amount
  `);

  return {
    ...summary,
    stale_amount_groups: staleRows,
    stale_pending_support_payments: payments?.count ?? 0,
    stale_pending_paystack_transactions: transactions?.count ?? 0,
  };
}

try {
  const before = await summarize();
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", targetEnv, before }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with APPLY=1 to update production support pricing rows.");
    process.exit(0);
  }

  const result = await sql.begin(async (tx) => {
    const repairedRequests = await tx.unsafe(`
      WITH priced AS (
        SELECT
          r.id,
          COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag,
          CASE WHEN COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') = 'assignment' THEN true ELSE false END AS is_assignment
        FROM app.support_requests r
        WHERE COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') IS NOT NULL
          AND r.payment_status = ANY($1::text[])
      ), expected AS (
        SELECT *, ${priceCaseSql} AS expected_amount
        FROM priced
      )
      UPDATE app.support_requests r
      SET
        service_tags = ARRAY[e.service_tag]::text[],
        payment_amount = e.expected_amount,
        quoted_amount = e.expected_amount,
        original_amount = e.expected_amount,
        final_amount = e.expected_amount,
        discount_amount = 0,
        discount_code_id = NULL,
        deposit_percent = 100,
        deposit_amount = e.expected_amount,
        balance_amount = 0,
        payment_mode = 'before_work',
        budget_min = e.expected_amount,
        budget_max = e.expected_amount,
        payment_status = CASE
          WHEN r.payment_status IN ('deposit_required', 'final_payment_required') THEN 'unpaid'
          ELSE r.payment_status
        END,
        draft_payload = COALESCE(r.draft_payload, '{}'::jsonb)
          || jsonb_build_object(
            'serviceCategory', e.service_tag,
            'serviceTags', jsonb_build_array(e.service_tag),
            'paymentMode', 'before_work',
            'depositPercent', 100,
            'budgetMin', e.expected_amount,
            'budgetMax', e.expected_amount,
            'costEstimate', jsonb_build_object(
              'total', e.expected_amount,
              'min', e.expected_amount,
              'max', e.expected_amount,
              'range', jsonb_build_object('min', e.expected_amount, 'max', e.expected_amount),
              'provider', 'server-local',
              'serverMinimumTotal', e.expected_amount
            )
          ),
        updated_at = NOW()
      FROM expected e
      WHERE r.id = e.id
        AND e.expected_amount IS NOT NULL
        AND (
          COALESCE(r.payment_amount, 0) != e.expected_amount
          OR COALESCE(r.quoted_amount, 0) != e.expected_amount
          OR COALESCE(r.final_amount, r.payment_amount, r.quoted_amount, 0) != e.expected_amount
          OR COALESCE(r.deposit_percent, 0) != 100
          OR COALESCE(r.deposit_amount, 0) != e.expected_amount
          OR COALESCE(r.balance_amount, 0) != 0
          OR COALESCE(r.payment_mode, '') != 'before_work'
          OR COALESCE(r.budget_min, 0) != e.expected_amount
          OR COALESCE(r.budget_max, 0) != e.expected_amount
        )
      RETURNING r.id
    `, [eligibleStatuses]);

    const cancelledPayments = await tx.unsafe(`
      WITH priced AS (
        SELECT r.id, COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag
        FROM app.support_requests r
      ), expected AS (
        SELECT *, ${priceCaseSql} AS expected_amount
        FROM priced
      )
      UPDATE app.support_payments p
      SET
        status = 'cancelled',
        rejection_reason = 'Cancelled by service fixed-price backfill; recreate payment at displayed service price.',
        updated_at = NOW()
      FROM expected e
      WHERE e.id = p.request_id
        AND e.expected_amount IS NOT NULL
        AND p.status IN ('pending', 'submitted')
        AND p.verified_at IS NULL
        AND COALESCE(p.amount, 0) != e.expected_amount
      RETURNING p.id
    `);

    const cancelledTransactions = await tx.unsafe(`
      WITH priced AS (
        SELECT r.id, COALESCE(r.service_tags[1], r.draft_payload->>'serviceCategory') AS service_tag
        FROM app.support_requests r
      ), expected AS (
        SELECT *, ${priceCaseSql} AS expected_amount
        FROM priced
      )
      UPDATE app.paystack_transactions pt
      SET
        status = 'cancelled',
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
            'cancelledBy', 'service_fixed_price_backfill',
            'cancelledAt', NOW(),
            'replacementAmount', e.expected_amount
          ),
        updated_at = NOW()
      FROM expected e
      WHERE e.id = pt.support_request_id
        AND e.expected_amount IS NOT NULL
        AND pt.status = 'pending'
        AND COALESCE(pt.amount, 0) != e.expected_amount
      RETURNING pt.id
    `);

    return {
      repairedRequests: repairedRequests.length,
      cancelledPayments: cancelledPayments.length,
      cancelledTransactions: cancelledTransactions.length,
    };
  });

  const after = await summarize();
  console.log(JSON.stringify({ result, after }, null, 2));
} finally {
  await sql.end();
}
