import { Elysia } from "elysia";

// Minimal Elysia app for Vercel's framework scanner.
// The actual API routes are served by api/index.ts because it can use
// includeFiles to force lru-cache into the runtime node_modules.
const app = new Elysia().get("/health", () => ({ status: "ok" }));

export default app;
