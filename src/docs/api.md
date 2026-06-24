# CognizAP Users API Documentation

## Base URL
- Development: `http://localhost:4040`
- Production: `https://api.cognizapp.com`

## Authentication
All API requests (except health check and auth endpoints) require a Bearer token in the Authorization header:
```
Authorization: Bearer <access_token>
```

## Endpoints

For expanded curl examples and the local browser testing pages, see
[`src/docs/endpoint-usage.md`](./endpoint-usage.md).

### Health Check
```
GET /health
```
Returns: `OK`

### Local Smoke Test
Development only:
```
GET /__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test
```
Returns: `{ success: true, data: { status, message, environment, docs, health } }`

### Authentication

#### Exchange Firebase Token
```
  POST /api/auth/firebase/exchange
Body: { firebaseToken?: string }
Returns: { userId, email, accessToken, refreshToken, expiresIn, isNewUser }
```

#### Refresh Token
```
  POST /api/auth/refresh
Body: { refreshToken?: string, refresh_token?: string }
Returns: { userId, email, accessToken, refreshToken, expiresIn }
```

#### Logout
```
  POST /api/auth/logout
Auth Required: Yes
Returns: { message: "Logged out successfully" }
```

#### Get Current User
```
  GET /api/auth/me
Auth Required: Yes
Returns: { user: UserRecord }
```

#### List Sessions
```
  GET /api/auth/sessions
Auth Required: Yes
Returns: { sessions: SessionRecord[] }
```

### Workspaces

#### List Workspaces
```
GET /api/user/workspace?page=1&page_size=20
Auth Required: Yes
Returns: { workspaces, policy, pagination }
```

#### Create Workspace
```
POST /api/user/workspace
Body: { name, description?, color?, slug?, settings?, metadata?, limits? }
Auth Required: Yes
Returns: { workspace, policy }
```

#### Get Workspace Details
```
GET /api/user/workspace/details?id=<workspaceId>
Auth Required: Yes
Returns: { workspace }
```

#### Update Workspace
```
PUT /api/user/workspace/details?id=<workspaceId>
PATCH /api/user/workspace/details?id=<workspaceId>
Body: <any fields to update>
Auth Required: Yes
Returns: { workspace }
```

#### Delete Workspace
```
DELETE /api/user/workspace/details?id=<workspaceId>
Auth Required: Yes
Returns: { message }
```

### User Settings

#### Get Settings
```
GET /api/user/settings
Auth Required: Yes
Returns: { settings: UserSettings }
```

#### Get Specific Section
```
GET /api/user/settings/:section
Auth Required: Yes
Returns: { [section]: SectionData }
```

#### Update Single Section
```
PUT /api/user/settings/:section
Body: { ...section_fields }
Auth Required: Yes
Returns: { [section]: SectionData }
```

#### Update Multiple Sections
```
PUT /api/user/settings
Body: { account?: {}, profile?: {}, appearance?: {}, ... }
Auth Required: Yes
Returns: { settings: UserSettings }
```

**Available Sections:**
- `account` - email, password, 2FA, subscription, billing
- `profile` - display name, bio, location, social links
- `appearance` - theme, font size, density, sidebar
- `notifications` - email, in-app, push preferences
- `preferences` - language, timezone, date/time formats
- `security` - login alerts, trusted devices, passwords
- `onboarding` - completion status, current step
- `privacy` - visibility, analytics, data retention
- `storage` - usage, quota, cleanup settings
- `ai` - enabled, models, privacy mode, history

### Workspace Projects

#### List Projects
```
GET /api/workspace/:workspaceId/projects
Auth Required: Yes
Returns: Project[]
```

#### Create Project
```
POST /api/workspace/:workspaceId/projects
Body: { title, description?, visibility?, fieldOfStudy?, projectType?, keywords?, deadline? }
Auth Required: Yes
Returns: Project
```

#### Get Project
```
GET /api/workspace/:workspaceId/projects/:projectId
Auth Required: Yes
Returns: Project
```

#### Update Project
```
PUT /api/workspace/:workspaceId/projects/:projectId
Body: <any fields to update>
Auth Required: Yes
Returns: Project
```

#### Delete Project
```
DELETE /api/workspace/:workspaceId/projects/:projectId
Auth Required: Yes
```

### Workspace Analysis

#### List Analysis
```
GET /api/workspace/:workspaceId/analysis
Auth Required: Yes
Returns: WorkspaceAnalysis[]
```

#### Create Humanise Analysis
```
POST /api/workspace/:workspaceId/analysis/humanise
Body: { title, originalText }
Auth Required: Yes
Returns: WorkspaceAnalysis
```

#### Create Text Compare Analysis
```
POST /api/workspace/:workspaceId/analysis/textcompare
Body: { title, textA, textB }
Auth Required: Yes
Returns: WorkspaceAnalysis
```

#### Create Text Identify Analysis
```
POST /api/workspace/:workspaceId/analysis/textidentify
Body: { title, inputText }
Auth Required: Yes
Returns: WorkspaceAnalysis
```

#### Create Fact Check Analysis
```
POST /api/workspace/:workspaceId/analysis/factcheck
Body: { title, claimText }
Auth Required: Yes
Returns: WorkspaceAnalysis
```

### Workspace Collections

#### List Collections
```
GET /api/workspace/:workspaceId/collections
Auth Required: Yes
Returns: Collection[]
```

#### Create Collection
```
POST /api/workspace/:workspaceId/collections
Body: { name, description?, collectionType, parentId? }
Auth Required: Yes
Returns: Collection
```

#### Add Item to Collection
```
POST /api/workspace/:workspaceId/collections/:collectionId/items
Body: { itemType, itemId }
Auth Required: Yes
Returns: CollectionItem
```

### Workspace Settings

#### Get Settings
```
GET /api/workspace/:workspaceId/settings
Auth Required: Yes
Returns: { settings: WorkspaceSettings }
```

#### Get Specific Section
```
GET /api/workspace/:workspaceId/settings/:section
Auth Required: Yes
Returns: { [section]: SectionData }
```

#### Update Single Section
```
PUT /api/workspace/:workspaceId/settings/:section
Body: { ...section_fields }
Auth Required: Yes
Returns: { [section]: SectionData }
```

#### Update Multiple Sections
```
PUT /api/workspace/:workspaceId/settings
Body: { general?: {}, appearance?: {}, notifications?: {}, ... }
Auth Required: Yes
Returns: { settings: WorkspaceSettings }
```

**Available Sections:**
- `general` - name, description, visibility, invites
- `appearance` - color, icon, avatar, theme
- `notifications` - enabled, channels, events, digest
- `security` - 2FA, session timeout, retention, IP whitelist
- `limits` - max members, projects, storage, API calls (admin only)
- `ai` - enabled, models, token limits, features
- `access` - public access, SSO, domain restrictions
- `features` - toggles for projects, analysis, collections, etc.
- `storage` - max file size, allowed types, cleanup
- `integrations` - third-party connections
- `billing` - plan, payment info (admin only)

## Error Responses
All errors follow this format:
```json
{
  "success": false,
  "error": "Error message",
  "errorCode": "error_code",
  "details": {}
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request / Validation Error
- `401` - Unauthorized (missing or invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error
