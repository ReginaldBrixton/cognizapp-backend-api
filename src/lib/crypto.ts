import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import { env } from "../config/env";

export type AccessClaims = {
  userId: string;
  sessionId: string;
  role: string;
  email: string;
  deviceFingerprint?: string;
};

export type RefreshClaims = {
  userId: string;
  sessionId: string;
};

function getSecret() {
  return new TextEncoder().encode(env.jwtSecret);
}

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualString(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function randomToken(size = 32) {
  return randomBytes(size).toString("hex");
}

export function deviceFingerprint(input: string) {
  return hashToken(input);
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const payload: Record<string, unknown> = {
    uid: claims.userId,
    sid: claims.sessionId,
    role: claims.role,
    email: claims.email,
  };
  if (claims.deviceFingerprint) {
    payload.dfp = claims.deviceFingerprint;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(env.jwtIssuer)
    .setAudience(env.jwtAudience)
    .setExpirationTime(`${env.jwtAccessExpiryMinutes}m`)
    .setIssuedAt()
    .sign(getSecret());
}

export async function signRefreshToken(claims: RefreshClaims): Promise<string> {
  return new SignJWT({ uid: claims.userId, sid: claims.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(env.jwtIssuer)
    .setAudience(`${env.jwtAudience}-refresh`)
    .setExpirationTime(`${env.jwtRefreshExpiryDays}d`)
    .setIssuedAt()
    .sign(getSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
    algorithms: ["HS256"],
  });
  return {
    userId: String(payload.uid),
    sessionId: String(payload.sid),
    role: String(payload.role),
    email: String(payload.email),
    deviceFingerprint: payload.dfp ? String(payload.dfp) : undefined,
  };
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: env.jwtIssuer,
    audience: `${env.jwtAudience}-refresh`,
    algorithms: ["HS256"],
  });
  return {
    userId: String(payload.uid),
    sessionId: String(payload.sid),
  };
}
