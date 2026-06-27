import { Elysia } from "elysia";

// Minimal Elysia app for Vercel's framework scanner.
// The real API is handled by api/index.ts (rewritten via vercel.json).
const app = new Elysia()
  .get("/health", () => ({ status: "ok" }))
  .get("/", () => "cognizapp-backend-api");

export default app;
