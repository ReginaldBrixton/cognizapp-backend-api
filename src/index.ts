import { Elysia } from "elysia";
import { LRUCache } from "lru-cache";

import { createApp } from "./app/create-app";

// Force lru-cache into the bundle (lru-memoizer needs it; bare side-effect
// import is dropped by the bundler because lru-cache has sideEffects:false).
void LRUCache;

const startupRetryAttempts = Number(process.env.STARTUP_RETRY_ATTEMPTS ?? "3");
const startupRetryDelayMs = Number(process.env.STARTUP_RETRY_DELAY_MS ?? "3000");

async function createAppWithRetry() {
  let lastError: unknown;

  for (let attempt = 1; attempt <= startupRetryAttempts; attempt += 1) {
    try {
      return await createApp();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      if (attempt >= startupRetryAttempts) {
        break;
      }

      console.error(
        `[startup] App initialization failed (${attempt}/${startupRetryAttempts}): ${message}. Retrying in ${startupRetryDelayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, startupRetryDelayMs));
    }
  }

  throw lastError;
}

const app = await createAppWithRetry();

// Keep a direct Elysia import in the detected entrypoint for Vercel's framework scanner.
void Elysia;

export default app;
