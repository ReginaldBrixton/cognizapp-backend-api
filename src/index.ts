import { Elysia } from "elysia";
import { LRUCache } from "lru-cache";

// Force lru-cache into the bundle (lru-memoizer needs it; bare side-effect
// import is dropped by the bundler because lru-cache has sideEffects:false).
void LRUCache;

// Use lazy initialization so module load never crashes. The real Elysia app
// is created on the first request, keeping the same retry logic as before.
// This is critical for Vercel: a top-level `await createApp()` that throws
// crashes the entire module silently (Vercel logs only "ResolveMessage {}").

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(): Promise<any> {
  if (!appPromise) {
    appPromise = import("./app/create-app")
      .then((mod) => mod.createApp())
      .catch((error) => {
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

// Export a lightweight Elysia shell as default so Vercel's framework scanner
// detects this as an Elysia app. All requests are proxied to the real app.
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
