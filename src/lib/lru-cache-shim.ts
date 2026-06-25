// Re-export the CommonJS build of lru-cache.
// The main package's ESM "node" condition statically imports
// node:diagnostics_channel, which crashes in Vercel's Bun serverless sandbox.
// The CommonJS build uses a dynamic fallback import instead.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no types for the direct path
export { LRUCache } from "lru-cache/dist/commonjs/index.min.js";
