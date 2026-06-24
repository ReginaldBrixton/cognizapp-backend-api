import { config as loadDotenv } from "dotenv";
import { closeDb, getDb } from "../src/lib/db";
import { signAccessToken, signRefreshToken, hashToken } from "../src/lib/crypto";

loadDotenv();

const db = getDb();

async function createToken() {
  const userId = "15058b61-c181-40dd-b631-a44535116389";
  const email = "reginaldbrixton@gmail.com";
  const role = "master";

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Create session
  const [session] = await db`
    INSERT INTO auth.sessions (user_id, email, role, token_hash, refresh_token_hash, expires_at, refresh_expires_at, ip_address, user_agent)
    VALUES (${userId}, ${email}, ${role}, 'temp', 'temp', ${expiresAt}, ${refreshExpiry}, '127.0.0.1', 'test')
    RETURNING id
  `;

  const sessionId = String(session.id);

  // Create tokens
  const accessToken = await signAccessToken({ userId, sessionId, role, email });
  const refreshToken = await signRefreshToken({ userId, sessionId });

  // Update session with actual token hashes
  await db`
    UPDATE auth.sessions
    SET token_hash = ${hashToken(accessToken)}, refresh_token_hash = ${hashToken(refreshToken)}
    WHERE id = ${sessionId}
  `;

  console.log("Access Token:", accessToken);

  await closeDb();
}

createToken().catch(console.error);