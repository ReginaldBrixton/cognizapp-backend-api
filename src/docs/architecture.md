# CognizAP Architecture

## System Overview

CognizAP is a workspace-based collaboration platform built on a modular architecture using:
- **Runtime**: Bun + Elysia (TypeScript)
- **Database**: PostgreSQL with JSONB support
- **Auth**: Firebase Auth + Custom JWT Sessions
- **ORM**: postgres.js for SQL queries

## Directory Structure

```
src/
├── app/                    # Application bootstrap
│   └── create-app.ts       # Main app factory
├── config/                 # Configuration
│   └── env.ts              # Environment variables
├── lib/                    # Shared utilities
│   ├── db.ts               # Database connection
│   ├── http.ts             # HTTP helpers
│   ├── errors.ts           # Error classes
│   ├── crypto.ts           # Crypto utilities
│   ├── firebase.ts         # Firebase Admin
│   └── firebase-sync.ts    # Firebase sync
├── modules/                # Feature modules
│   ├── user-auth/          # Authentication
│   ├── user-settings/      # User settings
│   ├── user-dashboard/     # User dashboard
│   ├── workspace/          # Core workspace
│   ├── workspace-projects/ # Projects
│   ├── workspace-analysis/ # AI Analysis
│   ├── workspace-collections/ # Collections
│   ├── workspace-settings/ # Workspace settings
│   ├── notifications/      # Notifications
│   ├── onboarding/         # Onboarding
│   ├── admin/              # Admin panel
│   ├── support/            # Support
│   ├── system/             # System operations
│   └── audit/              # Audit logging
└── docs/                   # Documentation
```

## Module Pattern

Each module follows this structure:
```
module-name/
├── types.ts       # TypeScript interfaces
├── routes.ts      # HTTP route handlers
├── service.ts     # Business logic
├── repository.ts  # Database operations
└── *.mermaid     # Architecture diagrams
```

## Database Schema

### Core Tables
- `auth.users` - User accounts
- `auth.sessions` - Active sessions
- `auth.activity_log` - User activity
- `app.workspaces` - Workspace entities
- `app.workspace_members` - Membership records
- `app.workspace_projects` - Projects
- `app.workspace_analysis` - AI analysis jobs
- `app.workspace_collections` - Collections/folders
- `app.workspace_settings` - Workspace configuration (JSONB sections)

### Project Content Hierarchy
```
workspaces
  └── workspace_projects
      ├── project_documents
      ├── project_slides
      ├── project_notes
      └── project_tasks (link to docs/slides/notes)
```

### Analysis Types
```
workspace_analysis
  ├── analysis_humanise
  ├── analysis_textcompare
  ├── analysis_textidentify
  └── analysis_factcheck
```

## Authentication Flow

1. User authenticates with Firebase (Google, Email, etc.)
2. Frontend sends Firebase token to `/api/auth/firebase/exchange`
3. Backend verifies token with Firebase
4. Creates/updates user in PostgreSQL
5. Creates session with JWT tokens
6. Returns access token + refresh token

## Authorization

- JWT tokens validated via `resolveAuth` middleware
- Permissions checked via `requirePermission` middleware
- Role hierarchy: user < premium < support < dev < admin < master

## Settings Architecture

### User Settings (`user-settings` module)
User-scoped settings stored in `user_settings` table:
- **Sections**: account, profile, appearance, notifications, preferences, security, onboarding, privacy, storage, ai
- **Routes**: `/api/user/settings/*`
- **Pattern**: Section-based JSONB with merge updates

### Workspace Settings (`workspace-settings` module)
Workspace-scoped settings stored in `workspace_settings` table:
- **Sections**: general, appearance, notifications, security, limits, ai, access, features, storage, integrations, billing
- **Routes**: `/api/workspace/:id/settings/*`
- **Pattern**: Section-based JSONB with merge updates
- **Permissions**: `limits` and `billing` sections are admin-only

## API Routing

Routes follow RESTful conventions:
```
/api/auth/*           - Authentication
/api/user/*           - User-specific (settings, workspaces, dashboard)
/api/workspace/:id/*  - Workspace-scoped (projects, analysis, collections, settings)
```

## Key Design Decisions

1. **JSONB for Flexibility** - Settings, metadata, and content use JSONB for schema evolution
2. **Soft Deletes** - All tables have `deleted_at` for recovery
3. **Tenant Isolation** - Workspaces isolate data; membership controls access
4. **Modular Services** - Each feature has its own service layer
5. **Type Safety** - Full TypeScript with strict types

## Scaling Considerations

- PostgreSQL with proper indexing
- JSONB GIN indexes for metadata queries
- Row-level security via workspace membership
- Connection pooling via postgres.js
