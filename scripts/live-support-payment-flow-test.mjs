import { readFileSync } from "node:fs";
import postgres from "postgres";

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

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4040";
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
const testEmail = process.env.TEST_EMAIL ?? env.MASTER_USER_EMAIL ?? "cognizap.ai@gmail.com";

if (!env.DEV_AUTH_ENDPOINT_SECRET) {
  throw new Error("DEV_AUTH_ENDPOINT_SECRET is required for the live local flow test");
}

const configuredDatabaseUrl = process.env.DATABASE_URL ?? env.DATABASE_URL;

if (!configuredDatabaseUrl) {
  throw new Error("DATABASE_URL is required in users/.env");
}

function directNeonUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.)/, "");
  return parsed.toString();
}

const sql = postgres(process.env.DATABASE_URL_DIRECT ?? directNeonUrl(configuredDatabaseUrl), {
  max: 1,
  connect_timeout: 30,
});

function rowsToCountMap(rows, key = "key") {
  return Object.fromEntries(
    rows.map((row) => [String(row[key] ?? "unknown"), Number(row.count ?? 0)]),
  );
}

async function countSupportRows() {
  const [clients] = await sql`SELECT count(*)::int AS count FROM app.support_clients`;
  const [requests] = await sql`SELECT count(*)::int AS count FROM app.support_requests`;
  const requestStatuses = await sql`
    SELECT COALESCE(status, 'unknown') AS key, count(*)::int AS count
    FROM app.support_requests
    GROUP BY COALESCE(status, 'unknown')
    ORDER BY key
  `;
  const requestPaymentStatuses = await sql`
    SELECT COALESCE(payment_status, 'unknown') AS key, count(*)::int AS count
    FROM app.support_requests
    GROUP BY COALESCE(payment_status, 'unknown')
    ORDER BY key
  `;
  const [payments] = await sql`SELECT count(*)::int AS count FROM app.support_payments`;
  const paymentStatuses = await sql`
    SELECT COALESCE(status, 'unknown') AS key, count(*)::int AS count
    FROM app.support_payments
    GROUP BY COALESCE(status, 'unknown')
    ORDER BY key
  `;
  const paymentTypes = await sql`
    SELECT COALESCE(payment_type, 'unknown') AS key, count(*)::int AS count
    FROM app.support_payments
    GROUP BY COALESCE(payment_type, 'unknown')
    ORDER BY key
  `;
  const [events] = await sql`SELECT count(*)::int AS count FROM app.support_events`;
  const eventTypes = await sql`
    SELECT COALESCE(event_type, 'unknown') AS key, count(*)::int AS count
    FROM app.support_events
    GROUP BY COALESCE(event_type, 'unknown')
    ORDER BY key
  `;
  const [messageThreads] = await sql`SELECT count(*)::int AS count FROM app.support_message_threads`;
  const [messages] = await sql`SELECT count(*)::int AS count FROM app.support_messages`;
  const [files] = await sql`SELECT count(*)::int AS count FROM app.support_files`;
  const [referrals] = await sql`SELECT count(*)::int AS count FROM app.support_referrals`;
  const [transactions] = await sql`
    SELECT count(*)::int AS count
    FROM app.paystack_transactions
    WHERE purpose = 'support_payment'
  `;
  const transactionStatuses = await sql`
    SELECT COALESCE(status, 'unknown') AS key, count(*)::int AS count
    FROM app.paystack_transactions
    WHERE purpose = 'support_payment'
    GROUP BY COALESCE(status, 'unknown')
    ORDER BY key
  `;
  return {
    supportClients: { total: clients.count },
    supportRequests: {
      total: requests.count,
      byStatus: rowsToCountMap(requestStatuses),
      byPaymentStatus: rowsToCountMap(requestPaymentStatuses),
    },
    supportPayments: {
      total: payments.count,
      byStatus: rowsToCountMap(paymentStatuses),
      byPaymentType: rowsToCountMap(paymentTypes),
    },
    supportEvents: {
      total: events.count,
      byEventType: rowsToCountMap(eventTypes),
    },
    supportMessageThreads: { total: messageThreads.count },
    supportMessages: { total: messages.count },
    supportFiles: { total: files.count },
    supportReferrals: { total: referrals.count },
    supportPaystackTransactions: {
      total: transactions.count,
      byStatus: rowsToCountMap(transactionStatuses),
    },
  };
}

async function timed(label, action) {
  const started = performance.now();
  const result = await action();
  const durationMs = Math.round(performance.now() - started);
  return { label, durationMs, ...result };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

async function cleanupTemporaryRequest(requestId) {
  if (!requestId) return;
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM app.paystack_transactions
      WHERE support_request_id = ${requestId}::uuid
        OR support_payment_id IN (
          SELECT id FROM app.support_payments WHERE request_id = ${requestId}::uuid
        )
    `;
    await tx`
      DELETE FROM app.support_events
      WHERE request_id = ${requestId}::uuid
    `;
    await tx`
      DELETE FROM app.support_messages
      WHERE thread_id IN (
        SELECT id FROM app.support_message_threads WHERE request_id = ${requestId}::uuid
      )
    `;
    await tx`
      DELETE FROM app.support_message_threads
      WHERE request_id = ${requestId}::uuid
    `;
    await tx`
      DELETE FROM app.support_payments
      WHERE request_id = ${requestId}::uuid
    `;
    await tx`DELETE FROM app.support_requests WHERE id = ${requestId}::uuid`;
  });
}

let createdRequestId = null;

try {
  const before = await countSupportRows();

  const authStep = await timed("dev auth token", async () => {
    const response = await fetch(`${backendUrl}/api/auth/dev/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-Auth-Secret": env.DEV_AUTH_ENDPOINT_SECRET,
      },
      body: JSON.stringify({ email: testEmail }),
    });
    const data = await readJson(response);
    if (!response.ok || !data?.accessToken) {
      throw new Error(`Failed to issue dev token: ${response.status} ${JSON.stringify(data)}`);
    }
    return { status: response.status, accessToken: data.accessToken };
  });

  const authHeader = { Authorization: `Bearer ${authStep.accessToken}` };
  delete authStep.accessToken;

  const listBefore = await timed("list requests before create", async () => {
    const response = await fetch(`${frontendUrl}/api/support/client/requests`, {
      headers: authHeader,
    });
    const data = await readJson(response);
    return {
      status: response.status,
      success: data?.success,
      count: Array.isArray(data?.data) ? data.data.length : null,
    };
  });

  const createStep = await timed("create temporary support request", async () => {
    const response = await fetch(`${frontendUrl}/api/support/client/requests`, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `Codex live Paystack smoke ${Date.now()}`,
        description: "Temporary request created by the live support payment flow test.",
        serviceTags: ["proposal-review"],
        subject: "Production readiness smoke test",
        academicLevel: "undergraduate",
        budgetMin: 30,
        budgetMax: 30,
        costEstimate: { total: 30 },
        currency: "GHS",
        paymentMode: "before_work",
        depositPercent: 100,
        integrityAck: true,
        contactConsent: true,
        institution: "CognizApp QA",
        whatsappNumber: "+233506291029",
      }),
    });
    const data = await readJson(response);
    const requestId = data?.data?.id;
    if (!response.ok || !requestId) {
      throw new Error(`Failed to create request: ${response.status} ${JSON.stringify(data)}`);
    }
    createdRequestId = requestId;
    return {
      status: response.status,
      success: data?.success,
      requestId,
      paymentStatus: data?.data?.paymentStatus,
      depositAmount: data?.data?.depositAmount,
      balanceAmount: data?.data?.balanceAmount,
    };
  });

  const markPreviewReadyStep = await timed("mark temporary preview ready", async () => {
    const [updated] = await sql`
      UPDATE app.support_requests
      SET preview_status = 'ready',
        preview_access = 'limited',
        updated_at = NOW()
      WHERE id = ${createdRequestId}::uuid
      RETURNING id, preview_status, preview_access
    `;
    if (!updated) {
      throw new Error("Failed to mark temporary request preview-ready");
    }
    return {
      status: 200,
      requestId: updated.id,
      previewStatus: updated.preview_status,
      previewAccess: updated.preview_access,
    };
  });

  let mobileReference = null;
  const mobileMoneyStep = await timed("initialize mobile money authorization", async () => {
    const response = await fetch(
      `${frontendUrl}/api/support/client/requests/${createdRequestId}/paystack/mobile-money`,
      {
        method: "POST",
        headers: {
          ...authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paymentType: "deposit",
          amount: Number(createStep.depositAmount ?? 30),
          phone: "0551234987",
          provider: "mtn",
          idempotencyKey: `live_momo_${Date.now()}`,
        }),
      },
    );
    const data = await readJson(response);
    if (!response.ok || !data?.reference) {
      throw new Error(`Failed to initialize mobile money: ${response.status} ${JSON.stringify(data)}`);
    }
    mobileReference = data.reference;
    return {
      status: response.status,
      success: data?.success,
      reference: data?.reference,
      reused: data?.reused,
      pendingStep: data?.pendingStep,
      provider: data?.provider,
      phoneLast4: data?.phoneLast4,
      paymentStatus: data?.request?.paymentStatus,
      paymentType: data?.data?.paymentType,
      amount: data?.data?.amount,
      providerMessage: data?.message,
      paystackStatus: data?.paystack?.data?.status,
      expiresInSeconds: data?.expiresInSeconds,
    };
  });

  const checkMobileMoneyStep = await timed("check pending mobile money charge", async () => {
    const response = await fetch(
      `${frontendUrl}/api/support/client/requests/${createdRequestId}/paystack/check`,
      {
        method: "POST",
        headers: {
          ...authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reference: mobileReference }),
      },
    );
    const data = await readJson(response);
    if (!response.ok) {
      throw new Error(`Unexpected mobile money charge check response: ${response.status} ${JSON.stringify(data)}`);
    }
    const chargeStatus = String(data?.chargeStatus ?? data?.paystack?.data?.status ?? "");
    const verified = data?.verified === true;
    if (!verified && data?.verified !== false) {
      throw new Error(`Unexpected mobile money verification shape: ${response.status} ${JSON.stringify(data)}`);
    }
    return {
      status: response.status,
      success: data?.success,
      verified,
      chargeStatus,
      paymentStatus: data?.request?.paymentStatus,
      message: data?.message,
    };
  });

  const mobileMoneyVerified = checkMobileMoneyStep.verified === true;

  const duplicateMobileMoneyStep = mobileMoneyVerified
    ? {
        label: "reuse pending mobile money authorization",
        durationMs: 0,
        skipped: true,
        reason: "Paystack test charge settled immediately; no pending authorization remained to reuse.",
      }
    : await timed("reuse pending mobile money authorization", async () => {
        const response = await fetch(
          `${frontendUrl}/api/support/client/requests/${createdRequestId}/paystack/mobile-money`,
          {
            method: "POST",
            headers: {
              ...authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              paymentType: "deposit",
              amount: Number(createStep.depositAmount ?? 30),
              phone: "0551234987",
              provider: "MTN Mobile Money",
              idempotencyKey: `live_momo_duplicate_${Date.now()}`,
            }),
          },
        );
        const data = await readJson(response);
        if (!response.ok || data?.reference !== mobileReference || data?.reused !== true) {
          throw new Error(`Pending mobile money was not reused: ${response.status} ${JSON.stringify(data)}`);
        }
        return {
          status: response.status,
          success: data?.success,
          reference: data?.reference,
          reused: data?.reused,
          pendingStep: data?.pendingStep,
          provider: data?.provider,
          phoneLast4: data?.phoneLast4,
          sameReference: data?.reference === mobileReference,
          message: data?.message,
        };
      });

  const cancelMobileMoneyStep = mobileMoneyVerified
    ? {
        label: "cancel pending mobile money authorization",
        durationMs: 0,
        skipped: true,
        reason: "Paystack test charge settled immediately; verified payments are not cancelled.",
      }
    : await timed("cancel pending mobile money authorization", async () => {
        const response = await fetch(
          `${frontendUrl}/api/support/client/requests/${createdRequestId}/paystack/cancel`,
          {
            method: "POST",
            headers: {
              ...authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reference: mobileReference }),
          },
        );
        const data = await readJson(response);
        if (!response.ok) {
          throw new Error(`Failed to cancel mobile money authorization: ${response.status} ${JSON.stringify(data)}`);
        }
        return {
          status: response.status,
          success: data?.success,
          paymentStatus: data?.request?.paymentStatus,
          message: data?.message,
        };
      });

  const checkoutStep = mobileMoneyVerified
    ? {
        label: "initialize hosted checkout fallback",
        durationMs: 0,
        skipped: true,
        reason: "Paystack test charge settled immediately; the paid request correctly blocks duplicate checkout.",
      }
    : await timed("initialize hosted checkout fallback", async () => {
        const response = await fetch(
          `${frontendUrl}/api/support/client/requests/${createdRequestId}/paystack/checkout`,
          {
            method: "POST",
            headers: {
              ...authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              paymentType: "deposit",
              callbackUrl: "https://www.cognizapp.com/support/payments",
              channels: ["card", "bank", "bank_transfer"],
            }),
          },
        );
        const data = await readJson(response);
        if (!response.ok || !data?.authorizationUrl || !data?.accessCode) {
          throw new Error(`Failed to initialize checkout: ${response.status} ${JSON.stringify(data)}`);
        }
        return {
          status: response.status,
          success: data?.success,
          hasAccessCode: Boolean(data?.accessCode),
          paymentStatus: data?.request?.paymentStatus,
          paymentType: data?.data?.paymentType,
          amount: data?.data?.amount,
          authorizationHost: data?.authorizationUrl
            ? new URL(data.authorizationUrl).host
            : null,
          message: data?.message,
        };
      });

  const deleteStep = await timed("delete temporary support request", async () => {
    if (mobileMoneyVerified) {
      await cleanupTemporaryRequest(createdRequestId);
      return {
        status: 200,
        success: true,
        cleanupMode: "direct-db",
        message: "Temporary paid request cleaned up directly after live payment verification.",
      };
    }

    const response = await fetch(`${frontendUrl}/api/support/client/requests/${createdRequestId}`, {
      method: "DELETE",
      headers: authHeader,
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new Error(`Failed to delete temporary request: ${response.status} ${JSON.stringify(data)}`);
    }
    return {
      status: response.status,
      success: data?.success,
      cleanupMode: "api",
      message: data?.message ?? data?.error,
    };
  });
  createdRequestId = null;

  const listAfter = await timed("list requests after cleanup", async () => {
    const response = await fetch(`${frontendUrl}/api/support/client/requests`, {
      headers: authHeader,
    });
    const data = await readJson(response);
    return {
      status: response.status,
      success: data?.success,
      count: Array.isArray(data?.data) ? data.data.length : null,
    };
  });

  const after = await countSupportRows();

  console.log(
    JSON.stringify(
      {
        user: testEmail,
        paystackMode: env.PAYSTACK_SECRET_KEY?.startsWith("sk_live_") ? "live" : "test",
        before,
        steps: [
          authStep,
          listBefore,
          createStep,
          markPreviewReadyStep,
          mobileMoneyStep,
          checkMobileMoneyStep,
          duplicateMobileMoneyStep,
          cancelMobileMoneyStep,
          checkoutStep,
          deleteStep,
          listAfter,
        ],
        after,
      },
      null,
      2,
    ),
  );
} finally {
  if (createdRequestId) {
    await cleanupTemporaryRequest(createdRequestId);
  }
  await sql.end();
}
