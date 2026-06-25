import { Elysia } from "elysia";

import { LRUCache } from "./lib/lru-cache-shim";

const lruCachePing = new LRUCache<string, string>({ max: 1 });
lruCachePing.set("ping", "pong");
lruCachePing.get("ping");

const app = new Elysia()
  .get("/health", () => ({ status: "ok", lru: "loaded" }))
  .get("/", () => "lru-cache shim loaded");

export default app;
