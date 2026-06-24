import { Elysia } from "elysia";

const paystackCheckoutPage = Bun.file(new URL("./index.html", import.meta.url));

function html(title: string, body: string) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#ffffff; --ink:#171a1f; --muted:#626b7a; --line:#d9dee7; --accent:#0f766e; --danger:#b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--bg); color: var(--ink); }
    header { padding: 20px 28px; background: #ffffff; border-bottom: 1px solid var(--line); display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
    header strong { font-size: 18px; }
    nav { display:flex; gap:8px; flex-wrap:wrap; }
    nav a, button, input, textarea, select { font: inherit; }
    nav a, button { border:1px solid var(--line); background:#fff; color:var(--ink); padding:8px 10px; border-radius:6px; text-decoration:none; cursor:pointer; }
    button.primary { background: var(--accent); color:#fff; border-color: var(--accent); }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; display:grid; gap:16px; }
    section, form { background: var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    h1, h2 { margin: 0 0 12px; }
    h1 { font-size: 24px; }
    h2 { font-size: 18px; }
    label { display:grid; gap:6px; color:var(--muted); margin: 10px 0; }
    input, textarea, select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px 10px; background:#fff; color:var(--ink); }
    textarea { min-height: 120px; resize: vertical; font-family: Consolas, monospace; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:16px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .muted { color:var(--muted); }
    .danger { color:var(--danger); }
    pre { margin:0; overflow:auto; background:#101828; color:#f7fafc; border-radius:8px; padding:14px; min-height:160px; }
    code { font-family: Consolas, monospace; }
  </style>
</head>
<body>
  <header>
    <strong>CognizAP API Test Console</strong>
    <nav>
      <a href="/testing/">Home</a>
      <a href="/testing/auth.html">Auth</a>
      <a href="/testing/user.html">User</a>
      <a href="/testing/workspace.html">Workspace</a>
      <a href="/testing/projects.html">Projects</a>
      <a href="/testing/content.html">Content</a>
      <a href="/testing/admin.html">Admin</a>
      <a href="/testing/paystack.html">Paystack</a>
    </nav>
  </header>
  <main>${body}</main>
  <script src="/testing/client.js"></script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const home = html("CognizAP API Test Console", `
<section>
  <h1>Live API Testing Pages</h1>
  <p class="muted">Use these pages against the running local server. Tokens are stored in this browser only through localStorage.</p>
  <div class="grid">
    <section><h2>Authentication</h2><p>Email OTP, dev token, refresh, sessions, logout.</p><a href="/testing/auth.html">Open auth tests</a></section>
    <section><h2>User Experience</h2><p>Dashboard, profile, notifications, and user settings.</p><a href="/testing/user.html">Open user tests</a></section>
    <section><h2>Workspace</h2><p>Workspace create/read/update/delete, members, invitations, settings, storage checks.</p><a href="/testing/workspace.html">Open workspace tests</a></section>
    <section><h2>Project + Content</h2><p>Projects, documents, comments, slides, notes, tasks, task lists, diagrams.</p><a href="/testing/projects.html">Open project tests</a></section>
  </div>
</section>`);

const auth = html("Auth Testing", `
<section>
  <h1>Authentication</h1>
  <p class="muted">Request an email login code, verify it, then use the issued CognizApp session tokens.</p>
</section>
<div class="grid">
  <form data-action="otp-request">
    <h2>Email OTP Request</h2>
    <label>Email<input name="email" type="email"></label>
    <button class="primary">Send Code</button>
  </form>
  <form data-action="otp-verify">
    <h2>Email OTP Verify</h2>
    <label>Email<input name="email" type="email"></label>
    <label>Code<input name="code" inputmode="numeric" maxlength="6"></label>
    <button class="primary">Verify Code</button>
  </form>
  <form data-action="dev-login">
    <h2>Development Login</h2>
    <label>Dev secret<input name="secret" type="password" autocomplete="off"></label>
    <label>User email<input name="email" type="email"></label>
    <button class="primary">Create Simulated Session</button>
  </form>
</div>
<div class="grid">
  <section><h2>Session Controls</h2><div class="row">
    <button data-call="GET /api/auth/health">Auth Health</button>
    <button data-call="GET /api/auth/me" data-auth="true">Me</button>
    <button data-call="GET /api/auth/sessions" data-auth="true">Sessions</button>
    <button data-action="refresh">Refresh</button>
    <button data-call="POST /api/auth/logout" data-auth="true">Logout</button>
    <button data-call="POST /api/auth/logout-all?keep_current=true" data-auth="true">Logout Others</button>
  </div></section>
</div>
<section><h2>Response</h2><pre id="output"></pre></section>`);

const user = html("User Endpoint Testing", `
<section><h1>User Endpoints</h1><p class="muted">Run these after signing in on the auth page.</p></section>
<div class="grid">
  <section><h2>Dashboard</h2><div class="row">
    <button data-call="GET /api/user/dashboard" data-auth="true">Dashboard</button>
    <button data-call="GET /api/user/dashboard/stats" data-auth="true">Stats</button>
    <button data-call="POST /api/user/dashboard/stats/refresh" data-auth="true">Refresh Stats</button>
  </div></section>
  <section><h2>Notifications</h2><div class="row">
    <button data-call="GET /api/user/notifications" data-auth="true">List</button>
    <button data-call="GET /api/user/notifications/unread-count" data-auth="true">Unread Count</button>
    <button data-call="POST /api/user/notifications/read-all" data-auth="true">Read All</button>
  </div></section>
</div>
<div class="grid">
  <form data-action="api-form"><h2>Settings Section</h2><input type="hidden" name="method" value="GET"><label>Path<input name="path" value="/api/user/settings/appearance"></label><button>Get Section</button></form>
  <form data-action="api-form"><h2>Update Settings</h2><input type="hidden" name="method" value="PUT"><label>Path<input name="path" value="/api/user/settings"></label><label>JSON body<textarea name="body">{"appearance":{"theme":"dark","accent_color":"#0f766e"}}</textarea></label><button class="primary">Update</button></form>
</div>
<section><h2>Response</h2><pre id="output"></pre></section>`);

const workspace = html("Workspace Endpoint Testing", `
<section><h1>Workspace Endpoints</h1><p class="muted">Use Default Workspace first to fill the workspace id automatically.</p></section>
<div class="grid">
  <section><h2>Workspace</h2><div class="row">
    <button data-call="GET /api/user/workspace" data-auth="true">List</button>
    <button data-action="default-workspace">Default Workspace</button>
  </div><label>Workspace ID<input id="workspaceId" placeholder="uuid"></label></section>
  <form data-action="api-form"><h2>Create Workspace</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="path" value="/api/user/workspace"><label>JSON body<textarea name="body">{"name":"Browser Test Workspace","description":"Created from the testing page","color":"#0f766e"}</textarea></label><button class="primary">Create</button></form>
  <form data-action="workspace-path"><h2>Update Workspace</h2><input type="hidden" name="method" value="PUT"><input type="hidden" name="template" value="/api/user/workspace/details?id={workspaceId}"><label>JSON body<textarea name="body">{"name":"Browser Test Workspace Updated"}</textarea></label><button>Update</button></form>
  <form data-action="workspace-path"><h2>Members</h2><input type="hidden" name="method" value="GET"><input type="hidden" name="template" value="/api/user/workspace/members?workspace_id={workspaceId}"><button>List Members</button></form>
  <form data-action="workspace-path"><h2>Workspace Settings</h2><input type="hidden" name="method" value="PUT"><input type="hidden" name="template" value="/api/user/workspace/settings?workspace_id={workspaceId}"><label>JSON body<textarea name="body">{"notifications":{"enabled":true,"digest_frequency":"weekly"}}</textarea></label><button>Update Settings</button></form>
  <form data-action="workspace-path"><h2>Quota Check</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/user/workspace/{workspaceId}/storage/check-quota"><label>JSON body<textarea name="body">{"additionalBytes":1024}</textarea></label><button>Check</button></form>
</div>
<section><h2>Response</h2><pre id="output"></pre></section>`);

const projects = html("Project Endpoint Testing", `
<section><h1>Project Endpoints</h1><label>Workspace ID<input id="workspaceId" placeholder="uuid"></label><label>Project ID<input id="projectId" placeholder="uuid"></label></section>
<div class="grid">
  <form data-action="workspace-path"><h2>Create Project</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects"><label>JSON body<textarea name="body">{"title":"Browser Test Project","description":"Project testing flow","visibility":"private","keywords":["test"]}</textarea></label><button class="primary">Create</button></form>
  <form data-action="workspace-path"><h2>List Projects</h2><input type="hidden" name="method" value="GET"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects"><button>List</button></form>
  <form data-action="workspace-project-path"><h2>Project Dashboard</h2><input type="hidden" name="method" value="GET"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}/dashboard"><button>Dashboard</button></form>
  <form data-action="workspace-project-path"><h2>Update Project</h2><input type="hidden" name="method" value="PUT"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}"><label>JSON body<textarea name="body">{"title":"Browser Test Project Updated"}</textarea></label><button>Update</button></form>
</div>
<section><h2>Response</h2><pre id="output"></pre></section>`);

const content = html("Content Endpoint Testing", `
<section><h1>Content Endpoints</h1><label>Workspace ID<input id="workspaceId" placeholder="uuid"></label><label>Project ID<input id="projectId" placeholder="uuid"></label><label>Resource ID<input id="resourceId" placeholder="uuid"></label></section>
<div class="grid">
  <form data-action="workspace-project-path"><h2>Create Document</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}/documents"><label>JSON body<textarea name="body">{"title":"Browser Test Document","content":"Hello from a live browser test."}</textarea></label><button class="primary">Create</button></form>
  <form data-action="workspace-project-path"><h2>Create Note</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}/notes"><label>JSON body<textarea name="body">{"title":"Browser Test Note","content":"A note from the testing console."}</textarea></label><button>Create</button></form>
  <form data-action="workspace-project-path"><h2>Create Task</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}/tasks"><label>JSON body<textarea name="body">{"title":"Browser Test Task","description":"Exercise task creation"}</textarea></label><button>Create</button></form>
  <form data-action="workspace-project-path"><h2>Humanise Analysis</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/analysis/humanise"><label>JSON body<textarea name="body">{"title":"Humanise Sample","originalText":"This is a concise sample for analysis."}</textarea></label><button>Run</button></form>
  <form data-action="workspace-project-path"><h2>Create Diagram</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}/diagrams"><label>JSON body<textarea name="body">{"title":"Browser Test Diagram","diagramType":"flowchart","content":"graph TD; A-->B;"}</textarea></label><button>Create</button></form>
  <form data-action="workspace-project-path"><h2>Create Task List</h2><input type="hidden" name="method" value="POST"><input type="hidden" name="template" value="/api/workspace/{workspaceId}/projects/{projectId}/task-lists"><label>JSON body<textarea name="body">{"name":"Browser Test List"}</textarea></label><button>Create</button></form>
</div>
<section><h2>Response</h2><pre id="output"></pre></section>`);

const admin = html("Admin Endpoint Testing", `
<section><h1>Admin, Support, and Provider Sync</h1><p class="muted">These endpoints require elevated roles and should return 403 for normal users.</p></section>
<div class="grid">
  <section><h2>Admin</h2><div class="row">
    <button data-call="GET /api/admin/users" data-auth="true">Users</button>
    <button data-call="GET /api/admin/permissions" data-auth="true">Permissions</button>
    <button data-call="GET /api/admin/stats" data-auth="true">Stats</button>
  </div></section>
  <section><h2>Support</h2><div class="row">
    <button data-call="GET /api/support/users" data-auth="true">Support Users</button>
  </div></section>
</div>
<section><h2>Response</h2><pre id="output"></pre></section>`);

const paystack = html("Paystack Checkout Testing", `
<section>
  <h1>Paystack Checkout Test</h1>
  <p class="muted">This page uses the backend Paystack test key only. The browser never receives the secret key.</p>
</section>
<div class="grid">
  <form data-action="dev-login">
    <h2>1. Local Test Login</h2>
    <label>Dev secret<input name="secret" type="password" autocomplete="off" placeholder="Enter DEV_AUTH_ENDPOINT_SECRET"></label>
    <label>User email<input name="email" type="email" value="reginaldbrixton@gmail.com"></label>
    <button class="primary">Create Session</button>
  </form>
  <form data-action="paystack-create-request">
    <h2>2. Create Test Request</h2>
    <label>Title<input name="title" value="Paystack mobile money smoke test"></label>
    <label>Amount (GHS)<input name="amount" type="number" min="1" step="0.01" value="1"></label>
    <button class="primary">Create Request</button>
  </form>
</div>
<div class="grid">
  <form data-action="paystack-mobile-money">
    <h2>3. Send Direct Mobile Money Prompt</h2>
    <label>Support request id<input id="paystackRequestId" name="requestId" placeholder="Create a request first or paste an existing id"></label>
    <label>Phone number<input name="phone" inputmode="tel" placeholder="e.g. 0551234987"></label>
    <label>Network<select name="provider"><option value="mtn">MTN Mobile Money</option><option value="telecel">Telecel Cash</option></select></label>
    <label>Payment type<select name="paymentType"><option value="full_payment">Full payment</option><option value="deposit">Deposit</option><option value="final_balance">Final balance</option></select></label>
    <label>Amount override (GHS)<input name="amount" type="number" min="1" step="0.01" value="1"></label>
    <button class="primary">Send Paystack Charge</button>
  </form>
  <form data-action="paystack-verify">
    <h2>4. Verify Payment</h2>
    <label>Support request id<input id="paystackVerifyRequestId" name="requestId" placeholder="Filled after charge"></label>
    <label>Paystack reference<input id="paystackReference" name="reference" placeholder="Filled after charge"></label>
    <button>Verify Reference</button>
  </form>
</div>
<section>
  <h2>Response</h2>
  <pre id="output"></pre>
</section>`);

const clientJs = `
const output = document.getElementById("output");
function show(value) { if (output) output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function token() { return localStorage.getItem("cognizap_access_token") || ""; }
function refreshToken() { return localStorage.getItem("cognizap_refresh_token") || ""; }
function saveAuth(body) {
  const access = body.accessToken || body.access_token;
  const refresh = body.refreshToken || body.refresh_token;
  if (access) localStorage.setItem("cognizap_access_token", access);
  if (refresh) localStorage.setItem("cognizap_refresh_token", refresh);
}
async function request(method, path, body, auth = true, headers = {}) {
  const options = { method, headers: { ...headers } };
  if (auth && token()) options.headers.Authorization = "Bearer " + token();
  if (body !== undefined && body !== "") {
    options.headers["Content-Type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(path, options);
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, body: parsed };
}
function parseBody(form) {
  const value = form.elements.body?.value;
  if (!value) return undefined;
  JSON.parse(value);
  return value;
}
function field(id) { return document.getElementById(id)?.value?.trim() || ""; }
function fillIdsFromBody(body) {
  const value = body?.workspace?.id || body?.id || body?.project?.id;
  if (body?.workspace?.id && document.getElementById("workspaceId")) document.getElementById("workspaceId").value = body.workspace.id;
  if ((body?.project?.id || body?.id) && document.getElementById("projectId")) document.getElementById("projectId").value = body.project?.id || body.id;
}
async function runForm(form, path) {
  const method = form.elements.method?.value || "GET";
  const body = parseBody(form);
  const result = await request(method, path, body, true);
  fillIdsFromBody(result.body);
  show(result);
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-call],button[data-action]");
  if (!button || button.form) return;
  event.preventDefault();
  try {
    const call = button.dataset.call;
    if (call) {
      const [method, ...parts] = call.split(" ");
      show(await request(method, parts.join(" "), undefined, button.dataset.auth === "true"));
      return;
    }
    if (button.dataset.action === "refresh") {
      const result = await request("POST", "/api/auth/refresh", { refreshToken: refreshToken() }, false);
      if (result.body && typeof result.body === "object") saveAuth(result.body);
      show(result);
      return;
    }
    if (button.dataset.action === "default-workspace") {
      const result = await request("GET", "/api/user/workspace/default", undefined, true);
      fillIdsFromBody(result.body);
      show(result);
    }
  } catch (error) { show(String(error.stack || error)); }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  try {
    const action = form.dataset.action;
    if (action === "otp-request") {
      show(await request("POST", "/api/auth/otp/request", { email: form.elements.email.value }, false));
      return;
    }
    if (action === "otp-verify") {
      const result = await request("POST", "/api/auth/otp/verify", { email: form.elements.email.value, code: form.elements.code.value }, false);
      if (result.body && typeof result.body === "object") saveAuth(result.body);
      show(result);
      return;
    }
    if (action === "dev-login") {
      const result = await request("POST", "/api/auth/dev/token", { email: form.elements.email.value }, false, { "x-dev-auth-secret": form.elements.secret.value });
      if (result.body && typeof result.body === "object") saveAuth(result.body);
      show(result);
      return;
    }
    if (action === "paystack-create-request") {
      const amount = Number(form.elements.amount.value || "1");
      const result = await request("POST", "/api/support/client/requests", {
        title: form.elements.title.value,
        description: "Temporary request for Paystack mobile money testing.",
        serviceTags: ["proposal-review"],
        academicLevel: "undergraduate",
        subject: "Payment testing",
        budgetMin: amount,
        currency: "GHS",
        paymentMode: "before_work",
        integrityAck: true,
        contactConsent: true,
      }, true);
      const id = result.body?.data?.id;
      if (id) {
        const requestId = document.getElementById("paystackRequestId");
        const verifyRequestId = document.getElementById("paystackVerifyRequestId");
        if (requestId) requestId.value = id;
        if (verifyRequestId) verifyRequestId.value = id;
      }
      show(result);
      return;
    }
    if (action === "paystack-mobile-money") {
      const requestId = form.elements.requestId.value.trim();
      const result = await request("POST", "/api/support/client/requests/" + encodeURIComponent(requestId) + "/paystack/mobile-money", {
        phone: form.elements.phone.value.trim(),
        provider: form.elements.provider.value,
        paymentType: form.elements.paymentType.value,
        amount: Number(form.elements.amount.value || "0") || undefined,
      }, true);
      const reference = result.body?.data?.transactionId || result.body?.data?.transaction_id;
      if (reference) {
        const refInput = document.getElementById("paystackReference");
        const verifyRequestId = document.getElementById("paystackVerifyRequestId");
        if (refInput) refInput.value = reference;
        if (verifyRequestId) verifyRequestId.value = requestId;
      }
      show(result);
      return;
    }
    if (action === "paystack-verify") {
      const requestId = form.elements.requestId.value.trim();
      show(await request("POST", "/api/support/client/requests/" + encodeURIComponent(requestId) + "/paystack/verify", {
        reference: form.elements.reference.value.trim(),
      }, true));
      return;
    }
    if (action === "api-form") {
      await runForm(form, form.elements.path.value);
      return;
    }
    if (action === "workspace-path" || action === "workspace-project-path") {
      const path = form.elements.template.value
        .replaceAll("{workspaceId}", encodeURIComponent(field("workspaceId")))
        .replaceAll("{projectId}", encodeURIComponent(field("projectId")))
        .replaceAll("{resourceId}", encodeURIComponent(field("resourceId")));
      await runForm(form, path);
    }
  } catch (error) { show(String(error.stack || error)); }
});
show({ accessTokenPresent: Boolean(token()), pages: "Use Auth first, then run endpoint pages." });
`;

export const testingRoutes = new Elysia({ prefix: "/testing" })
  .get("/", () => home)
  .get("/index.html", () => paystackCheckoutPage)
  .get("/auth.html", () => auth)
  .get("/user.html", () => user)
  .get("/workspace.html", () => workspace)
  .get("/projects.html", () => projects)
  .get("/content.html", () => content)
  .get("/admin.html", () => admin)
  .get("/paystack.html", () => paystack)
  .get("/client.js", () => new Response(clientJs, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  }));
