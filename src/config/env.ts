// dotenv removed — Vercel sets env vars directly in production.
// For local dev, Bun automatically loads .env files.

export type AppEnv = {
  environment: string;
  isDevelopment: boolean;
  isProduction: boolean;
  port: number;
  localTestingPath: string;
  databaseUrl: string;
  databaseUrlDev: string;
  databaseUrlProd: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtAccessExpiryMinutes: number;
  jwtRefreshExpiryDays: number;
  strictDeviceFingerprint: boolean;
  masterUserEmail: string;
  masterUserId: string;
  defaultAdminEmails: string[];
  authExchangeRateLimit: number;
  otpCodeExpiryMinutes: number;
  otpMaxAttempts: number;
  otpResendCooldownSeconds: number;
  otpRateLimitPerMinute: number;
  devAuthEndpointEnabled: boolean;
  devAuthEndpointSecret: string;
  devImpersonationEnabled: boolean;
  devImpersonationSecret: string;
  devImpersonationAllowPrivileged: boolean;
  devImpersonationAllowedEmails: string[];
  n8nGmailSendWebhookUrl: string;
  n8nWebhookSecret: string;
  n8nWebhookTimeoutMs: number;
  wahaBaseUrl: string;
  wahaApiKey: string;
  wahaSession: string;
  redisUrl: string;
  redisHost: string;
  redisPort: number;
  redisUser: string;
  redisPassword: string;
  redisTls: boolean;
  redisKeyPrefix: string;
  paystackSecretKey: string;
  paystackBaseUrl: string;
  uploadthingToken: string;
  firebaseProjectId: string;
  firebaseCredentialsBase64: string;
  googleServiceAccountJson: string;
};

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function getBoolean(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  return raw.toLowerCase() === "true";
}

function getPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim() ?? fallback;
  if (!value.startsWith("/")) {
    throw new Error(`Environment variable ${name} must start with "/"`);
  }
  return value;
}

function getEmailList(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name]?.trim();
  const values = raw ? raw.split(",") : fallback;
  return values.map((email) => email.trim().toLowerCase()).filter(Boolean);
}

function getDatabaseName(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.pathname.replace(/^\//, "");
  } catch {
    throw new Error("Database URL must be a valid PostgreSQL connection URL");
  }
}

function assertCognizAppDatabase(name: string, databaseUrl: string) {
  const databaseName = getDatabaseName(databaseUrl);
  if (databaseName !== "cognizap") {
    throw new Error(
      `${name} must point to the cognizap database, not ${databaseName || "an empty database name"}`,
    );
  }
}

function createEnv(): AppEnv {
  const environment = (
    process.env.ENVIRONMENT ??
    process.env.NODE_ENV ??
    "development"
  ).toLowerCase();
  const isDevelopment = environment === "development";
  const isProduction = environment === "production";
  const databaseUrlDev = getEnv("DATABASE_URL_DEV", process.env.POSTGRES_AUTH_URI);
  const databaseUrlProd = getEnv(
    "DATABASE_URL_PROD",
    process.env.POSTGRES_AUTH_URI_PROD ?? databaseUrlDev,
  );
  const defaultLocalTestingPath =
    "/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test";

  const envObj: AppEnv = {
    environment,
    isDevelopment,
    isProduction,
    port: getNumber("PORT", 4040),
    localTestingPath: getPath("LOCAL_TEST_ENDPOINT_PATH", defaultLocalTestingPath),
    databaseUrl: getEnv("DATABASE_URL", isProduction ? databaseUrlProd : databaseUrlDev),
    databaseUrlDev,
    databaseUrlProd,
    jwtSecret: getEnv("JWT_SECRET"),
    jwtIssuer: getEnv("JWT_ISSUER", "cognizap"),
    jwtAudience: getEnv("JWT_AUDIENCE", "cognizap-api"),
    jwtAccessExpiryMinutes: getNumber("JWT_ACCESS_EXPIRY_MINUTES", 15),
    jwtRefreshExpiryDays: getNumber("JWT_REFRESH_EXPIRY_DAYS", 30),
    strictDeviceFingerprint: getBoolean("STRICT_DEVICE_FINGERPRINT"),
    masterUserEmail: process.env.MASTER_USER_EMAIL ?? "",
    masterUserId: process.env.MASTER_USER_ID ?? "",
    defaultAdminEmails: getEmailList("DEFAULT_ADMIN_EMAILS", [
      "reginaldbrixton@gmail.com",
      "cognizap.ai@gmail.com",
    ]),
    authExchangeRateLimit: getNumber("AUTH_EXCHANGE_RATE_LIMIT", 10),
    otpCodeExpiryMinutes: getNumber("OTP_CODE_EXPIRY_MINUTES", 10),
    otpMaxAttempts: getNumber("OTP_MAX_ATTEMPTS", 5),
    otpResendCooldownSeconds: getNumber("OTP_RESEND_COOLDOWN_SECONDS", 60),
    otpRateLimitPerMinute: getNumber("OTP_RATE_LIMIT_PER_MINUTE", 10),
    devAuthEndpointEnabled: getBoolean("DEV_AUTH_ENDPOINT_ENABLED", false),
    devAuthEndpointSecret: process.env.DEV_AUTH_ENDPOINT_SECRET ?? "",
    devImpersonationEnabled: getBoolean("DEV_IMPERSONATION_ENABLED", false),
    devImpersonationSecret: process.env.DEV_IMPERSONATION_SECRET?.trim() ?? "",
    devImpersonationAllowPrivileged: getBoolean("DEV_IMPERSONATION_ALLOW_PRIVILEGED", false),
    devImpersonationAllowedEmails: (process.env.DEV_IMPERSONATION_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    n8nGmailSendWebhookUrl: process.env.N8N_GMAIL_SEND_WEBHOOK_URL?.trim() ?? "",
    n8nWebhookSecret: process.env.N8N_WEBHOOK_SECRET?.trim() ?? "",
    n8nWebhookTimeoutMs: getNumber("N8N_WEBHOOK_TIMEOUT_MS", 15000),
    wahaBaseUrl: process.env.WAHA_BASE_URL?.trim() ?? "",
    wahaApiKey: process.env.WAHA_API_KEY?.trim() ?? "",
    wahaSession: process.env.WAHA_SESSION?.trim() ?? "default",
    redisUrl: process.env.REDIS_URL?.trim() ?? "",
    redisHost: process.env.REDIS_HOST?.trim() ?? "",
    redisPort: getNumber("REDIS_PORT", 6379),
    redisUser: process.env.REDIS_USER?.trim() ?? "default",
    redisPassword: process.env.REDIS_PASSWORD?.trim() ?? "",
    redisTls: getBoolean("REDIS_TLS", true),
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX?.trim() ?? `cognizap:${environment}`,
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY?.trim() ?? "",
    paystackBaseUrl: process.env.PAYSTACK_BASE_URL?.trim() ?? "https://api.paystack.co",
    uploadthingToken: process.env.UPLOADTHING_TOKEN?.trim() ?? "",
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID?.trim() ?? "",
    firebaseCredentialsBase64: process.env.FIREBASE_CREDENTIALS_BASE64?.trim() ?? "",
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() ?? "",
  };

  assertCognizAppDatabase("DATABASE_URL", envObj.databaseUrl);
  assertCognizAppDatabase("DATABASE_URL_DEV", envObj.databaseUrlDev);
  assertCognizAppDatabase("DATABASE_URL_PROD", envObj.databaseUrlProd);

  if (envObj.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long");
  }

  if (envObj.devAuthEndpointEnabled) {
    if (!envObj.isDevelopment) {
      throw new Error("DEV_AUTH_ENDPOINT_ENABLED can only be used when ENVIRONMENT=development");
    }

    if (envObj.devAuthEndpointSecret.length < 48) {
      throw new Error(
        "DEV_AUTH_ENDPOINT_SECRET must be at least 48 characters long when the dev auth endpoint is enabled",
      );
    }
  }

  if (envObj.devImpersonationEnabled) {
    if (!envObj.isDevelopment) {
      throw new Error("DEV_IMPERSONATION_ENABLED can only be used when ENVIRONMENT=development");
    }

    if (envObj.devImpersonationSecret.length < 64) {
      throw new Error(
        "DEV_IMPERSONATION_SECRET must be at least 64 characters long when dev impersonation is enabled",
      );
    }
  }

  return envObj;
}

// Lazy proxy — defers env initialization until first property access
// so that importing this module does not throw during Bun's ESM linking phase.
let _env: AppEnv | null = null;

export const env = new Proxy({} as AppEnv, {
  get(_target, prop: keyof AppEnv) {
    if (!_env) {
      _env = createEnv();
    }
    return _env[prop];
  },
});
