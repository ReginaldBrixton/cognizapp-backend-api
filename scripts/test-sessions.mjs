const BASE = "http://localhost:4040";
const SECRET = process.env.DEV_AUTH_ENDPOINT_SECRET;
if (!SECRET) {
  console.error("Set DEV_AUTH_ENDPOINT_SECRET env var before running this script.");
  process.exit(1);
}

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/dev/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dev-Auth-Secret": SECRET },
    body: JSON.stringify({ email }),
  });
  return res.json();
}

async function getSessions(token) {
  const res = await fetch(`${BASE}/api/auth/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function logout(token) {
  const res = await fetch(`${BASE}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function revokeSession(token, sessionId) {
  const res = await fetch(`${BASE}/api/auth/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
console.log("=== SESSION MANAGEMENT TEST ===\n");

// Test 1: Login as user 1 (first session)
console.log("1. Login as reginaldbrixton@gmail.com (session 1)");
const login1 = await login("reginaldbrixton@gmail.com");
console.log("   Session ID:", login1.sessionId);
console.log("   Status:", login1.success ? "✅" : "❌");

// Test 2: Login as user 1 again (second session)
console.log("\n2. Login again (session 2)");
const login2 = await login("reginaldbrixton@gmail.com");
console.log("   Session ID:", login2.sessionId);
console.log("   Different from session 1:", login2.sessionId !== login1.sessionId ? "✅" : "❌");

// Test 3: Check sessions
console.log("\n3. Check active sessions");
const sessions1 = await getSessions(login1.accessToken);
console.log("   Active sessions:", sessions1.sessions?.length);
const s1 = sessions1.sessions?.find((s) => s.id === login1.sessionId);
const s2 = sessions1.sessions?.find((s) => s.id === login2.sessionId);
console.log("   Session 1 active:", s1?.isCurrent ? "✅ (current)" : "❌");
console.log("   Session 2 active:", s2 && !s2.isRevoked ? "✅" : "❌");

// Test 4: Logout from session 2
console.log("\n4. Logout from session 2");
const logoutResult = await logout(login2.accessToken);
console.log("   Result:", logoutResult.message);

// Test 5: Check sessions after logout
console.log("\n5. Check sessions after logout");
const sessions2 = await getSessions(login1.accessToken);
console.log("   Active sessions:", sessions2.sessions?.length);
const s1After = sessions2.sessions?.find((s) => s.id === login1.sessionId);
const s2After = sessions2.sessions?.find((s) => s.id === login2.sessionId);
console.log("   Session 1 still active:", s1After?.isCurrent ? "✅" : "❌");
console.log("   Session 2 revoked:", !s2After ? "✅ (cleaned up)" : s2After?.isRevoked ? "✅ (revoked)" : "❌");

// Test 6: Try to use revoked session
console.log("\n6. Try to use revoked session 2");
const revokedTest = await fetch(`${BASE}/api/auth/me`, {
  headers: { Authorization: `Bearer ${login2.accessToken}` },
});
console.log("   Status:", revokedTest.status === 401 ? "✅ (rejected)" : "❌ (still works)");

// Test 7: Login as another user
console.log("\n7. Login as different user");
const login3 = await login("emmanuelreginaldquansah@gmail.com");
console.log("   Session ID:", login3.sessionId);
console.log("   User:", login3.email);
console.log("   Different user sessions isolated:", login3.userId !== login1.userId ? "✅" : "❌");

// Test 8: Check user 2 sessions
console.log("\n8. Check user 2 sessions");
const sessions3 = await getSessions(login3.accessToken);
console.log("   Active sessions:", sessions3.sessions?.length);
console.log("   Can't see user 1 sessions:", sessions3.sessions?.every((s) => s.userId === login3.userId) ? "✅" : "❌");

// Test 9: Dashboard stats after sessions
console.log("\n9. Dashboard stats consistency");
const dashboard = await fetch(`${BASE}/api/user/dashboard/stats`, {
  headers: { Authorization: `Bearer ${login1.accessToken}` },
});
const dashData = await dashboard.json();
console.log("   Active sessions in stats:", dashData.stats?.active_sessions);
console.log("   Dashboard working:", dashboard.status === 200 ? "✅" : "❌");

// Test 10: Workspace ownership check
console.log("\n10. Workspace ownership check");
const workspaces = await fetch(`${BASE}/api/user/workspace`, {
  headers: { Authorization: `Bearer ${login1.accessToken}` },
});
const wsData = await workspaces.json();
console.log("   Workspaces:", wsData.workspaces?.length);
console.log("   All owned by user:", wsData.workspaces?.every((w) => w.ownerUid === login1.userId) ? "✅" : "❌ (some are member workspaces)");

console.log("\n=== TEST COMPLETE ===");
