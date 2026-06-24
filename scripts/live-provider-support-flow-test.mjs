import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const backendUrl = (process.env.BACKEND_URL ?? "http://localhost:4040").replace(/\/$/, "");
const adminUrl = (process.env.ADMIN_URL ?? "http://localhost:3001").replace(/\/$/, "");
const dbTarget = String(process.env.DB_TARGET ?? "").trim().toLowerCase();
const cleanupEnabled = process.env.KEEP_PROVIDER_FLOW_FIXTURE !== "1";
const runId = `codex-provider-flow-${Date.now()}`;
const shortRunId = runId.replace(/[^a-z0-9]/gi, "").slice(-12).toUpperCase();

if (dbTarget === "prod" || dbTarget === "production") {
  if (!process.env.DATABASE_URL_PROD) {
    throw new Error("DB_TARGET=prod requires DATABASE_URL_PROD");
  }
  process.env.DATABASE_URL = process.env.DATABASE_URL_PROD;
  process.env.ENVIRONMENT = process.env.ENVIRONMENT || "production";
}

const { getDb, closeDb } = await import("../src/lib/db.ts");
const { authRepository } = await import("../src/modules/auth/repository.ts");
const { normalizeRole } = await import("../src/modules/auth/policy.ts");
const { deviceFingerprint, hashToken, signAccessToken, signRefreshToken } = await import("../src/lib/crypto.ts");

const db = getDb();
const fixture = {
  userIds: [],
  requestIds: [],
  threadIds: [],
  milestoneIds: [],
  discountCodeIds: [],
  paymentIds: [],
  fileIds: [],
  deliveryIds: [],
};
const results = [];

function assertionPassed(assertion) {
  return assertion === true || (Boolean(assertion) && typeof assertion !== "string");
}

function assertionLabel(assertion) {
  return assertionPassed(assertion) ? "pass" : String(assertion || "fail");
}

function nowLabel() {
  return new Date().toISOString();
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function readJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function cookieHeader(session) {
  return [
    `cognizap_admin_access_token=${encodeURIComponent(session.accessToken)}`,
    `cognizap_admin_refresh_token=${encodeURIComponent(session.refreshToken)}`,
  ].join("; ");
}

function noteResult({
  label,
  layer,
  method,
  path,
  status,
  ok,
  durationMs,
  success,
  assertion,
  details,
}) {
  results.push({
    label,
    layer,
    method,
    path,
    status,
    ok,
    durationMs,
    success,
    assertion,
    details,
  });
}

async function requestJson({
  label,
  layer = "backend",
  baseUrl = backendUrl,
  method = "GET",
  path,
  token,
  session,
  body,
  expected = [200],
  assert,
}) {
  const headers = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers.Cookie = cookieHeader(session);

  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const durationMs = Math.round(performance.now() - started);
  const text = await response.text();
  const data = readJsonSafe(text);
  const assertion = assert ? assert(data, response) : true;
  const ok = expected.includes(response.status) && assertionPassed(assertion);

  noteResult({
    label,
    layer,
    method,
    path,
    status: response.status,
    ok,
    durationMs,
    success: data?.success,
    assertion: assertionLabel(assertion),
    details: summarizePayload(data),
  });

  if (!ok) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(data, jsonReplacer)}`);
  }

  return { response, data };
}

async function requestForm({
  label,
  layer = "backend",
  baseUrl = backendUrl,
  method = "POST",
  path,
  token,
  session,
  fields = {},
  file,
  expected = [200],
  assert,
}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  if (file) form.append("file", file);

  const headers = {
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers.Cookie = cookieHeader(session);

  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: form,
  });
  const durationMs = Math.round(performance.now() - started);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const data = contentType.includes("application/json")
    ? readJsonSafe(text)
    : { raw: text.slice(0, 500), contentType };
  const assertion = assert ? assert(data, response) : true;
  const ok = expected.includes(response.status) && assertionPassed(assertion);

  noteResult({
    label,
    layer,
    method,
    path,
    status: response.status,
    ok,
    durationMs,
    success: data?.success,
    assertion: assertionLabel(assertion),
    details: summarizePayload(data),
  });

  if (!ok) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(data, jsonReplacer)}`);
  }

  return { response, data };
}

async function requestBytes({
  label,
  layer = "backend",
  baseUrl = backendUrl,
  path,
  token,
  expected = [200],
  assert,
}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const durationMs = Math.round(performance.now() - started);
  const text = await response.text();
  let data = readJsonSafe(text);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    data = {
      bytes: text.length,
      contentType: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      preview: text.slice(0, 80),
    };
  }
  const assertion = assert ? assert(data, response) : true;
  const ok = expected.includes(response.status) && assertionPassed(assertion);

  noteResult({
    label,
    layer,
    method: "GET",
    path,
    status: response.status,
    ok,
    durationMs,
    success: data?.success,
    assertion: assertionLabel(assertion),
    details: summarizePayload(data),
  });

  if (!ok) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(data, jsonReplacer)}`);
  }

  return { response, data };
}

function summarizePayload(data) {
  if (!data || typeof data !== "object") return "";
  const payload = data.data ?? data.request ?? data;
  if (Array.isArray(payload)) return `items=${payload.length}`;
  const keys = [
    "id",
    "kind",
    "paymentStatus",
    "status",
    "discountPercent",
    "requiresAdminApproval",
    "depositPercent",
    "canDownload",
    "downloadUrl",
    "message",
    "error",
    "code",
  ];
  return keys
    .filter((key) => payload?.[key] !== undefined || data?.[key] !== undefined)
    .map((key) => `${key}=${payload?.[key] ?? data?.[key]}`)
    .join(", ");
}

async function countSupportRows() {
  const [requests] = await db`SELECT count(*)::int AS count FROM support_requests`;
  const [threads] = await db`SELECT count(*)::int AS count FROM support_message_threads`;
  const [messages] = await db`SELECT count(*)::int AS count FROM support_messages`;
  const [files] = await db`SELECT count(*)::int AS count FROM support_files`;
  const [discountCodes] = await db`SELECT count(*)::int AS count FROM support_discount_codes`;
  const [discountRequests] = await db`SELECT count(*)::int AS count FROM support_discount_requests`;
  const [deliveries] = await db`SELECT count(*)::int AS count FROM support_deliveries`;
  const [payments] = await db`SELECT count(*)::int AS count FROM support_payments`;
  const [sessions] = await db`SELECT count(*)::int AS count FROM auth.sessions WHERE user_agent LIKE 'codex-provider-flow-smoke/%'`;
  return {
    supportRequests: requests.count,
    messageThreads: threads.count,
    supportMessages: messages.count,
    supportFiles: files.count,
    discountCodes: discountCodes.count,
    discountRequests: discountRequests.count,
    deliveries: deliveries.count,
    payments: payments.count,
    codexSmokeSessions: sessions.count,
  };
}

function printStatsTable(before, withFixture, after) {
  const names = Object.keys(before);
  console.log("\nTABLE_STATISTICS");
  console.log("| table | before | during_test | after_cleanup | cleanup_delta |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const name of names) {
    const cleanupDelta = Number(after[name] ?? 0) - Number(before[name] ?? 0);
    console.log(`| ${name} | ${before[name]} | ${withFixture[name]} | ${after[name]} | ${cleanupDelta} |`);
  }
}

function printResultTable() {
  console.log("\nFLOW_RESULTS");
  console.log("| label | layer | method | status | assertion | ms | details |");
  console.log("| --- | --- | --- | ---: | --- | ---: | --- |");
  for (const result of results) {
    console.log(
      `| ${result.label} | ${result.layer} | ${result.method} | ${result.status} | ${result.assertion} | ${result.durationMs} | ${String(result.details ?? "").replace(/\|/g, "/")} |`,
    );
  }
}

async function ensureGrant(email, role, displayName) {
  await db`
    INSERT INTO auth.privileged_access_grants (email, role, status, display_name, metadata)
    VALUES (${email}, ${role}, 'active', ${displayName}, ${db.json({ codexSmoke: true, runId })})
    ON CONFLICT (lower(email), role) DO UPDATE
    SET status = 'active',
      display_name = EXCLUDED.display_name,
      revoked_at = NULL,
      revoked_by = NULL,
      updated_at = NOW(),
      metadata = auth.privileged_access_grants.metadata || EXCLUDED.metadata
  `;
}

async function upsertUser(email, displayName, role) {
  const user = await authRepository.upsertUser({
    email,
    emailVerified: true,
    displayName,
    avatarUrl: "",
    provider: "email",
    providerUid: null,
    providers: ["email"],
    userMetadata: { codexSmoke: true, runId },
    appMetadata: { codexSmoke: true, runId },
    identityData: { email },
    roleOverride: role,
  });
  fixture.userIds.push(user.id);
  return user;
}

async function issueSession(user) {
  const role = normalizeRole(user.role);
  const fingerprint = deviceFingerprint(`codex-provider-flow-smoke:${runId}:${user.id}`);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const placeholder = await authRepository.createSession({
    userId: user.id,
    email: user.email,
    role,
    tokenHash: hashToken(`pending_${randomUUID()}`),
    refreshTokenHash: hashToken(`pending_refresh_${randomUUID()}`),
    expiresAt,
    refreshExpiresAt,
    ipAddress: "127.0.0.1",
    userAgent: `codex-provider-flow-smoke/${runId}`,
    deviceFingerprint: fingerprint,
    browser: "Codex",
    os: "Windows",
    deviceType: "desktop",
    deviceName: "Codex smoke test",
  });
  const accessToken = await signAccessToken({
    userId: user.id,
    sessionId: placeholder.id,
    role,
    email: user.email,
    deviceFingerprint: fingerprint,
  });
  const refreshToken = await signRefreshToken({
    userId: user.id,
    sessionId: placeholder.id,
  });
  await authRepository.updateSessionTokens(
    placeholder.id,
    hashToken(accessToken),
    hashToken(refreshToken),
    expiresAt,
    refreshExpiresAt,
  );
  return { accessToken, refreshToken, sessionId: placeholder.id };
}

async function createSupportClient(clientUser) {
  const [client] = await db`
    INSERT INTO support_clients (
      user_key_id, email, full_name, whatsapp_number, institution, level, referral_code
    )
    VALUES (
      ${clientUser.id}, ${clientUser.email}, 'Codex QA Client', '+233506291029',
      'CogniZap QA', 'postgraduate', ${`CDX-${shortRunId}`}
    )
    ON CONFLICT (user_key_id) DO UPDATE
    SET email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      whatsapp_number = EXCLUDED.whatsapp_number,
      institution = EXCLUDED.institution,
      level = EXCLUDED.level,
      updated_at = NOW()
    RETURNING *
  `;
  return client;
}

async function createRequest(client, label, amount = 100) {
  const taskId = `CZ-CDX-${shortRunId}-${label}`;
  const [request] = await db`
    INSERT INTO support_requests (
      task_id, user_key_id, client_id, title, description, service_tags, subject,
      academic_level, output_expectation, institution, whatsapp_number, status,
      payment_status, payment_mode, payment_amount, quoted_amount, original_amount,
      final_amount, deposit_percent, deposit_amount, balance_amount, currency,
      integrity_ack, contact_consent, submitted_at, draft_payload
    )
    VALUES (
      ${taskId}, ${client.user_key_id}, ${client.id}, ${`Codex provider smoke ${label}`},
      ${`Temporary ${runId} ${label}`}, ${["proposal-review"]}, 'Production smoke',
      'postgraduate', 'API verification', 'CogniZap QA', '+233506291029',
      'submitted', 'unpaid', 'deposit_then_balance', ${amount}, ${amount}, ${amount},
      ${amount}, 50, ${amount / 2}, ${amount / 2}, 'GHS',
      TRUE, TRUE, NOW(), ${db.json({ codexSmoke: true, runId, label })}
    )
    RETURNING *
  `;
  fixture.requestIds.push(request.id);
  const [thread] = await db`
    INSERT INTO support_message_threads (request_id, user_key_id, type, last_message_at)
    VALUES (${request.id}, ${client.user_key_id}, 'request', NOW())
    RETURNING *
  `;
  fixture.threadIds.push(thread.id);
  return { request, thread };
}

async function createFixture() {
  const providerEmail = `codex.provider.${shortRunId.toLowerCase()}@example.com`;
  const adminEmail = `codex.admin.${shortRunId.toLowerCase()}@example.com`;
  const clientEmail = `codex.client.${shortRunId.toLowerCase()}@example.com`;

  await ensureGrant(providerEmail, "SUPPORT_PROVIDER_USER", "Codex QA Provider");
  await ensureGrant(adminEmail, "ADMIN_USER", "Codex QA Admin");

  const provider = await upsertUser(providerEmail, "Codex QA Provider", "SUPPORT_PROVIDER_USER");
  const admin = await upsertUser(adminEmail, "Codex QA Admin", "ADMIN_USER");
  const clientUser = await upsertUser(clientEmail, "Codex QA Client", "REGULAR_USER");

  const providerSession = await issueSession(provider);
  const adminSession = await issueSession(admin);
  const clientSession = await issueSession(clientUser);
  const client = await createSupportClient(clientUser);
  const backend = await createRequest(client, "BACKEND", 120);
  const proxy = await createRequest(client, "PROXY", 140);
  const delivery = await createRequest(client, "DELIVERY", 160);
  const milestone = await createRequest(client, "MILESTONE", 180);

  return {
    provider,
    admin,
    clientUser,
    providerSession,
    adminSession,
    clientSession,
    client,
    backend,
    proxy,
    delivery,
    milestone,
  };
}

function file(name, text) {
  return new File([text], name, { type: "text/plain" });
}

async function runFlow(fx) {
  const providerToken = fx.providerSession.accessToken;
  const adminToken = fx.adminSession.accessToken;
  const clientToken = fx.clientSession.accessToken;

  await requestJson({
    label: "backend card alias",
    path: `/api/support/provider/requests/${fx.backend.request.id}/send-card`,
    method: "POST",
    token: providerToken,
    body: {
      kind: "payment",
      amount: Number(fx.backend.request.deposit_amount),
      paymentType: "deposit",
      note: `Backend card smoke ${nowLabel()}`,
    },
    assert: (data) => data?.data?.attachments?.[0]?.kind === "payment_card" || "payment alias did not normalize to payment_card",
  });

  const upload = await requestForm({
    label: "backend provider file upload",
    path: "/api/support/files/upload",
    token: providerToken,
    fields: {
      requestId: fx.backend.request.id,
      threadId: fx.backend.thread.id,
      purpose: "provider_message_upload",
    },
    file: file(`backend-provider-${shortRunId}.txt`, `backend provider upload ${runId}`),
    assert: (data) => Boolean(Array.isArray(data?.data) && data.data[0]?.id) || "upload did not return a file id",
  });
  const backendFile = upload.data.data[0];
  fixture.fileIds.push(backendFile.id);

  await requestJson({
    label: "backend provider file message",
    path: `/api/support/messages/threads/${fx.backend.thread.id}/messages`,
    method: "POST",
    token: providerToken,
    body: {
      content: "Backend provider sent an attached file.",
      attachments: [{
        kind: "file",
        fileId: backendFile.id,
        id: backendFile.id,
        name: backendFile.fileName,
        label: backendFile.fileName,
        url: backendFile.fileUrl,
        type: backendFile.fileType,
        size: backendFile.fileSize,
        purpose: backendFile.purpose,
      }],
      fileReferences: [{
        type: "file",
        id: backendFile.id,
        label: backendFile.fileName,
        meta: backendFile,
      }],
    },
    assert: (data) => data?.data?.attachments?.[0]?.fileId === backendFile.id || "message missing uploaded file attachment",
  });

  await requestJson({
    label: "client reads backend message",
    path: `/api/support/messages/threads/${fx.backend.thread.id}/messages`,
    token: clientToken,
    assert: (data) => data?.data?.some?.((message) => message.attachments?.some?.((item) => item.fileId === backendFile.id)) || "client cannot see provider file message",
  });

  const milestoneCreate = await requestJson({
    label: "provider creates milestone",
    path: `/api/support/provider/requests/${fx.milestone.request.id}/milestones`,
    method: "POST",
    token: providerToken,
    body: {
      title: `Milestone review ${shortRunId}`,
      description: "Live curl milestone delivery regression",
      status: "active",
    },
    assert: (data) => Boolean(data?.data?.id && data.data.status === "active") || "milestone was not created active",
  });
  const milestoneId = milestoneCreate.data.data.id;
  fixture.milestoneIds.push(milestoneId);

  const milestoneUpload = await requestForm({
    label: "provider uploads milestone file",
    path: "/api/support/files/upload",
    token: providerToken,
    fields: {
      requestId: fx.milestone.request.id,
      milestoneId,
      purpose: "milestone_upload",
    },
    file: file(`milestone-${shortRunId}.txt`, `milestone protected file ${runId}`),
    assert: (data) => Boolean(data?.data?.[0]?.milestoneId === milestoneId) || "milestone upload was not linked",
  });
  const milestoneFile = milestoneUpload.data.data[0];
  fixture.fileIds.push(milestoneFile.id);

  await requestJson({
    label: "provider publishes milestone card",
    path: `/api/support/provider/requests/${fx.milestone.request.id}/milestones/${milestoneId}/send-card`,
    method: "POST",
    token: providerToken,
    body: {
      status: "submitted",
      message: "Milestone package is ready for review.",
    },
    assert: (data) => data?.data?.status === "submitted" || "milestone card did not submit milestone",
  });

  await requestJson({
    label: "client reads canonical milestone card",
    path: `/api/support/messages/threads/${fx.milestone.thread.id}/messages`,
    token: clientToken,
    assert: (data) => {
      const card = data?.data?.flatMap?.((message) => message.attachments ?? [])
        ?.find?.((item) => item.kind === "milestone_card" && item.milestoneId === milestoneId);
      if (!card) return "client cannot see milestone card";
      if (card.status !== "submitted") return "milestone card status was not submitted";
      if (!card.files?.some?.((item) => item.fileId === milestoneFile.id || item.id === milestoneFile.id)) {
        return "milestone card missing linked file";
      }
      if (card.files?.[0]?.canDownload !== false) return "milestone card did not mark file as protected";
      return true;
    },
  });

  await requestBytes({
    label: "client blocked from unpaid milestone file",
    path: `/api/support/files/${milestoneFile.id}/download`,
    token: clientToken,
    expected: [402],
    assert: (data) => (data?.code === "PAYMENT_REQUIRED" || data?.errorCode === "PAYMENT_REQUIRED")
      || "milestone file download was not protected before payment",
  });

  await requestJson({
    label: "client accepts milestone",
    path: `/api/support/client/requests/${fx.milestone.request.id}/milestones/${milestoneId}/accept`,
    method: "POST",
    token: clientToken,
    assert: (data) => data?.data?.status === "approved" || "milestone was not approved",
  });

  await requestJson({
    label: "client sees accepted milestone card",
    path: `/api/support/messages/threads/${fx.milestone.thread.id}/messages`,
    token: clientToken,
    assert: (data) => {
      const card = data?.data?.flatMap?.((message) => message.attachments ?? [])
        ?.find?.((item) => item.kind === "milestone_card" && item.milestoneId === milestoneId);
      return card?.status === "approved" || "accepted milestone card was not refreshed";
    },
  });

  const [milestoneEvents] = await db`
    SELECT COUNT(*)::int AS count
    FROM milestone_file_events
    WHERE milestone_id = ${milestoneId}::uuid
  `;
  noteResult({
    label: "milestone file events recorded",
    layer: "database",
    method: "SQL",
    path: "milestone_file_events",
    status: 200,
    ok: Number(milestoneEvents?.count ?? 0) >= 3,
    durationMs: 0,
    success: true,
    assertion: Number(milestoneEvents?.count ?? 0) >= 3 ? "pass" : "missing milestone file events",
    details: { count: Number(milestoneEvents?.count ?? 0) },
  });

  await requestBytes({
    label: "client blocked from unpaid chat file",
    path: `/api/support/files/${backendFile.id}/download`,
    token: clientToken,
    expected: [402],
    assert: (data) => (data?.code === "PAYMENT_REQUIRED" || data?.errorCode === "PAYMENT_REQUIRED")
      || "chat file download was not protected before payment",
  });

  const [backendDepositPayment] = await db`
    INSERT INTO support_payments (
      request_id, user_key_id, payment_type, amount, currency, transaction_id, status
    )
    VALUES (
      ${fx.backend.request.id}, ${fx.clientUser.id}, 'deposit',
      ${Number(fx.backend.request.deposit_amount)}, 'GHS',
      ${`CDX-DEP-${shortRunId}`}, 'submitted'
    )
    RETURNING *
  `;
  fixture.paymentIds.push(backendDepositPayment.id);

  await requestJson({
    label: "admin verifies backend deposit",
    path: `/api/support/admin/requests/${fx.backend.request.id}/verify-payment`,
    method: "POST",
    token: adminToken,
    body: {
      approved: true,
      notes: "Codex protected chat file deposit verification",
    },
    assert: (data) => ["deposit_paid", "paid"].includes(data?.data?.paymentStatus)
      || "deposit verification did not unlock protected request files",
  });

  await requestBytes({
    label: "client downloads paid chat file",
    path: `/api/support/files/${backendFile.id}/download`,
    token: clientToken,
    assert: (data) => Number(data?.bytes ?? 0) > 0 || "download returned no bytes",
  });

  const backendCode = await requestJson({
    label: "backend 100 discount code",
    path: "/api/support/provider/discount-codes",
    method: "POST",
    token: providerToken,
    body: {
      code: `CDX${shortRunId}B100`,
      label: `Codex backend 100 ${runId}`,
      discountPercent: 100,
      maxRedemptions: 1,
    },
    assert: (data) => Number(data?.data?.discountPercent) === 100 && data?.data?.requiresAdminApproval === false
      || "100% code was not active without admin approval",
  });
  fixture.discountCodeIds.push(backendCode.data.data.id);

  await requestJson({
    label: "backend 100 request discount",
    path: `/api/support/provider/requests/${fx.backend.request.id}/discount-decision`,
    method: "POST",
    token: providerToken,
    body: {
      status: "approved",
      discountPercent: 100,
      reason: "Codex backend 100 percent smoke",
    },
    assert: (data) => data?.request?.paymentStatus === "paid" && Number(data?.request?.depositPercent) === 0
      || "100% request discount did not mark request paid with zero deposit",
  });

  await requestJson({
    label: "admin proxy card alias",
    layer: "admin-proxy",
    baseUrl: adminUrl,
    path: `/api/support/provider/requests/${fx.proxy.request.id}/send-card`,
    method: "POST",
    session: fx.providerSession,
    body: {
      kind: "payment",
      amount: Number(fx.proxy.request.deposit_amount),
      paymentType: "deposit",
      note: `Proxy card smoke ${nowLabel()}`,
    },
    assert: (data) => data?.data?.attachments?.[0]?.kind === "payment_card" || "proxy card alias did not normalize",
  });

  const proxyUpload = await requestForm({
    label: "admin proxy provider file upload",
    layer: "admin-proxy",
    baseUrl: adminUrl,
    path: "/api/support/files/upload",
    session: fx.providerSession,
    fields: {
      requestId: fx.proxy.request.id,
      threadId: fx.proxy.thread.id,
      purpose: "provider_message_upload",
    },
    file: file(`proxy-provider-${shortRunId}.txt`, `admin proxy provider upload ${runId}`),
    assert: (data) => Boolean(Array.isArray(data?.data) && data.data[0]?.id) || "proxy upload did not return file id",
  });
  const proxyFile = proxyUpload.data.data[0];
  fixture.fileIds.push(proxyFile.id);

  await requestJson({
    label: "admin proxy provider file message",
    layer: "admin-proxy",
    baseUrl: adminUrl,
    path: `/api/support/messages/threads/${fx.proxy.thread.id}/messages`,
    method: "POST",
    session: fx.providerSession,
    body: {
      content: "Admin proxy provider sent an attached file.",
      attachments: [{
        kind: "file",
        fileId: proxyFile.id,
        id: proxyFile.id,
        name: proxyFile.fileName,
        label: proxyFile.fileName,
        url: proxyFile.fileUrl,
        type: proxyFile.fileType,
        size: proxyFile.fileSize,
        purpose: proxyFile.purpose,
      }],
      fileReferences: [{
        type: "file",
        id: proxyFile.id,
        label: proxyFile.fileName,
        meta: proxyFile,
      }],
    },
    assert: (data) => data?.data?.attachments?.[0]?.fileId === proxyFile.id || "proxy message missing file attachment",
  });

  await requestJson({
    label: "client reads proxy message",
    path: `/api/support/messages/threads/${fx.proxy.thread.id}/messages`,
    token: clientToken,
    assert: (data) => data?.data?.some?.((message) => message.attachments?.some?.((item) => item.fileId === proxyFile.id)) || "client cannot see proxy provider file message",
  });

  const proxyCode = await requestJson({
    label: "admin proxy 100 discount code",
    layer: "admin-proxy",
    baseUrl: adminUrl,
    path: "/api/support/provider/discount-codes",
    method: "POST",
    session: fx.providerSession,
    body: {
      code: `CDX${shortRunId}P100`,
      label: `Codex proxy 100 ${runId}`,
      discountPercent: 100,
      maxRedemptions: 1,
    },
    assert: (data) => Number(data?.data?.discountPercent) === 100 && data?.data?.requiresAdminApproval === false
      || "proxy 100% code was not active without admin approval",
  });
  fixture.discountCodeIds.push(proxyCode.data.data.id);

  await requestJson({
    label: "admin proxy 100 request discount",
    layer: "admin-proxy",
    baseUrl: adminUrl,
    path: `/api/support/provider/requests/${fx.proxy.request.id}/discount-decision`,
    method: "POST",
    session: fx.providerSession,
    body: {
      status: "approved",
      discountPercent: 100,
      reason: "Codex proxy 100 percent smoke",
    },
    assert: (data) => data?.request?.paymentStatus === "paid" && Number(data?.request?.depositPercent) === 0
      || "proxy 100% request discount did not mark request paid with zero deposit",
  });

  const delivery = await requestForm({
    label: "provider final delivery locked",
    path: `/api/support/admin/requests/${fx.delivery.request.id}/deliver`,
    token: providerToken,
    fields: {
      deliveryType: "final",
      deliveryNote: "Final delivery lock smoke",
    },
    file: file(`locked-final-${shortRunId}.txt`, `locked final delivery ${runId}`),
    assert: (data) => data?.request?.paymentStatus === "final_payment_required"
      && data?.request?.deliveryStatus === "uploaded_locked"
      || "final delivery was not locked before payment",
  });
  const deliveryId = delivery.data.data.id;
  fixture.deliveryIds.push(deliveryId);
  fixture.fileIds.push(delivery.data.data.fileId);

  await requestJson({
    label: "client sees locked delivery",
    path: `/api/support/client/requests/${fx.delivery.request.id}/deliveries`,
    token: clientToken,
    assert: (data) => data?.data?.[0]?.canDownload === false && data?.data?.[0]?.downloadUrl === null
      || "client delivery response exposed download before payment",
  });

  await requestBytes({
    label: "client blocked before final payment",
    path: `/api/support/client/requests/${fx.delivery.request.id}/download?deliveryId=${deliveryId}`,
    token: clientToken,
    expected: [402],
    assert: (data) => (data?.code === "PAYMENT_REQUIRED" || data?.errorCode === "PAYMENT_REQUIRED")
      || "download was not blocked with PAYMENT_REQUIRED",
  });

  const [payment] = await db`
    INSERT INTO support_payments (
      request_id, user_key_id, payment_type, amount, currency, transaction_id, status
    )
    VALUES (
      ${fx.delivery.request.id}, ${fx.clientUser.id}, 'full_payment', 160, 'GHS',
      ${`CDX-PAY-${shortRunId}`}, 'submitted'
    )
    RETURNING *
  `;
  fixture.paymentIds.push(payment.id);

  await requestJson({
    label: "admin verifies final payment",
    path: `/api/support/admin/requests/${fx.delivery.request.id}/verify-payment`,
    method: "POST",
    token: adminToken,
    body: {
      approved: true,
      notes: "Codex final payment verification smoke",
    },
    assert: (data) => data?.data?.paymentStatus === "paid" && data?.data?.deliveryStatus === "download_unlocked"
      || "payment verification did not unlock final delivery",
  });

  await requestBytes({
    label: "client downloads after final payment",
    path: `/api/support/client/requests/${fx.delivery.request.id}/download?deliveryId=${deliveryId}`,
    token: clientToken,
    assert: (data, response) => response.status === 200 && Number(data?.bytes ?? 0) > 0 || "download did not return bytes after payment",
  });
}

async function cleanupFixture() {
  if (!cleanupEnabled) return;
    if (fixture.requestIds.length) {
    await db`DELETE FROM milestone_file_events WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_events WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_discount_requests WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_discount_redemptions WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_payments WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_deliveries WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_files WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_message_threads WHERE request_id = ANY(${fixture.requestIds}::uuid[])`;
    await db`DELETE FROM support_requests WHERE id = ANY(${fixture.requestIds}::uuid[])`;
  }
  await db`
    DELETE FROM support_discount_codes
    WHERE code LIKE ${`CDX${shortRunId}%`} OR label LIKE ${`%${runId}%`}
  `;
  await db`DELETE FROM support_clients WHERE email LIKE ${`%${shortRunId.toLowerCase()}@example.com`}`;
  await db`DELETE FROM auth.sessions WHERE user_id = ANY(${fixture.userIds}::uuid[]) OR user_agent = ${`codex-provider-flow-smoke/${runId}`}`;
  await db`DELETE FROM auth.privileged_access_grants WHERE email LIKE ${`%${shortRunId.toLowerCase()}@example.com`}`;
  await db`DELETE FROM auth.users WHERE email LIKE ${`%${shortRunId.toLowerCase()}@example.com`}`;
}

let before;
let withFixture;
let fixtureCreated;
let after;
let exitCode = 0;

try {
  before = await countSupportRows();
  const fx = await createFixture();
  fixtureCreated = await countSupportRows();
  await runFlow(fx);
  withFixture = await countSupportRows();
} catch (error) {
  exitCode = 1;
  console.error("\nPROVIDER_FLOW_SMOKE_FAILED");
  console.error(error instanceof Error ? error.stack || error.message : error);
} finally {
  try {
    await cleanupFixture();
  } finally {
    after = await countSupportRows();
    printResultTable();
    printStatsTable(before ?? {}, withFixture ?? {}, after ?? {});
    console.log("\nSUMMARY_JSON");
    console.log(JSON.stringify({
      ok: exitCode === 0,
      runId,
      backendUrl,
      adminUrl,
      dbTarget: dbTarget || "default",
      cleanupEnabled,
      results,
      stats: { before, fixtureCreated, withFixture, after },
    }, jsonReplacer, 2));
    await closeDb();
  }
}

process.exit(exitCode);
