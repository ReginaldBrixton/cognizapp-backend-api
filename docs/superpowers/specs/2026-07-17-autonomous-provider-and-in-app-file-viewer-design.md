# CognizApp Autonomous Provider and In-App File Viewer Design

Date: 2026-07-17
Status: Approved design, pending implementation plan
Repositories:
- `ReginaldBrixton/cognizapp-users`
- `ReginaldBrixton/cognizapp-provider`
- `ReginaldBrixton/cognizapp-backend-api`

## 1. Purpose

This design introduces three coordinated capabilities:

1. A theme-consistent in-app attachment viewer for images, PDFs, Office documents, spreadsheets, audio and video.
2. A secure provider credential reset and recovery flow that does not expose or recover an existing PIN.
3. A fully autonomous provider agent, exposed through a scoped MCP server and backed by a server-side execution engine, that can read requests, communicate with users, create and upload deliverables, update milestones and quotations, manage allowed payment-state workflows, deliver work and complete requests.

The system must preserve the existing CognizApp payment, authorization, preview, delivery and audit rules. Full autonomy means the agent does not require routine human approval, not that it may bypass business rules or security controls.

## 2. Confirmed Current State

### 2.1 Attachment behavior

The user portal attachment component currently opens files with ordinary links and `target="_blank"`. This causes images, PDFs and Office files to leave CognizApp rather than opening in an application-owned viewer.

### 2.2 Provider authentication

The provider portal currently supports username-and-PIN login. The backend hashes the PIN with Argon2id and applies account lockout, IP throttling, device throttling and generic invalid-credential responses. Because only a one-way hash is stored, the existing PIN cannot be retrieved or displayed.

### 2.3 Support backend

The backend already separates requests, messages, files, previews, milestones, quotations, payments, deliveries and revisions. These existing domain operations will remain authoritative. The MCP server will call the same service layer rather than duplicate business logic.

## 3. Scope

### 3.1 Included

- In-app preview for supported attachment formats.
- Mobile, tablet and desktop viewer layouts.
- Theme, high-contrast and compact-density support.
- Secure authenticated streaming of private attachments.
- Office-file conversion to a CognizApp-hosted preview.
- Provider PIN reset and recovery.
- MCP server with scoped provider tools.
- Autonomous execution engine with a database-backed job queue.
- Full operational autonomy within configured policy limits.
- Audit logging, idempotency, rate limits, revocation and emergency shutdown.
- Unit, integration, browser, MCP contract, security and production-build tests.

### 3.2 Not included

- Recovering or revealing an existing provider PIN.
- Giving the AI the provider's personal username or PIN.
- Allowing the AI to bypass Paystack verification, payment policies, file validation or request ownership checks.
- Publicly exposing private support files.
- Trusting instructions embedded inside uploaded files as system instructions.

## 4. In-App Attachment Viewer

### 4.1 User experience

Selecting an attachment opens a CognizApp-owned viewer instead of navigating away.

#### Mobile

- Full-screen viewer.
- Swipe down to close where it does not conflict with document scrolling.
- Pinch and double-tap zoom for images.
- Horizontal swipe between attachments in the same message.
- Sticky compact toolbar with close, filename, page count where relevant, share and download.

#### Tablet

- Large modal or full-height sheet with preserved chat context.
- Thumbnail rail for multi-page documents where space permits.

#### Desktop

- Centered large dialog or right-side inspection panel based on available width.
- Keyboard navigation, zoom shortcuts and Escape to close.

### 4.2 Format behavior

- Images: native browser rendering with zoom, pan, rotation and gallery navigation.
- PDF: PDF.js-based renderer with page navigation, thumbnails, search, zoom and download.
- DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP and RTF: converted server-side to a private PDF preview, then displayed with the same PDF viewer.
- Plain text, CSV, JSON and Markdown: streamed and rendered as searchable text with safe escaping.
- Audio: in-app waveform/player with duration and transcript when available.
- Video: native in-app video player with poster frame and full-screen support.
- Unsupported or failed conversions: metadata view with an explicit download button and a clear reason that preview is unavailable.

### 4.3 Theme behavior

The viewer must use the same appearance state as the rest of CognizApp:

- light, dark and system theme;
- chosen accent color;
- high-contrast mode;
- compact or comfortable density;
- reduced-motion preference.

Portalled dialogs must inherit the root CSS variables. No viewer component may hard-code a separate theme.

### 4.4 Secure file delivery

Private attachments must not be passed directly to third-party viewers.

The backend will expose authenticated content and preview endpoints that:

- verify the current user or provider may access the request;
- verify the file belongs to that request;
- issue a short-lived, single-purpose signed view token;
- stream content with `Content-Disposition: inline` for preview and `attachment` only for explicit download;
- set an exact MIME type, `X-Content-Type-Options: nosniff`, private cache controls and a restrictive content security policy;
- prevent token reuse after expiry;
- record view and download audit events.

### 4.5 Office conversion adapter

Browsers cannot safely and consistently render DOCX, PPTX and XLSX directly. The backend will introduce a `DocumentConversionProvider` interface.

Required operations:

- submit a private source file;
- convert it to PDF;
- return conversion status;
- retrieve the result;
- delete the provider-side temporary source and output;
- report deterministic error codes.

The production provider will be selected through environment configuration. The first supported provider may be CloudConvert, ConvertAPI, a private OnlyOffice/Collabora service or an equivalent approved service. The CognizApp API remains the only URL exposed to the client.

A conversion record will be stored with:

- source file ID and checksum;
- output file ID and checksum;
- provider name;
- status and attempt count;
- error code;
- created, started, completed and expiry timestamps.

Successful previews are cached by source checksum. Failed jobs use bounded retry with exponential backoff. Conversion never blocks the original upload or message send.

## 5. Provider Authentication and Credential Recovery

### 5.1 Existing PIN security

The existing Argon2id hashing and lockout controls remain. No endpoint will return a PIN or PIN hash.

### 5.2 Reset flow

Two reset paths will be added:

1. Authenticated provider change: requires the current PIN and a recent authenticated session.
2. Administrative recovery: an administrator creates a short-lived, single-use setup token. The provider receives a private setup link and chooses a new PIN.

Reset tokens will be random, stored only as hashes, expire after 15 minutes and become invalid after first use. Reset events revoke active provider sessions and are written to the audit log.

### 5.3 Additional protections

- Optional passkey enrollment after PIN login.
- OTP recovery only for verified privileged accounts.
- Mandatory recent authentication for PIN, username, passkey and recovery changes.
- Device and IP metadata in the activity log.
- No credentials in source, database logs, analytics, error traces or AI prompts.

## 6. Autonomous Provider Architecture

### 6.1 Components

#### Provider Agent MCP Gateway

A Streamable HTTP MCP endpoint will be added to the backend. It will expose a fixed set of typed tools and resources. It will not proxy arbitrary HTTP requests or SQL.

#### Provider Agent Service Identity

The agent receives its own revocable service identity. Credentials are separate from human provider credentials and are stored as deployment secrets. The identity has scopes, limits and an enabled/disabled state.

#### Autonomous Execution Engine

A server-side Gemini-based engine will inspect queued requests and use the same typed tool contracts as the MCP gateway. It will produce structured plans, execute tools and record each step.

#### Database-Backed Job Queue

A durable queue will store agent jobs. Support-request and support-message events enqueue work. A protected Vercel Cron endpoint claims jobs using `FOR UPDATE SKIP LOCKED` and processes them. Jobs include leases, attempt counts, next-attempt time, idempotency keys and terminal states.

#### Provider Control Surface

The provider portal will show:

- global autonomy status;
- kill switch;
- current jobs and failures;
- per-request takeover or pause;
- action history;
- policy limits;
- service-token rotation and revocation.

### 6.2 MCP tools

Read tools:

- `list_requests`
- `get_request`
- `list_request_messages`
- `get_message`
- `list_request_files`
- `get_file_metadata`
- `read_file_preview`
- `list_milestones`
- `get_payment_state`
- `get_delivery_state`
- `get_request_audit_log`

Communication tools:

- `send_message`
- `send_reply`
- `add_reaction`
- `send_status_update`

Work tools:

- `create_text_deliverable`
- `create_document_deliverable`
- `create_spreadsheet_deliverable`
- `create_presentation_deliverable`
- `upload_deliverable`
- `create_protected_preview`
- `deliver_files`

Workflow tools:

- `create_quote`
- `update_quote`
- `create_milestone`
- `update_milestone`
- `request_clarification`
- `update_request_status`
- `record_revision_response`
- `mark_request_complete`

Payment tools:

- `request_payment`
- `refresh_verified_payment_state`
- `apply_payment_policy`

Payment tools may initiate only existing validated workflows. They may not fabricate successful payment, directly alter Paystack settlement data or bypass preview and download restrictions.

### 6.3 Full-autonomy request lifecycle

1. Triage the request and classify service type, risk, deadline and missing information.
2. Inspect messages and attachments through safe preview resources.
3. Ask the user for clarification when required.
4. Create a task plan, milestones and quotation when the workflow requires them.
5. Generate or assemble the deliverable.
6. Run format, content, policy and file-safety checks.
7. Upload a protected preview where required.
8. Send progress updates and respond to user messages.
9. Observe verified payment and milestone states.
10. Deliver allowed files.
11. Handle revisions within the configured policy.
12. Mark the request complete and record a final audit summary.

### 6.4 Generated deliverables

The first production version will support:

- plain-text and Markdown responses;
- DOCX and matching PDF documents;
- XLSX spreadsheets;
- PPTX presentations;
- generated images where an approved image-generation service is configured;
- ZIP packages containing multiple deliverables.

Generation services must return structured manifests containing filename, MIME type, checksum, size, generator version and source request/job IDs.

## 7. Safety and Control Model

### 7.1 Authorization

Every MCP tool call must verify:

- service identity is active;
- requested scope is granted;
- target request exists;
- service identity may act on the target request;
- the transition is legal from the current request state;
- the operation satisfies payment and delivery policy.

### 7.2 Idempotency

All mutating tools require an idempotency key. Duplicate calls return the original result. This protects against duplicate messages, quotations, milestones, uploads, payment requests and completion actions.

### 7.3 Prompt-injection isolation

Uploaded files and user messages are untrusted data. Their content is passed to the model inside a clearly delimited data channel. Instructions inside documents cannot alter tool scopes, system policy, secrets or payment rules.

The agent may not:

- reveal system prompts or secrets;
- call tools not listed in its schema;
- use a file's instructions as authorization;
- execute uploaded code or macros;
- follow external links without an explicit safe-fetch tool and allow-list policy.

### 7.4 Limits

Configurable limits include:

- maximum actions per request and per hour;
- maximum generated file size and total storage;
- maximum quote amount and discount percentage;
- maximum revision count;
- allowed service categories;
- maximum model and conversion spend;
- quiet hours and deadline escalation rules.

### 7.5 Kill switches

- Global environment kill switch.
- Database global kill switch.
- Per-service-identity disable switch.
- Per-request pause/takeover switch.
- Automatic circuit breaker after repeated tool, model, payment or upload failures.

A disabled agent may finish no new mutating action. Already running jobs must check the switch before every tool call.

### 7.6 Audit

Every agent action records:

- actor/service identity;
- request and job IDs;
- model and version;
- tool name and sanitized arguments;
- idempotency key;
- before and after state;
- result or error;
- token, conversion and storage cost where available;
- timestamps and correlation ID.

User-visible messages sent by the agent are labelled as sent by `CognizApp AI` or another configured AI-provider identity.

## 8. Data Model Additions

New tables or equivalent migrations:

- `provider_agent_service_identities`
- `provider_agent_scopes`
- `provider_agent_jobs`
- `provider_agent_job_steps`
- `provider_agent_idempotency`
- `provider_agent_audit_events`
- `provider_agent_settings`
- `provider_agent_request_controls`
- `support_file_conversions`
- `support_file_view_tokens`
- `provider_credential_reset_tokens`

All migrations must be idempotent and included in the backend's inline migration fallback for Vercel.

## 9. API and MCP Error Model

Errors use stable codes, including:

- `agent_disabled`
- `agent_scope_denied`
- `agent_request_paused`
- `invalid_request_transition`
- `idempotency_conflict`
- `file_preview_not_ready`
- `file_conversion_failed`
- `file_type_unsupported`
- `payment_state_not_verified`
- `delivery_not_allowed`
- `rate_limited`
- `credential_reset_expired`
- `credential_reset_used`

Errors returned to users remain plain and actionable. Detailed provider and model diagnostics stay in protected logs.

## 10. Testing Strategy

### 10.1 Unit tests

- File-type detection and preview routing.
- Signed view-token creation, expiry and scope.
- Conversion checksum caching and retry logic.
- PIN reset token hashing, expiry and single use.
- Service scope evaluation.
- Request state transitions.
- Idempotency behavior.
- Prompt-injection delimiters and policy enforcement.
- Quote, milestone, payment and delivery limits.

### 10.2 Integration tests

- Authenticated inline content streaming.
- Unauthorized and cross-request file access denial.
- Office conversion submission and completion using a mocked provider.
- Provider credential reset and session revocation.
- Every MCP read and mutation tool.
- Job claiming, leases, retries and dead-letter behavior.
- Existing payment, preview and delivery policy preservation.

### 10.3 Browser tests

At mobile, tablet and desktop sizes:

- image open, zoom, swipe and close;
- PDF page navigation, search and zoom;
- Office preview loading and failure state;
- audio and video playback;
- explicit download;
- theme, high contrast, compact density and reduced motion;
- keyboard and screen-reader operation;
- no external redirect for supported previews;
- no horizontal overflow or hidden close controls.

### 10.4 Autonomous end-to-end tests

- New request to clarification.
- New request to quote and milestones.
- Text deliverable generation.
- DOCX/PDF, XLSX and PPTX generation and upload.
- Protected preview and payment gating.
- Revision and redelivery.
- Final completion.
- Duplicate webhook or job execution.
- Provider takeover during execution.
- Global kill switch during execution.
- Model timeout, conversion failure, upload failure and payment-state mismatch.

### 10.5 Security tests

- Prompt injection inside user text, PDF, DOCX and image metadata.
- Cross-user request and file access.
- Expired or replayed view tokens.
- Expired or replayed credential-reset tokens.
- MCP scope escalation attempts.
- Arbitrary URL, SQL, filesystem and tool-name injection.
- Secret and system-prompt exfiltration attempts.

## 11. Performance Requirements

- Viewer shell opens within 150 ms after click when metadata is already loaded.
- Image first paint within 1 second on a typical mobile connection for an optimized image.
- PDF first page within 2 seconds when the preview exists.
- File metadata responses remain below 100 KB.
- Chat rendering remains virtualizable and unaffected by viewer state.
- Agent read operations use bounded pagination.
- Jobs use concurrency limits and database leases to prevent duplicate execution.

## 12. Deployment and Rollout

Implementation will use separate pull requests for each repository.

Recommended order:

1. Backend file-view endpoints and conversion adapter.
2. User-app attachment viewer.
3. Provider credential recovery.
4. Backend service identity, MCP gateway and job queue.
5. Provider control surface.
6. Autonomous execution engine and deliverable generators.
7. End-to-end and security hardening.

Rollout stages:

- Tests and local fixtures.
- Preview deployments.
- Shadow mode that records proposed actions without mutating production.
- Restricted production canary on selected requests.
- Full autonomy after canary gates pass.

Full autonomy is the final operating mode. Shadow and canary stages are deployment validation, not permanent approval requirements.

For every repository:

- verified changes are merged into `main`;
- maintained `beta` branches are synchronized where they exist;
- production deployment must reach `READY`;
- the live domain must serve the exact `main` commit;
- runtime errors and critical workflow logs are checked before completion is reported.

## 13. Acceptance Criteria

The project is complete only when:

1. Supported files open and render inside CognizApp without an external redirect.
2. Theme and accessibility settings are preserved in the viewer.
3. Office previews are private, cached and rendered through CognizApp.
4. Existing provider credentials are not exposed, and reset/recovery works securely.
5. An MCP client can authenticate with a service identity and use all approved tools.
6. The autonomous engine can complete a representative request from intake through delivery and completion.
7. Payment and file-access rules cannot be bypassed.
8. Every mutation is idempotent and audited.
9. Kill switches and provider takeover stop further autonomous mutations.
10. Unit, integration, browser, MCP, security and production-build gates pass.
11. Changes are merged into `main` and verified on the production domains.
