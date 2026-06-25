import { Elysia } from "elysia";

// Minimal Elysia app for Vercel's framework scanner.
// The actual API routes are served by api/index.ts with includeFiles.
const app = new Elysia().get("/health", () => ({ status: "ok" }));

export default app;
