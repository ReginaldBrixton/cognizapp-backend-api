import { Elysia } from "elysia";

// Force lru-cache into the runtime node_modules by requiring it at module
// load time. lru-cache's CommonJS build uses a dynamic import for the
// node:diagnostics_channel optional dependency, so it is safer in Vercel's
// Bun serverless sandbox than the ESM node-specific build, which statically
// imports node:diagnostics_channel.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LRUCache } = require("lru-cache") as typeof import("lru-cache");
const lruCachePing = new LRUCache<string, string>({ max: 1 });
lruCachePing.set("ping", "pong");
lruCachePing.get("ping");

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
