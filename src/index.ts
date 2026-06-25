import { Elysia } from "elysia";
import { LRUCache } from "lru-cache";

import { createApp } from "./app/create-app";

// Force lru-cache into the bundle (lru-memoizer needs it; bare side-effect
// import is dropped by the bundler because lru-cache has sideEffects:false).
void LRUCache;

// Lazy initialization: call createApp() on the first request, not at module
// load time. A top-level `await createApp()` crashes the whole Bun module
// silently (Vercel logs "ResolveMessage {}") if createApp throws. Keeping the
// import static ensures all dependencies are included in the Vercel bundle.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(): Promise<any> {
  if (!appPromise) {
    appPromise = createApp().catch((error) => {
      appPromise = null;
      const name = error instanceof Error ? error.constructor.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[vercel] Failed to initialize app: ${name}: ${message}`);
      if (error instanceof Error) console.error(`[vercel] Stack: ${error.stack}`);
      throw error;
    });
  }
  return appPromise;
}

// Export a lightweight Elysia shell so Vercel's framework scanner detects
// this as an Elysia app. All requests are proxied to the real app.
const app = new Elysia().all("*", async ({ request }) => {
  try {
    const realApp = await getApp();
    return realApp.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: "Internal Server Error", message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

export default app;
