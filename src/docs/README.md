# CognizAP Documentation

Welcome to CognizAP - A workspace-based collaboration platform.

## Quick Links

- [API Documentation](./api.md) - Complete API reference
- [Architecture](./architecture.md) - System design and patterns
- [Usage Guide](./usage.md) - Integration examples
- [Changelog](./CHANGELOG.md) - Version history

## Project Structure

```text
cognizap-users/
|-- src/
|   |-- docs/           # Documentation
|   |-- app/            # Application bootstrap
|   |-- modules/        # Feature modules
|   |-- lib/            # Utilities
|   `-- config/         # Configuration
|-- diagrams/           # ERD diagrams
|-- tests/              # Test files
`-- scripts/            # Migration scripts
```

## Getting Started

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. **Start the development server**
   ```bash
   bun run dev
   ```

`bun run dev` starts the API with Bun auto reload and a Biome watcher that auto-fixes lintable issues while you work.

Default local URLs:
- App root: `http://localhost:4040/`
- Swagger docs: `http://localhost:4040/docs`
- Smoke test: `http://localhost:4040/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test`

To start another local server, choose a different port before running `bun run dev`.

PowerShell:
```powershell
$env:PORT=3012
bun run dev
```

## Modules Overview

| Module | Description | Routes |
|--------|-------------|--------|
| user-auth | Authentication | `/api/auth/*` |
| user-settings | User preferences | `/api/user/settings/*` |
| user-dashboard | User dashboard | `/api/user/dashboard` |
| workspace | Core workspace | `/api/user/workspace/*` |
| workspace-projects | Projects | `/api/workspace/:id/projects/*` |
| workspace-analysis | AI analysis | `/api/workspace/:id/analysis/*` |
| workspace-collections | Collections | `/api/workspace/:id/collections/*` |
| workspace-settings | Workspace config | `/api/workspace/:id/settings/*` |
| notifications | Notifications | `/api/user/notifications/*` |
| admin | Admin panel | `/api/admin/*` |
| support | Support tools | `/api/support/*` |

## Database

See ERD diagrams in:
- `diagrams/schema.mermaid` - Full database schema
- `src/modules/workspace/workspace.mermaid` - Workspace module
- `src/modules/user-auth/auth.mermaid` - Auth module

## Contributing

1. Follow the module pattern: `types.ts`, `routes.ts`, `service.ts`, `repository.ts`
2. Use TypeScript strict types
3. Add JSONB handling with `JSON.stringify()` for complex objects
4. Include soft deletes (`deleted_at`)
5. Run `bun run lint` before sharing changes if the watcher is not already running
6. Document new endpoints in `api.md`

## License

Proprietary - CognizAP Team
