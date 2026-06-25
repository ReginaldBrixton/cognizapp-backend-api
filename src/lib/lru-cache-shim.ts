// Re-export the generic ESM build of lru-cache.
// The main package's "node" condition resolves to a build that statically
// imports node:diagnostics_channel, which crashes in Vercel's Bun serverless
// environment. The generic ESM build uses a dynamic fallback instead.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no types for the direct path
export { LRUCache } from "lru-cache/dist/esm/index.min.js";
