import type { CanonicalRole } from "./policy";
import { roleHierarchy as canonicalRoleHierarchy } from "./policy";

export type AppMetadata = {
  provider?: string;
  providers?: string[];
};

export type UserRecord = {
  id: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  role: string;
  status: string;
  bannedUntil: string | null;
  isAnonymous: boolean;
  isSsoUser: boolean;
  displayName: string;
  fullName: string;
  avatarUrl: string;
  appMetadata: AppMetadata | null;
  userMetadata: Record<string, unknown> | null;
  providers: string[];
  provider: string;
  providerUid: string;
  identityData: Record<string, unknown> | null;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  lastSignInAt: string | null;
  loginCount: number;
  failedLogins: number;
  lockedUntil: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  email: string;
  role: string;
  tokenHash: string;
  refreshTokenHash: string;
  expiresAt: Date;
  refreshExpiresAt: Date | null;
  ipAddress: string;
  userAgent: string;
  deviceFingerprint: string | null;
  deviceName: string | null;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  isRevoked: boolean;
  revokedAt: Date | null;
  revokedReason: string | null;
  reuseDetectedAt: Date | null;
  createdAt: Date;
  lastActive: Date | null;
};

export type AuthAction = "login" | "register";

export type ExchangeResponse = {
  success: boolean;
  userId?: string;
  user_id?: string;
  email?: string;
  displayName?: string;
  display_name?: string;
  avatarUrl?: string;
  avatar_url?: string;
  role?: string;
  provider?: string;
  sessionId?: string;
  session_id?: string;
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number;
  expires_in?: number;
  expiresAt?: number;
  expires_at?: number;
  isNewUser?: boolean;
  is_new_user?: boolean;
  authAction?: AuthAction;
  auth_action?: AuthAction;
  simulated?: boolean;
  error?: string;
  errorCode?: string;
  error_code?: string;
};

export type Role = CanonicalRole;

export const roleHierarchy: Record<string, number> = canonicalRoleHierarchy;
