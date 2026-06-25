import { Elysia } from "elysia";

import { LRUCache } from "./lib/lru-cache-shim";

// Exercise the import so it cannot be tree-shaken and lru-cache is included in
// the deployment bundle. lru-memoizer (via jwks-rsa / firebase-admin) needs it
// available for require() at runtime.
const lruCachePing = new LRUCache<string, string>({ max: 1 });
lruCachePing.set("ping", "pong");
lruCachePing.get("ping");

// Lazy initialization: create the real app on the first request. This avoids
// top-level await circular-dependency crashes ("Requested module is not
// instantiated yet") and keeps the Elysia default export available for
// Vercel's framework scanner.
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
