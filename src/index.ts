import { Elysia } from "elysia";

// Minimal smoke-test handler: no external imports, no lazy initialization.
// If this works, the crash is caused by createApp or lru-cache (or another
// transitive dependency) being loaded at module load time.
const app = new Elysia().get("/health", () => ({ status: "ok" })).get("/", () => "cognizapp-backend-api");

export default app;
