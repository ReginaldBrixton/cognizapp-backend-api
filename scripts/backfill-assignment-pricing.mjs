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

const assignmentPredicate = sql`
  (
    'assignment' = ANY(COALESCE(service_tags, ARRAY[]::text[]))
    OR draft_payload ? 'assignment_config'
    OR draft_payload ? 'assignmentInstructions'
    OR draft_payload->>'serviceCategory' = 'assignment'
  )
`;

async function summarize() {
  const [summary] = await sql`
    SELECT
      count(*)::int AS assignment_requests,
      count(*) FILTER (
        WHERE COALESCE(payment_amount, 0) != 10
          OR COALESCE(quoted_amount, 0) != 10
          OR COALESCE(final_amount, payment_amount, quoted_amount, 0) != 10
          OR COALESCE(original_amount, payment_amount, quoted_amount, 0) != 10
          OR COALESCE(deposit_percent, 0) != 100
          OR COALESCE(deposit_amount, 0) != 10
          OR COALESCE(balance_amount, 0) != 0
          OR COALESCE(payment_mode, '') != 'before_work'
          OR COALESCE(discount_amount, 0) != 0
          OR discount_code_id IS NOT NULL
          OR COALESCE(budget_min, 0) != 10
          OR COALESCE(budget_max, 0) != 10
      )::int AS request_rows_needing_repair
    FROM app.support_requests
    WHERE ${assignmentPredicate}
  `;

  const requestAmounts = await sql`
    SELECT
      COALESCE(payment_amount, 0)::numeric AS payment_amount,
      COALESCE(deposit_percent, 0)::int AS deposit_percent,
      COALESCE(deposit_amount, 0)::numeric AS deposit_amount,
      COALESCE(balance_amount, 0)::numeric AS balance_amount,
      count(*)::int AS count
    FROM app.support_requests
    WHERE ${assignmentPredicate}
    GROUP BY 1, 2, 3, 4
    ORDER BY count DESC, payment_amount
  `;

  const pendingPayments = await sql`
    SELECT count(*)::int AS count
    FROM app.support_payments p
    INNER JOIN app.support_requests r ON r.id = p.request_id
    WHERE ${assignmentPredicate}
      AND p.status IN ('pending', 'submitted')
      AND p.verified_at IS NULL
      AND COALESCE(p.amount, 0) != 10
  `;

  const pendingTransactions = await sql`
    SELECT count(*)::int AS count
    FROM app.paystack_transactions pt
    INNER JOIN app.support_requests r ON r.id = pt.support_request_id
    WHERE ${assignmentPredicate}
      AND pt.status = 'pending'
      AND COALESCE(pt.amount, 0) != 10
  `;

  return {
    ...summary,
    request_amount_groups: requestAmounts,
    stale_pending_support_payments: pendingPayments[0]?.count ?? 0,
    stale_pending_paystack_transactions: pendingTransactions[0]?.count ?? 0,
  };
}

try {
  const before = await summarize();
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", targetEnv, before }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with APPLY=1 to update production assignment pricing rows.");
    process.exit(0);
  }

  const result = await sql.begin(async (tx) => {
    const repairedRequests = await tx`
      UPDATE app.support_requests
      SET
        service_tags = ARRAY['assignment']::text[],
        payment_amount = 10,
        quoted_amount = 10,
        original_amount = 10,
        final_amount = 10,
        discount_amount = 0,
        discount_code_id = NULL,
        deposit_percent = 100,
        deposit_amount = 10,
        balance_amount = 0,
        payment_mode = 'before_work',
        budget_min = 10,
        budget_max = 10,
        draft_payload =
          COALESCE(draft_payload, '{}'::jsonb)
          || jsonb_build_object(
            'serviceCategory', 'assignment',
            'serviceTags', jsonb_build_array('assignment'),
            'paymentMode', 'before_work',
            'depositPercent', 100,
            'budgetMin', 10,
            'budgetMax', 10,
            'costEstimate', jsonb_build_object(
              'total', 10,
              'min', 10,
              'max', 10,
              'range', jsonb_build_object('min', 10, 'max', 10),
              'breakdown', jsonb_build_array(jsonb_build_object('item', 'One assignment', 'cost', 10)),
              'provider', 'server-local',
              'serverMinimumTotal', 10
            ),
            'assignment_config',
              COALESCE(
                draft_payload->'assignment_config',
                CASE
                  WHEN draft_payload ? 'assignmentInstructions'
                  THEN jsonb_build_object('instructions', draft_payload->>'assignmentInstructions')
                  ELSE jsonb_build_object('instructions', COALESCE(description, ''))
                END
              )
          ),
        payment_status = CASE
          WHEN payment_status IN ('deposit_required', 'final_payment_required') THEN 'unpaid'
          ELSE payment_status
        END,
        updated_at = NOW()
      WHERE ${assignmentPredicate}
      RETURNING id
    `;

    const cancelledPayments = await tx`
      UPDATE app.support_payments p
      SET
        status = 'cancelled',
        rejection_reason = 'Cancelled by assignment fixed-price backfill; recreate payment at GHS 10.',
        updated_at = NOW()
      FROM app.support_requests r
      WHERE r.id = p.request_id
        AND ${assignmentPredicate}
        AND p.status IN ('pending', 'submitted')
        AND p.verified_at IS NULL
        AND COALESCE(p.amount, 0) != 10
      RETURNING p.id
    `;

    const cancelledTransactions = await tx`
      UPDATE app.paystack_transactions pt
      SET
        status = 'cancelled',
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
            'cancelledBy', 'assignment_fixed_price_backfill',
            'cancelledAt', NOW(),
            'replacementAmount', 10
          ),
        updated_at = NOW()
      FROM app.support_requests r
      WHERE r.id = pt.support_request_id
        AND ${assignmentPredicate}
        AND pt.status = 'pending'
        AND COALESCE(pt.amount, 0) != 10
      RETURNING pt.id
    `;

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
