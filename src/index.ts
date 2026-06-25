import { Elysia } from "elysia";

// src/index.ts is no longer Vercel's production entrypoint.
// Vercel uses api/index.ts (Web fetch export) because we need includeFiles
// to force lru-cache into the runtime node_modules for lru-memoizer.
// This file is kept for local development and as a fallback Elysia app.
const app = new Elysia().get("/health", () => ({ status: "ok" }));

export default app;
