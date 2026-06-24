# CognizAP Users Endpoint Usage

Base URLs:
- Local: `http://localhost:4040`
- Production: `https://api.cognizapp.com`

Use JSON for request bodies and pass the CognizAP access token on protected routes:

```bash
curl -sS "$BASE/api/auth/me" -H "Authorization: Bearer $ACCESS_TOKEN"
```

## Authentication

`GET /api/auth/health`
Public service health check.

`POST /api/auth/firebase/exchange`
Login/register with a real Firebase Google ID token. The backend accepts only `google.com` Firebase identities and creates the user if it is new.

```bash
curl -sS "$BASE/api/auth/firebase/exchange" \
  -H "Content-Type: application/json" \
  -d "{\"firebaseToken\":\"$FIREBASE_ID_TOKEN\"}"
```

`POST /api/auth/refresh`
Rotates refresh and access tokens. Accepts the `refresh_token` cookie or `refreshToken` body field.

`GET /api/auth/me`, `GET /api/auth/sessions`, `GET /api/auth/identities`
Current user profile, active sessions, and linked provider identity.

`POST /api/auth/logout`, `POST /api/auth/logout-all?keep_current=true`, `DELETE /api/auth/sessions/:id`
Session revocation endpoints.

`POST /api/auth/forgot-password`
Returns a generic success message to avoid leaking whether an email exists.

## User Experience

`GET /api/user/dashboard`
Aggregated user home payload: user, settings, workspaces, stats, sessions, recent notifications.

`GET /api/user/dashboard/stats`, `POST /api/user/dashboard/stats/refresh`
Dashboard stat read and refresh.

`GET /api/user/settings`
Returns all user settings sections.

`GET /api/user/settings/:section`
Valid sections include `account`, `profile`, `appearance`, `notifications`, `preferences`, `security`, `onboarding`, `privacy`, and `storage`.

`PUT /api/user/settings`
Merges one or more settings sections.

```bash
curl -sS -X PUT "$BASE/api/user/settings" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"appearance\":{\"theme\":\"dark\"}}"
```

`GET /api/user/notifications`, `GET /api/user/notifications/unread-count`, `POST /api/user/notifications/read-all`
Notification list and read state operations.

## Workspace

`GET /api/user/workspace`
Lists owned and member workspaces.

`GET /api/user/workspace/default`
Returns or bootstraps the default workspace.

`POST /api/user/workspace`
Creates a workspace if the caller has capacity.

`GET|PUT|PATCH|DELETE /api/user/workspace/details?id=<workspaceId>`
Workspace detail lifecycle.

`GET|POST /api/user/workspace/members?workspace_id=<workspaceId>`
List or add members.

`PUT|PATCH /api/user/workspace/members/role?workspace_id=<workspaceId>`
Change a member role.

`DELETE /api/user/workspace/members/remove?workspace_id=<workspaceId>&member_uid=<userId>`
Remove a member.

`GET /api/user/workspace/activity?workspace_id=<workspaceId>`
Workspace activity stream.

`GET /api/user/workspace/dashboard?workspaceId=<workspaceId>`
Workspace dashboard summary.

`GET|PUT|PATCH /api/user/workspace/settings?workspace_id=<workspaceId>`
Workspace settings all-section read/update.

`GET|PUT|PATCH /api/user/workspace/settings/:section?workspace_id=<workspaceId>`
Single workspace settings section.

`GET /api/user/workspace/:id/storage`, `GET /api/user/workspace/:id/storage/quota`, `POST /api/user/workspace/:id/storage/check-quota`
Storage and quota checks.

## Projects And Content

Project routes use `/api/workspace/:workspaceId/projects`.

`GET /`, `POST /`, `GET /:projectId`, `PUT /:projectId`, `DELETE /:projectId`
Project CRUD.

Project content routes use `/api/workspace/:workspaceId/projects/:projectId`.

Documents:
- `GET|POST /documents`
- `GET|PUT|DELETE /documents/:documentId`
- `GET /documents/:documentId/versions`
- `POST /documents/:documentId/restore/:version`
- `POST /documents/batch`

Comments:
- `GET /documents/:documentId/comments`
- `PUT /documents/:documentId/comments/:commentId`

Slides, notes, tasks, task lists, and diagrams follow the same collection pattern:
- `GET|POST /slides`, `/notes`, `/tasks`, `/task-lists`, `/diagrams`
- `GET|PUT|DELETE /:id`
- Batch endpoints where implemented.

Analysis routes use `/api/workspace/:workspaceId/analysis`:
- `GET /`
- `POST /humanise`
- `POST /textcompare`
- `POST /textidentify`
- `POST /factcheck`
- `GET /:analysisId`

Collections use `/api/workspace/:workspaceId/collections`:
- `GET|POST /`
- `GET|PUT|DELETE /:collectionId`
- `POST /:collectionId/items`
- `DELETE /:collectionId/items/:itemId`

## Admin And Support

Admin routes require admin permissions:
- `GET /api/admin/users`
- `GET /api/admin/users/:id`
- `PUT /api/admin/users/:id/status`
- `PUT /api/admin/users/:id/role`
- `GET /api/admin/permissions`
- `GET /api/admin/permissions/:role`
- `GET /api/admin/stats`

Support routes require support permissions:
- `GET /api/support/users`
- `GET /api/support/users/:id`
- `GET /api/support/workspaces/:id`
- `POST /api/support/users/:id/message`

Provider sync routes require developer operations permissions:
- `GET /api/auth/users`
- `POST /api/auth/sync/:uid`
- `POST /api/auth/sync-all`
- `POST /api/auth/firebase-sync`

## Browser Test Pages

Local development exposes a live browser console:
- `/testing/`
- `/testing/auth.html`
- `/testing/user.html`
- `/testing/workspace.html`
- `/testing/projects.html`
- `/testing/content.html`
- `/testing/admin.html`
