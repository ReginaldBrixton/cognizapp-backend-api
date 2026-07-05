# AGENTS.md — CognizApp Backend API

## Project Overview

CognizApp Backend API is the central REST API for the CognizApp platform — an
academic/research workspace and support-desk product serving Ghanaian students,
researchers, and providers. It exposes authentication, workspace/project
collaboration, AI analysis, a full research support desk (requests, quotes,
orders, payments, milestones, deliveries, revisions), billing/subscriptions,
referrals, notifications, and admin tooling.

The API is consumed by three frontends:
- **Users portal** — `https://cognizapp.com` (Next.js)
- **Provider portal** — `https://provider.cognizapp.com` (Next.js)
- **Admin portal** — `https://admin.cognizapp.com` (Next.js)

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Bun | `1.3.14` (pinned in `vercel.json`) |
| Framework | Elysia | `^1.4.29` |
| Language | TypeScript | `^5.9.3` (strict mode) |
| Database | PostgreSQL (Neon) | via `postgres` `^3.4.6` |
| Cache | Redis | `redis` `^5.12.1` (with in-memory fallback) |
| Auth | JWT via `jose` `^5`, Firebase Admin `^14.0.0` | |
| Validation | Elysia `t.Object` (TypeBox via `@sinclair/typebox` `^0.34.41`) | |
| Payments | Paystack | `src/lib/paystack.ts` |
| File uploads | UploadThing | `uploadthing` `^7.7.4` |
| AI | Google Gemini | `@google/genai` `^2.4.0` + REST |
| WhatsApp | WAHA | `src/lib/waha-whatsapp.ts` |
| Email | n8n webhook → Gmail | `src/lib/email-service.ts` |
| PDF | pdf-lib `^1.17.1` | watermarking/preview |
| Password hashing | `argon2` `^0.44.0`, `bcrypt` `^6.0.0` | |
| LRU cache | `lru-cache` `^11.5.1` | |
| Linter/Formatter | Biome | `^2.4.10` |
| E2E tests | Playwright | `^1.58.2` |

> **Note:** The global rules memory lists this repo's stack as "Hono + Bun", but
> the actual framework is **Elysia** (see `package.json` and `src/app/create-app.ts`).
> All route handlers use the Elysia API (`new Elysia({ prefix })`, `.get/.post`,
> `({ body, headers, set, cookie, params, query })`).

## Hosting & Infrastructure

- **Platform:** Vercel serverless functions (Bun runtime).
- **Entry point:** `api/index.ts` — a default export handler with the Node.js
  `(req, res)` signature. It converts the Node request into a Web `Request`,
  calls `app.fetch(request)`, and translates the Web `Response` back to `res`.
  `vercel.json` rewrites `/api/(.+)` → `/api` so all API traffic hits one function.
- **Function config:** `maxDuration: 60` seconds; `includeFiles: "node_modules/lru-cache/**"`.
- **Database:** Neon Postgres (serverless). Connection via `DATABASE_URL`,
  `DATABASE_URL_DEV`, `DATABASE_URL_PROD`. The database name **must** be
  `cognizap` (enforced at startup in `env.ts` and `migrations.ts`).
- **Migrations run on every cold start** inside `createApp()` via `runMigrations()`.
  On Vercel, SQL files may not be bundled, so critical migrations are also stored
  inline in `src/lib/migrations.ts` (`INLINE_MIGRATIONS`).
- **Local dev:** `bun run src/server.ts` via `Bun.serve` on port `4040` (default).
  WebSocket upgrades for support-messages realtime are handled at the Bun server
  level before delegating to Elysia.
- **CORS allowed origins:** `localhost:3000`, `127.0.0.1:3000`,
  `cognizapp.com`, `www.cognizapp.com`, `admin.cognizapp.com`,
  `provider.cognizapp.com` (plus dev loopback origins in development).
- **Security headers** set on every request: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `Cross-Origin-Resource-Policy: same-site`, and `Strict-Transport-Security` in
  production.

## Database

- **Engine:** Neon Postgres (serverless PostgreSQL with a pooler endpoint).
- **Client:** `postgres.js` (`src/lib/db.ts`). Single shared `Sql` instance
  (`getDb()`), pool `max: 10`, `idle_timeout: 60`, `connect_timeout: 30`,
  `max_lifetime: 30 min`, `prepare: false`, `application_name: "cognizap-api"`.
- **IPv4-only DNS:** `db.ts` overrides `dns.lookup` to force family 4, because
  Neon's pooler hostname resolves to IPv6 addresses that fail on many networks.
- **Transient error retry:** `withDbRetry()` wraps a query function and retries
  once on `ECONNRESET`, `ENOTFOUND`, connection terminated, etc.
- **Schemas:** `auth`, `app`, `public`. `001_init.sql` creates all three and sets
  `search_path TO app, auth, public`.
- **Key tables:**
  - `auth.users`, `auth.sessions`, `auth.activity_log`, `auth.auth_codes`,
    `auth.pin_login_attempts`, `auth.privileged_access_grants`
  - `app.workspaces`, `app.workspace_members`, `app.workspace_projects`,
    `app.workspace_analysis`, `app.workspace_collections`, `app.workspace_settings`
  - `project_documents`, `project_slides`, `project_notes`, `project_tasks`,
    `project_task_lists`, `project_diagrams`, `project_document_comments`
  - `subscription_plans`, `workspace_subscriptions`, `paystack_transactions`,
    `paystack_webhook_events`
  - `support_clients`, `support_requests`, `support_files`, `support_payments`,
    `support_referrals`, `support_wallet_transactions`, `support_events`,
    `support_messages`, `request_milestones`, `service_agreement_acceptances`
  - `referral_relationships`, `referral_commissions`, `referral_payout_profiles`
  - `user_settings`, `notifications`, `ai_bot_conversations`
- **Design conventions:** soft deletes (`deleted_at`), JSONB for flexible
  settings/metadata, `user_key_id` as the stable lookup key for client-owned
  support records, UUID primary keys via `gen_random_uuid()`.

### Migration System

- **Location:** `src/sql/migrations/`
- **Naming:** `NNN_descriptive_name.sql` (zero-padded 3-digit number, sorted
  lexicographically). Current range: `001`–`077`.
- **Execution:** `runMigrations()` in `src/lib/migrations.ts` runs on every app
  boot (called from `createApp()`). It reads all `NNN_*.sql` files from disk,
  sorts them, and executes each. On Vercel serverless (where the directory may
  not be bundled), it falls back to `INLINE_MIGRATIONS` entries.
- **Idempotency:** Migrations use `IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN
  duplicate_*` guards. Already-applied migrations are detected via error code
  `23505` / "already exists" and skipped.
- **Concurrency:** Retries up to 3 times on `CONNECTION_CLOSED` or concurrent
  tuple-update conflicts, reconnecting each retry.
- **Direct connection:** Migrations use a **direct** (non-pooler) Neon URL by
  stripping `-pooler` from the hostname, or `MIGRATION_DATABASE_URL` /
  `DATABASE_URL_DIRECT` if set.
- **CREATE INDEX CONCURRENTLY:** Split into individual statements so each runs
  outside a transaction block.

## Project Structure

```
cognizapp-backend-api/
├── api/
│   └── index.ts                 # Vercel serverless entry (Node req/res → Elysia)
├── src/
│   ├── index.ts                 # Minimal Elysia app for Vercel framework scanner
│   ├── server.ts                # Local dev Bun.serve entry (port 4040)
│   ├── app/
│   │   └── create-app.ts        # App factory: migrations, CORS, logging, route wiring
│   ├── config/
│   │   └── env.ts               # Typed environment variable loader (AppEnv)
│   ├── lib/                     # Shared utilities (see below)
│   ├── modules/                 # Feature modules (see Module Architecture)
│   ├── sql/
│   │   └── migrations/          # NNN_name.sql migration files
│   └── docs/                    # Internal documentation (architecture.md, api.md, endpoint-usage.md)
├── tests/                       # Bun test unit tests
├── tests/playwright/            # E2E tests (Playwright)
├── package.json
├── tsconfig.json
├── biome.json
├── vercel.json
└── playwright.config.ts
```

### `src/lib/` — Shared Utilities

| File | Purpose |
|---|---|
| `db.ts` | Postgres connection (`getDb()`, `closeDb()`, `withDbRetry()`, `isTransientDbError()`) |
| `migrations.ts` | `runMigrations()` — reads & executes SQL migrations on boot |
| `logger.ts` | Simple `logger.info/warn/error` console wrapper |
| `http.ts` | `ok()` / `fail()` response shape helpers |
| `errors.ts` | `HttpError` class (status, code, message, details) + `isHttpError()` |
| `validation.ts` | UUID validation, string length/array/metadata validation, `sanitizeInput()` |
| `route-helpers.ts` | `handleRouteError()` — maps `HttpError`/validation errors to JSON |
| `crypto.ts` | JWT sign/verify (`jose`), `hashToken`, `safeEqualString`, `randomToken`, device fingerprint |
| `cache.ts` | Redis client with in-memory fallback (`getJson`, `setJson`, `rememberJson`, `deletePattern`, `increment`) |
| `paystack.ts` | Paystack API client (checkout, mobile money, verify, transfer, plans, subscriptions, webhook verification) |
| `email-service.ts` | Email sending via n8n Gmail webhook (OTP, payment, delivery, replies, feedback, etc.) |
| `email-delivery.ts` | Thin wrapper over `emailService` for OTP + feedback emails |
| `firebase.ts` | Firebase Admin SDK init (`getFirebaseAdminAuth()`) |
| `gemini.ts` | Gemini AI support assistant (`generateSupportAiResponse()`) |
| `gemini-keys.ts` | Gemini API key rotation with per-minute rate limiting |
| `uploadthing.ts` | UploadThing file upload client (`uploadSupportFile()`, health check) |
| `waha-whatsapp.ts` | WAHA WhatsApp notification sending |
| `n8n.ts` | n8n notification email service wrapper |
| `project-access.ts` | `verifyProjectAccess()` — workspace membership + project existence check |
| `site-url.ts` | `getPublicSiteOrigin()`, `normalizePublicCallbackUrl()` |

## Module Architecture

Every feature lives under `src/modules/<name>/`. Most modules follow the
**repository / service / routes / types** pattern:

- `types.ts` — TypeScript interfaces for DB rows and DTOs
- `repository.ts` — all SQL queries (uses `getDb()` tagged template literals)
- `service.ts` — business logic (calls repository, enforces rules)
- `routes.ts` — Elysia router with `prefix`, calls `resolveAuth()`, delegates to service
- `*.mermaid` — optional architecture diagrams

Some smaller modules omit the service layer and put logic directly in routes
(e.g. `feedback`, `project-dashboard`, `admin`, `testing`). The `support` module
is special and split into many files (see Support Module Structure below).

### All Modules

| Module | Path prefix | Purpose |
|---|---|---|
| `auth` | `/api/auth` | Authentication: OTP, magic link, Firebase exchange, PIN login (providers), sessions, refresh, logout, dev tokens, admin auth |
| `admin` | `/api/admin` | Admin panel endpoints |
| `ai-bot` | `/api/ai-bot` | AI bot conversations |
| `audit` | — | Audit logging repository (no routes) |
| `billing` | `/api/billing` | Subscription plans, Paystack recurring billing, webhook handling, workspace subscriptions |
| `feedback` | `/api/feedback` | User feedback submission |
| `notifications` | `/api/user/notifications` | User notification list, mark-read, archive |
| `onboarding` | `/api/onboarding` | User onboarding flow |
| `project-dashboard` | `/api/workspace/:id/projects/:projectId/dashboard` | Project dashboard aggregation |
| `project-diagram` | `/api/workspace/:id/projects/:projectId/diagram` | Project diagrams |
| `project-document-comments` | `/api/workspace/:id/projects/:projectId/documents/:docId/comments` | Document comments |
| `project-documents` | `/api/workspace/:id/projects/:projectId/documents` | Project documents |
| `project-notes` | `/api/workspace/:id/projects/:projectId/notes` | Project notes |
| `project-slides` | `/api/workspace/:id/projects/:projectId/slides` | Project slides |
| `project-tasks` | `/api/workspace/:id/projects/:projectId/tasks` | Project tasks |
| `referrals` | `/api/referrals` | Referral codes, commissions, payout profiles, withdrawals |
| `support` | `/api/support` | Research support desk (requests, payments, files, quotes, orders, deliveries, previews, milestones, revisions) |
| `support-inbox` | `/api/support-inbox` | Provider support inbox + AI routes + provider settings |
| `support-messages` | `/api/support-messages` | Realtime support messages (WebSocket via Bun.serve) |
| `system` | — | System service (e.g. `ensureDefaultActor()`); no routes |
| `task-lists` | `/api/workspace/:id/projects/:projectId/task-lists` | Task lists |
| `testing` | dev only | Testing/dev routes (registered only when `env.isDevelopment`) |
| `user-dashboard` | `/api/user/dashboard` | User dashboard aggregation + stats |
| `user-settings` | `/api/user/settings` | User-scoped settings (section-based JSONB) |
| `workspace` | `/api/workspace` | Core workspace CRUD, members, access checks |
| `workspace-analysis` | `/api/workspace/:id/analysis` | AI analysis jobs (humanise, textcompare, textidentify, factcheck) |
| `workspace-collections` | `/api/workspace/:id/collections` | Collections/folders |
| `workspace-projects` | `/api/workspace/:id/projects` | Projects within workspaces |
| `workspace-settings` | `/api/workspace/:id/settings` | Workspace-scoped settings (section-based JSONB) |

### Auth Module Sub-structure

```
auth/
├── middleware.ts            # resolveAuth() — JWT verify + session check + cache
├── context.ts               # AuthContext type
├── policy.ts                # Canonical roles, permissions, role hierarchy, authorizationService
├── portal-role.ts           # Privileged portal role selection (Admin / Provider)
├── repository.ts            # auth.users / auth.sessions DB operations
├── types.ts                 # UserRecord, SessionRecord
├── helpers.ts               # Header reading, IP extraction, refresh cookie
├── route-error-handler.ts   # Shared auth error handler factory
├── privileged-defaults.ts   # isDefaultAdminEmail() — default admin emails
├── admin/
│   ├── routes.ts            # Dev token + impersonation endpoints (loopback only)
│   └── service.ts           # Admin auth service
├── providers/
│   ├── routes.ts            # PIN login/set/change (/api/auth/pin/*)
│   └── pin-service.ts       # PIN hashing (argon2), lockout, attempt logging
├── user/
│   ├── routes.ts            # User auth routes (firebase exchange, OTP, magic-link, refresh, me, sessions, logout)
│   ├── otp-service.ts       # OTP request/verify, magic link verify
│   └── otp-repository.ts    # auth.auth_codes DB operations
└── users/
    ├── routes.ts            # Users auth routes (duplicate of user/ — legacy alias)
    ├── service.ts           # User auth service (loginWithGoogle, refresh)
    ├── otp-service.ts
    └── otp-repository.ts
```

## Entry Points & Server Setup

### `api/index.ts` (Vercel production)
- Default export `handler(req, res)` — the Vercel function.
- Lazily creates the Elysia app once via `getApp()` (cached `appPromise`).
- `toWebRequest()` converts Node `IncomingMessage` → Web `Request` (reads body
  stream, copies headers).
- Calls `app.fetch(request)`, copies response status/headers/body to `res`.

### `src/server.ts` (local dev)
- Calls `createApp()` eagerly.
- `Bun.serve({ port: env.port, idleTimeout: 120 })`.
- Checks for WebSocket upgrade via `handleSupportMessagesWebSocketUpgrade()`
  before delegating to `app.fetch()`.
- Registers `supportMessagesWebSocketHandlers` as the websocket handler.
- Logs startup, handles `SIGINT`/`SIGTERM`.

### `src/app/create-app.ts` (app factory)
- `createApp()` is `async`:
  1. `await runMigrations()` — runs all pending SQL migrations.
  2. `await systemService.ensureDefaultActor()` — ensures the system actor exists.
  3. Logs startup events (database mode, integration status).
  4. Builds the Elysia app with:
     - `onRequest` — CORS, security headers, OPTIONS preflight.
     - `onBeforeHandle` — request start logging (method, path, userId, body preview with redaction).
     - `onAfterResponse` — request finish logging (status, duration, outcome).
     - `GET /` and `GET /health`.
     - All module routes via `.use()`.
     - In development: local smoke-test endpoint + `testingRoutes`.

### `src/index.ts`
- Minimal Elysia app (`/health`, `/`) for Vercel's framework scanner. The real
  API is handled by `api/index.ts` via `vercel.json` rewrites.

## Authentication & Security

### Auth Methods
1. **Firebase Google exchange** — `POST /api/auth/firebase/exchange`. Verifies a
   Firebase ID token (Google only), creates/updates the user in Postgres, issues
   JWT access + refresh tokens.
2. **Email OTP** — `POST /api/auth/otp/request` → `POST /api/auth/otp/verify`.
   6-digit code, expiry `OTP_CODE_EXPIRY_MINUTES` (default 10), max attempts
   `OTP_MAX_ATTEMPTS` (default 5), resend cooldown `OTP_RESEND_COOLDOWN_SECONDS`
   (default 60), rate limit `OTP_RATE_LIMIT_PER_MINUTE` (default 10).
3. **Magic link** — `POST /api/auth/magic-link/verify`. A random token is
   generated alongside the OTP code; its SHA-256 hash is stored in
   `auth.auth_codes.magic_link_token_hash`. The email contains a link the user
   can click instead of entering the code.
4. **Provider PIN** — `POST /api/auth/pin/login` (username + PIN). PIN hashed
   with argon2. Failed attempts tracked with lockout. Attempts logged in
   `auth.pin_login_attempts`. Set/change via `/api/auth/pin/set`, `/api/auth/pin/change`.
5. **Refresh token rotation** — `POST /api/auth/refresh`. Accepts the
   `refresh_token` cookie or body field. Rotates both access and refresh tokens.
6. **Dev auth** (development only) — `/api/auth/dev/token` and impersonation
   endpoints, loopback-only, require `DEV_AUTH_ENDPOINT_SECRET`.

### JWT (jose)
- Algorithm: `HS256`, secret = `env.jwtSecret` (must be ≥ 32 chars).
- Access token claims: `uid`, `sid`, `role`, `email`, optional `dfp` (device
  fingerprint). Expiry: `JWT_ACCESS_EXPIRY_MINUTES` (default 15).
- Refresh token claims: `uid`, `sid`. Expiry: `JWT_REFRESH_EXPIRY_DAYS` (default 30).
- Issuer: `JWT_ISSUER` (default `cognizap`). Audience: `JWT_AUDIENCE` (default
  `cognizap-api`); refresh audience is `${JWT_AUDIENCE}-refresh`.

### Session Validation (`resolveAuth` in `auth/middleware.ts`)
1. Extract `Bearer` token from `Authorization` header.
2. **Test bypass** — if `TEST_AUTH_BYPASS_ENABLED` and token matches
   `TEST_AUTH_BYPASS_TOKEN`, loads the real user by `TEST_AUTH_BYPASS_EMAIL`.
3. Verify JWT signature/claims via `jose`.
4. Check resolved-auth cache (Redis/memory, key `auth:resolved:<sid>:<uid>`, TTL 120s).
5. Verify session exists in `auth.sessions`, is not revoked, not expired.
6. Verify `session.userId === claims.userId` (token-swap defence).
7. Verify user status (not banned/deleted/disabled/locked).
8. **Privileged access grant** — for `ADMIN_USER` or `SUPPORT_PROVIDER_USER`
   roles, checks `auth.privileged_access_grants` for an active grant (unless the
   email is a default admin email). Revokes all sessions if no grant found.

### Roles & Permissions (`auth/policy.ts`)
Canonical roles (hierarchy low → high):
`REGULAR_USER` (0) → `PRO_USER` (1) → `SUPPORT_PROVIDER_USER` (2) →
`DEV_USER` (3) → `ADMIN_USER` (4) → `SYSTEM_USER` (5).

Legacy role names map: `user`→`REGULAR_USER`, `premium`→`PRO_USER`,
`support_provider`→`SUPPORT_PROVIDER_USER`, `developer`→`DEV_USER`,
`admin`/`master`→`ADMIN_USER`.

Permissions are dotted strings (e.g. `workspace.create.own`,
`projects.create`, `users.manage.roles`, `support.tickets.respond`). Use
`requirePermission(auth, permission)` or `authorizationService.can(actor, permission)`.

### Privileged Portal Access (`auth/portal-role.ts`)
- Privileged roles: `ADMIN_USER` (Admin portal) and `SUPPORT_PROVIDER_USER`
  (Provider portal).
- `normalizeSelectedPrivilegedRole()` accepts aliases (`admin`, `provider`,
  `support_provider`).
- `assertSelectedRoleMatchesGrant()` ensures the selected portal matches the
  granted role.

### Crypto (`lib/crypto.ts`)
- `hashToken` (SHA-256), `safeEqualString` (timing-safe compare via hashed
  digests), `randomToken`, `deviceFingerprint`.
- `signAccessToken` / `signRefreshToken` / `verifyAccessToken` / `verifyRefreshToken`.

### Access Control Helpers
- `verifyWorkspaceAccess(userId, workspaceId)` — `modules/workspace/access.ts`
- `verifyProjectAccess(userId, workspaceId, projectId)` — `lib/project-access.ts`
- Both throw `HttpError` (404/403) on failure.

## Code Conventions

### TypeScript
- **Strict mode** enabled (`tsconfig.json`).
- Target: `ES2021`, module: `ES2022`, moduleResolution: `node`.
- Types: `bun-types`.
- `esModuleInterop`, `forceConsistentCasingInFileNames` enabled.
- Path aliases force `elysia` and `@elysiajs/*` to resolve from local `node_modules`.

### Biome (lint + format)
From `biome.json`:
- **Indent style:** spaces, width 2.
- **Line width:** 100.
- **Semicolons:** `always` (every statement ends with `;`).
- **Quote style:** `double` (`"..."`).
- **Trailing commas:** `all`.
- **Linter preset:** `recommended`.
- Biome only scans: `src/app/**`, `src/config/**`, `src/index.ts`,
  `src/server.ts`, `package.json`, `playwright.config.ts`, `biome.json`.
  (Module/lib files are not in the Biome `files.includes` glob but should still
  follow the same style.)

### Imports
- Use ES module imports (`import { X } from "y"`).
- `type` imports for types: `import type { UserRecord } from "./types"`.
- Relative imports within modules; absolute-style not configured.

### Error Handling
- Throw `HttpError(status, code, message, details?)` from `lib/errors.ts`.
- Route-level `onError` handlers catch `HttpError` and return
  `{ success: false, error, errorCode }`.
- Elysia validation errors (`code === "VALIDATION"` / `"PARSE"`) → 400
  `{ success: false, error: "Invalid request body", errorCode: "invalid_request" }`.
- Transient DB errors → 503 `service_unavailable`.
- Use `handleRouteError(context)` from `lib/route-helpers.ts` for a standard
  error response, or replicate the pattern inline.

### Response Shapes (`lib/http.ts`)
- Success: `ok({ ...data })` → `{ success: true, ...data }`.
- Failure: `fail(message, code, details?)` →
  `{ success: false, error, errorCode, details }`.

## How the AI Should Write Code

1. **Follow the module pattern.** New features go in `src/modules/<name>/` with
   `types.ts`, `repository.ts`, `service.ts`, `routes.ts`. Small features may
   omit `service.ts`.
2. **Register routes in `create-app.ts`.** Import the router and add
   `.use(yourRoutes)` in the chain.
3. **Use Elysia patterns.** `new Elysia({ prefix: "/api/...", tags: [...] })`,
   `.get/.post/.patch/.delete(path, handler, { body: t.Object({...}), query: t.Object({...}) })`.
4. **Authenticate with `resolveAuth(headers)`** from
   `../auth/middleware`. It returns an `AuthContext` with `userId`, `role`,
   `permissions`, `sessionId`, `user`.
5. **Use `HttpError` for errors** — never throw raw errors or return ad-hoc
   error objects. Add an `onError` handler to your router that maps
   `HttpError` → `fail()` and validation errors → 400.
6. **Use `ok()` / `fail()`** for consistent response shapes.
7. **Use `validation.ts` helpers** (`validateUuidParam`, `validateStringLength`,
   `sanitizeInput`) for input checks beyond Elysia's schema validation.
8. **Use `getDb()` for SQL.** Write queries as tagged template literals:
   `await db\`SELECT * FROM users WHERE id = ${userId}::uuid\``. Use
   `withDbRetry()` for queries that may hit transient connection errors.
9. **Use the cache** (`cache.rememberJson`, `cache.setJson`,
   `cache.deletePattern`) for expensive reads. Invalidate on writes.
10. **Add a migration** for any schema change. Create
    `src/sql/migrations/NNN_name.sql` with idempotent SQL (`IF NOT EXISTS`,
    `DO $$ ... EXCEPTION`). If the migration is critical for serverless cold
    starts, also add it to `INLINE_MIGRATIONS` in `lib/migrations.ts`.
11. **Log with context.** Use `logger.info/warn/error` or `console.log` with
    structured JSON. Redact secrets (passwords, tokens, authorization headers).
12. **Use Biome style:** semicolons, double quotes, 2-space indent, trailing
    commas, line width 100.
13. **Never commit secrets.** Read all config from `env.ts`. Add new env vars to
    the `AppEnv` type and `createEnv()`.

## API Design Patterns

- **Path prefixes:** `/api/auth/*`, `/api/user/*`, `/api/workspace/:id/*`,
  `/api/billing/*`, `/api/support/*`, `/api/referrals/*`,
  `/api/support-inbox/*`, `/api/support-messages/*`, `/api/admin/*`,
  `/api/feedback/*`, `/api/onboarding/*`, `/api/ai-bot/*`.
- **Auth:** `Authorization: Bearer <accessToken>` header on all protected
  routes. Refresh token sent via `refresh_token` HttpOnly cookie.
- **Validation:** Elysia `t.Object` schema (TypeBox) on `body`, `query`, `params`.
- **Pagination:** `limit` + `offset` query params (defaults vary, e.g. 50).
- **CORS:** Credentials allowed; origin reflected from allowlist.
- **Request logging:** `create-app.ts` logs `api.request.start`,
  `api.request.body_preview` (redacted), `api.request.finish` (status, duration,
  outcome, plainEnglish summary).
- **Support module logging:** Every support request gets a `requestId` (`sup-...`)
    and is logged with `module: "support"` (see Support Module Structure).

## Key Integrations

### Paystack (`lib/paystack.ts`)
- Ghana-focused payment provider. Base URL: `PAYSTACK_BASE_URL` (default
  `https://api.paystack.co`).
- Checkout initialization, mobile money charges (MTN, AirtelTigo, Telecel),
  transaction verification, OTP/PIN submission, transfers, subscription plans.
- Webhook signature verification via HMAC-SHA256.
- Amounts in minor units (pesewas for GHS).
- Mode detection: `sk_live_` → live, `sk_test_` → test.

### UploadThing (`lib/uploadthing.ts`)
- File uploads via `UTApi`. Token: `UPLOADTHING_TOKEN`.
- `uploadSupportFile()` uploads with a customId (`support:<purpose>:<uuid>`).
- Health check via `checkUploadThingHealth()`.

### Firebase (`lib/firebase.ts`)
- Firebase Admin SDK for Google ID token verification during auth exchange.
- Credentials from `FIREBASE_CREDENTIALS_BASE64` or
  `GOOGLE_SERVICE_ACCOUNT_JSON`, or application default credentials.

### Gemini AI (`lib/gemini.ts`, `lib/gemini-keys.ts`)
- Support assistant AI. Default model: `gemini-3.1-flash-lite` (overridable via
  `SUPPORT_AI_MODEL`).
- Key rotation: reads `GEMINI_API_KEY_1`...`GEMINI_API_KEY_N` + fallback
  `GEMINI_API_KEY`/`GOOGLE_AI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`. Max 2
  uses per key per minute (sliding window).
- Returns structured JSON: `reasoning`, `response`, `complexity`,
  `actionItems[]`.
- Fallback response when no keys configured.

### n8n (`lib/n8n.ts`, `lib/email-service.ts`)
- Email sending via n8n Gmail webhook (`N8N_GMAIL_SEND_WEBHOOK_URL`).
- Webhook secret header: `X-CognizApp-Webhook-Secret` (`N8N_WEBHOOK_SECRET`).
- Timeout: `N8N_WEBHOOK_TIMEOUT_MS` (default 15000).

### WAHA WhatsApp (`lib/waha-whatsapp.ts`)
- WhatsApp notifications via WAHA API (`WAHA_BASE_URL`, `WAHA_API_KEY`,
  `WAHA_SESSION`).
- `sendWhatsAppNotification()` posts to `/api/sendText` with chatId
  `<digits>@c.us`.

### Neon Postgres (`lib/db.ts`)
- Serverless Postgres. Pooler endpoint for app queries; direct endpoint for
  migrations (strips `-pooler` from hostname).

### Redis (`lib/cache.ts`)
- Optional cache. Falls back to in-memory `Map` if Redis unavailable.
- Used for resolved-auth caching, billing plan caching, referral summaries,
  support caching, rate limiting counters.

## Support Module Structure

The support module (`src/modules/support/`) was refactored from a 3,758-line `routes.ts` and a 1,644-line `shared.ts` into focused, debuggable files.

### Debugging Support Routes

Every support request is automatically logged with a unique `requestId`. Search logs by `requestId` to trace a single request end-to-end. Log lines are JSON to stdout/stderr.

**Log format:**
```json
{"level":"info","ts":"2026-07-05T...","module":"support","operation":"...","requestId":"sup-...","message":"request.start","method":"POST","path":"/api/support/..."}
{"level":"info","ts":"2026-07-05T...","module":"support","requestId":"sup-...","message":"request.completed","status":200,"durationMs":42}
```

**Finding the right file for a route:**

| URL pattern | File |
|---|---|
| `/cost-estimate`, `/uploadthing/status`, `/notifications/status`, `/paystack/config`, `/paystack/webhook`, `/payment-settings` | `routes/misc.ts` |
| `/client/codes/validate` | `routes/codes.ts` |
| `/client/requests` (CRUD), `/client/requests/:id/submit`, `/cancel`, `/draft`, `/files`, `/drive-files`, `/events`, `/history` | `routes/client-requests.ts` |
| `/client/requests/:id/paystack/*`, `/refund-requests` | `routes/payments.ts` |
| `/files/upload`, `/files/:id` (PATCH/DELETE), `/files/:id/download` | `routes/files.ts` |
| `/client/quotes/*`, `/client/requests/:id/quotes` | `routes/quotes.ts` |
| `/client/orders` | `routes/orders.ts` |
| `/client/requests/:id/deliveries`, `/client/requests/:id/download` | `routes/deliveries.ts` |
| `/client/requests/:id/previews/*` | `routes/previews.ts` |
| `/client/requests/:id/milestones/*` | `routes/milestones.ts` |
| `/client/requests/:id/revisions` | `routes/revisions.ts` |

### File Layout

```
support/
├── routes.ts                 # Thin assembler: prefix + auto-logging + .use(sub-routers)
├── logger.ts                 # Structured JSON logger with requestId generation
├── route-trace.ts            # Optional per-handler wrapper for operation-tagged logging
├── constants.ts              # Upload limits, MIME types, extensions, timezones
├── utils.ts                  # isRequestBodyParseError
├── delivery-policy.ts        # Delivery download/preview/redaction logic
├── upload-validation.ts      # File upload validation
├── payment-helpers.ts        # retryablePaymentStatusAfterCancel
├── file-helpers.ts           # Provider file mutation, attachment updates, activity messages
├── request-helpers.ts        # Estimate input, assignment validation, draft formatting
├── ai-acknowledgement.ts     # AI first-response message generation
├── cost-estimation.ts        # Cost estimation (unchanged)
├── payment-policy.ts         # Payment policy/risk classification (unchanged)
├── preview-service.ts        # PDF watermarking/preview generation (unchanged)
├── shared/                   # Split from shared.ts (barrel: shared/index.ts)
│   ├── index.ts              # Re-exports all shared helpers (backward compatible)
│   ├── cache.ts              # rememberSupportJson, invalidateSupportCache
│   ├── clients.ts            # toCamel, ensureClient, canSeeProvider, WhatsApp helpers
│   ├── events.ts             # addSupportEvent
│   ├── threads.ts            # ensureSupportMessageThread, completeSupportMessageThreads
│   ├── notifications.ts      # sendSupportEmail, sendSupportWhatsApp
│   ├── workspace.ts          # verifySupportWorkspaceAccess, ensureSupportWorkspaceLinks
│   ├── milestones.ts         # Milestone files, events, card attachments, history
│   ├── files.ts              # storeSupportFileOnUploadThing, ensureRequestStorageReady
│   ├── payments.ts           # roundMoney, calculatePaymentAmount, paymentAmountForType
│   ├── referrals.ts          # accrueReferralReward
│   └── paystack.ts           # confirmSupportPaystackPayment
└── routes/                   # Split from routes.ts
    ├── misc.ts               # Cost-estimate, status, paystack config/webhook, payment-settings
    ├── codes.ts              # Discount/referral code validation
    ├── client-requests.ts    # Request CRUD, submit, cancel, drafts, events, history
    ├── payments.ts           # Paystack checkout, mobile-money, OTP, PIN, verify, refund
    ├── files.ts              # File upload, patch, delete, download
    ├── quotes.ts             # Quote list, detail, accept, decline
    ├── orders.ts             # Order list, detail
    ├── deliveries.ts         # Delivery list, download
    ├── previews.ts           # Preview list, preview-page content
    ├── milestones.ts         # Milestone list, detail, accept, history
    └── revisions.ts          # Revision requests
```

### Key Commands

| Command | Description |
|---|---|
| `bun run dev:server` | Dev server |
| `bun run typecheck` | TypeScript check (tsc --noEmit) |
| `bun test` | Run tests |

### Importing Shared Helpers

All existing imports from `"./shared"` or `"../support/shared"` continue to work via the barrel re-export at `shared/index.ts`. When adding new shared helpers, place them in the appropriate sub-module and re-export from `shared/index.ts`.

## Key Commands

| Command | Description |
|---|---|
| `bun install` | Install dependencies |
| `bun run dev` | Dev server + Biome lint watcher (concurrently) |
| `bun run dev:server` | Dev server only (`bun run --watch src/server.ts`) |
| `bun run start` | Start server (`bun run src/server.ts`) |
| `bun run build` | Typecheck (`tsc --noEmit`) — used as build step |
| `bun run typecheck` | TypeScript check (`tsc --noEmit`) |
| `bun run lint` | Biome check (scoped files) |
| `bun run lint:fix` | Biome check + auto-fix |
| `bun run lint:watch` | Biome watch mode (via `scripts/dev-lint-watch.mjs`) |
| `bun test` | Run unit tests (`bun test --max-concurrency 1 tests`) |
| `bun run test:e2e` | Playwright E2E tests |
| `bun run test:e2e:report` | Playwright E2E tests with HTML report |
| `vc deploy` | Deploy to Vercel |

## Testing

### Unit Tests (Bun test)
- Location: `tests/` (root).
- Command: `bun test` (runs `bun test --max-concurrency 1 tests`).
- Pattern: `import { describe, expect, it } from "bun:test"`.
- Current test files: `auth-helpers.test.ts`, `errors.test.ts`, `http.test.ts`,
  `payment-policy.test.ts`, `paystack-service.test.ts`, `policy.test.ts`,
  `portal-role.test.ts`, `preview-access.test.ts`, `site-url.test.ts`,
  `support-assignment-pricing.test.ts`, `validation.test.ts`.
- Tests import directly from `src/lib/*` and `src/modules/*` — no HTTP server
  needed for unit tests.

### E2E Tests (Playwright)
- Config: `playwright.config.ts`.
- Test dir: `tests/playwright/`.
- Global setup: `tests/playwright/global-setup.ts`.
- Base URL: `process.env.API_URL ?? "http://localhost:3001"`.
- Timeout: 30s, 0 retries, `list` reporter.
- Commands: `bun run test:e2e`, `bun run test:e2e:report`.

### Verification Rule
Before claiming a task is done, run `bun run typecheck` and `bun test`. Fix any
errors before reporting completion.

## Environment Variables

All env vars are loaded in `src/config/env.ts`. **Do not commit actual values.**
Required (throws if missing) vs optional (has fallback) is noted.

### Core
| Variable | Required | Default / Notes |
|---|---|---|
| `ENVIRONMENT` / `NODE_ENV` | no | `development` |
| `PORT` | no | `4040` |
| `LOCAL_TEST_ENDPOINT_PATH` | no | `/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test` |
| `VERCEL_ENV` | no | set by Vercel |

### Database
| Variable | Required | Default / Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | Active DB URL (prod uses `DATABASE_URL_PROD`, dev uses `DATABASE_URL_DEV`) |
| `DATABASE_URL_DEV` | **yes** | Dev Neon URL (fallback: `POSTGRES_AUTH_URI`) |
| `DATABASE_URL_PROD` | **yes** | Prod Neon URL (fallback: `POSTGRES_AUTH_URI_PROD` or dev URL) |
| `MIGRATION_DATABASE_URL` / `DATABASE_URL_DIRECT` | no | Direct (non-pooler) URL for migrations |

> All three `DATABASE_URL*` must point to a database named **`cognizap`**.

### JWT / Auth
| Variable | Required | Default / Notes |
|---|---|---|
| `JWT_SECRET` | **yes** | Must be ≥ 32 characters |
| `JWT_ISSUER` | no | `cognizap` |
| `JWT_AUDIENCE` | no | `cognizap-api` |
| `JWT_ACCESS_EXPIRY_MINUTES` | no | `15` |
| `JWT_REFRESH_EXPIRY_DAYS` | no | `30` |
| `STRICT_DEVICE_FINGERPRINT` | no | `false` |
| `MASTER_USER_EMAIL` | no | |
| `MASTER_USER_ID` | no | |
| `DEFAULT_ADMIN_EMAILS` | no | `reginaldbrixton@gmail.com,cognizap.ai@gmail.com` |
| `AUTH_EXCHANGE_RATE_LIMIT` | no | `10` |
| `OTP_CODE_EXPIRY_MINUTES` | no | `10` |
| `OTP_MAX_ATTEMPTS` | no | `5` |
| `OTP_RESEND_COOLDOWN_SECONDS` | no | `60` |
| `OTP_RATE_LIMIT_PER_MINUTE` | no | `10` |
| `DEV_AUTH_ENDPOINT_ENABLED` | no | `false` (dev only; secret must be ≥ 48 chars) |
| `DEV_AUTH_ENDPOINT_SECRET` | no | |
| `DEV_IMPERSONATION_ENABLED` | no | `false` (dev only; secret must be ≥ 64 chars) |
| `DEV_IMPERSONATION_SECRET` | no | |
| `DEV_IMPERSONATION_ALLOW_PRIVILEGED` | no | `false` |
| `DEV_IMPERSONATION_ALLOWED_EMAILS` | no | comma-separated |
| `TEST_AUTH_BYPASS_ENABLED` | no | `false` |
| `TEST_AUTH_BYPASS_TOKEN` | no | |
| `TEST_AUTH_BYPASS_EMAIL` | no | |

### Redis
| Variable | Required | Default / Notes |
|---|---|---|
| `REDIS_URL` | no | full URL takes precedence |
| `REDIS_HOST` | no | |
| `REDIS_PORT` | no | `6379` |
| `REDIS_USER` | no | `default` |
| `REDIS_PASSWORD` | no | |
| `REDIS_TLS` | no | `true` |
| `REDIS_KEY_PREFIX` | no | `cognizap:<environment>` |

### Integrations
| Variable | Required | Default / Notes |
|---|---|---|
| `N8N_GMAIL_SEND_WEBHOOK_URL` | no | Email webhook URL |
| `N8N_WEBHOOK_SECRET` | no | Shared secret header |
| `N8N_WEBHOOK_TIMEOUT_MS` | no | `15000` |
| `WAHA_BASE_URL` | no | WAHA API base |
| `WAHA_API_KEY` | no | |
| `WAHA_SESSION` | no | `default` |
| `PAYSTACK_SECRET_KEY` | no | `sk_live_` or `sk_test_` |
| `PAYSTACK_BASE_URL` | no | `https://api.paystack.co` |
| `UPLOADTHING_TOKEN` | no | |
| `FIREBASE_PROJECT_ID` | no | |
| `FIREBASE_CREDENTIALS_BASE64` | no | base64-encoded service account JSON |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | raw service account JSON |
| `GEMINI_API_KEY` / `GEMINI_API_KEY_N` | no | Gemini API keys (rotated) |
| `SUPPORT_AI_MODEL` | no | `gemini-3.1-flash-lite` |
| `PUBLIC_SITE_URL` / `FRONTEND_URL` | no | Public site origin for callbacks |

## Migrations Reference

Migrations are in `src/sql/migrations/`, numbered `NNN_name.sql`, executed in
lexicographic order on every app boot.

### Key Migrations
| File | Adds |
|---|---|
| `001_init.sql` | Schemas (`auth`, `app`, `public`), `auth.users`, `auth.sessions`, `auth.activity_log`, `app.workspaces`, `app.workspace_members`, `app.workspace_projects`, `app.workspace_analysis`, `app.workspace_collections`, `app.workspace_settings`, `user_settings` |
| `006_roles_permissions.sql` | Roles & permissions system |
| `007_research_platform.sql` | Research platform tables |
| `008_canonical_roles_and_audit.sql` | Canonical roles + audit logging |
| `013_project_diagram.sql` | Project diagrams |
| `016_project_task_lists.sql` | Task lists |
| `017_auth_security_hardening.sql` | Auth security hardening |
| `022_research_support_desk.sql` | `support_clients`, `support_requests` (research support desk) |
| `023_support_payment_flow.sql` | Support payment flow |
| `030_email_otp_auth.sql` | Email OTP auth (`auth.auth_codes`) |
| `033_paystack_recurring_billing.sql` | Paystack recurring subscription fields, `paystack_webhook_events` idempotency |
| `034_refund_policy.sql` | Refund policy |
| `037_ai_bot_tables.sql` | AI bot tables |
| `041_privileged_access_grants.sql` | `auth.privileged_access_grants` |
| `044_provider_settings.sql` | Provider settings |
| `045_referrals_discounts_wallet.sql` | `referral_code`/`referred_by_user_id` on `auth.users`, `support_wallet_transactions`, discount codes |
| `047_request_milestones.sql` | `request_milestones` |
| `048_referral_relationship_commissions.sql` | `referral_relationships`, `referral_commissions` |
| `050_protected_preview_flow.sql` | Protected preview flow |
| `073_milestone_submission_rounds.sql` | Milestone submission rounds |
| `074_voice_notes.sql` | Voice notes on `support_files` |
| `075_magic_link_auth.sql` | `magic_link_token_hash` on `auth.auth_codes` |
| `076_provider_pin_auth.sql` | `username`, `pin_hash`, PIN lockout fields on `auth.users`; `auth.pin_login_attempts`; `device_id` on sessions |
| `077_service_agreement_acceptances.sql` | `service_agreement_acceptances` (Ghana E-Transactions Act compliance, clickwrap audit trail) |

> Note: Migration numbers `051`–`067` are not present on disk; numbering has gaps.

## Debugging Tips

- **Request tracing:** `create-app.ts` logs every request with `api.request.start`
  (method, path, userId) and `api.request.finish` (status, duration, outcome,
  plainEnglish). Search logs for the path + method to trace a request.
- **Support module tracing:** Every `/api/support/*` request gets a `requestId`
  (`sup-...`). Search logs by `requestId` to trace end-to-end (see Support
  Module Structure).
- **Body preview:** Non-GET request bodies are logged (first 300 chars, redacted)
  as `api.request.body_preview`.
- **Slow auth queries:** `auth/repository.ts` logs warnings for queries > 200ms
  via `withAuthQueryTiming()`.
- **Transient DB errors:** `db.ts` logs `[db] Transient connection error,
  retrying once...` when a stale connection is retried.
- **Redis unavailability:** `cache.ts` logs `[redis] cache unavailable;
  continuing without Redis: ...` once, then silently falls back to memory.
- **Migration logs:** `migrations.ts` logs `Executing migration NNN_...sql`,
  `Successfully executed migration`, or `already applied, skipping`.
- **Gemini key rotation:** `gemini-keys.ts` warns when all keys are exhausted
  for the minute and reuses the least-recently-used key.
- **Local dev:** Server runs on `http://localhost:4040`. Smoke test at
  `http://localhost:4040/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test`.
