# AGENTS.md — CognizApp Backend API

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
