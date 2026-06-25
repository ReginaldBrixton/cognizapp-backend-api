## Start The Server

```bash
bun install
cp .env.example .env
bun run dev
```

`bun run dev` now does both of these by default:
- starts the Bun server with auto reload
- runs a Biome watcher that auto-fixes lintable issues as files change

Local URLs:
- App root: `http://localhost:3001/`
- Swagger docs: `http://localhost:3001/docs`
- Smoke test: `http://localhost:3001/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test`

## Start Another Local Server

If you want a second local instance, start it on a new port.

PowerShell:
```powershell
$env:PORT=3012
bun run dev
```

Bash:
```bash
PORT=3012 bun run dev
```

You can also give that extra instance its own smoke-test URL:

PowerShell:
```powershell
$env:PORT=3012
$env:LOCAL_TEST_ENDPOINT_PATH="/__local/cognizap-users/aurora-drift-harbor-3012/smoke-test"
bun run dev
```

## Deploy

```bash
vc deploy
```

## Testing Policy

Use the real-user backend testing rulebook:

- [TESTING_REAL_USER_RULEBOOK.md](./TESTING_REAL_USER_RULEBOOK.md)
# Deployment trigger
