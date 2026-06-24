# Changelog

All notable changes to CognizAP will be documented in this file.

## [1.0.0] - 2024-XX-XX

### Added
- **Workspace Architecture**
  - Modular workspace system with projects, analysis, collections, and settings
  - workspace-projects module for project management
  - workspace-analysis module with humanise, textcompare, textidentify, factcheck
  - workspace-collections module for organizing content
  - workspace-settings module for workspace configuration

- **Authentication & Authorization**
  - Firebase Auth integration
  - JWT token-based sessions
  - Role-based permissions (user, premium, support, dev, admin, master)
  - Dev token endpoint for testing

- **Core API Endpoints**
  - `/api/auth/*` - Authentication routes
  - `/api/user/workspace/*` - Workspace management
  - `/api/workspace/:id/projects/*` - Project CRUD
  - `/api/workspace/:id/analysis/*` - AI analysis tools
  - `/api/workspace/:id/collections/*` - Collection management
  - `/api/workspace/:id/settings/*` - Workspace settings

- **Database Schema**
  - cognizap schema for auth tables
  - workspaces, workspace_members, workspace_projects
  - project_documents, project_slides, project_notes, project_tasks
  - workspace_analysis with child analysis tables
  - workspace_collections with collection_items
  - workspace_settings_v2 with JSONB configuration

- **Documentation**
  - API documentation (`api.md`)
  - Architecture documentation (`architecture.md`)
  - Usage guide (`usage.md`)
  - ERD diagrams in mermaid format

### Technical
- Bun + Elysia + TypeScript runtime
- PostgreSQL with JSONB support
- postgres.js for SQL queries
- Firebase Admin SDK for auth
- Swagger/OpenAPI documentation

## [0.9.0] - 2024-XX-XX

### Added
- Initial workspace management
- User authentication via Firebase
- Basic project structure

## Migration Notes

### From 0.9.0 to 1.0.0
- Settings moved from `user_settings` to workspace-specific `workspace_settings_v2`
- Projects now organized under workspaces via `workspace_projects`
- New analysis tables require migration:
  ```sql
  CREATE TABLE workspace_analysis (...);
  CREATE TABLE analysis_humanise (...);
  CREATE TABLE analysis_textcompare (...);
  CREATE TABLE analysis_textidentify (...);
  CREATE TABLE analysis_factcheck (...);
  ```
- Collections feature added with `workspace_collections` and `collection_items`

## Deprecated
- `settings` module renamed to `user-settings`
- `dashboard` module renamed to `user-dashboard`
- Auth routes use `/api/auth/*` prefix

## Security
- All endpoints require authentication (except health check)
- Row-level security via workspace membership
- Soft deletes for data recovery
- Token refresh mechanism

## Coming Soon
- WebSocket support for real-time collaboration
- File upload endpoints
- Email notifications
- Webhook integrations
