import postgres, { type Sql } from "postgres";
import dns from "node:dns";

import { env } from "../config/env";

// Force IPv4-only DNS resolution. Neon's pooler hostname resolves to both
// IPv4 and IPv6 addresses. IPv6 connections fail (ECONNREFUSED) on many
// networks, and Node's internalConnectMultiple tries each address sequentially
// with a per-address timeout (~5s). With 6 addresses total, the connect_timeout
// fires before it can reach the working IPv4 ones. By overriding dns.lookup to
// filter to family 4 only, we ensure only IPv4 addresses are returned.
const originalLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = { ...options, family: 4 };
  return originalLookup.call(this, hostname, options, callback);
} as typeof dns.lookup;

let dbInstance: Sql | null = null;

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = postgres(env.databaseUrl, {
    max: 10,
    idle_timeout: 60,
    connect_timeout: 30,
    max_lifetime: 60 * 30,
    application_name: "cognizap-api",
    prepare: false,
    // Suppress migration NOTICE messages (42P06, 42P07, 42710) from logs
    onnotice: (notice) => {
      if (!["42P06", "42P07", "42710"].includes(notice.code ?? "")) {
        console.warn("[pg notice]", notice.message);
      }
    },
    transform: {
      undefined: null,
    },
  });

  return dbInstance;
}

export async function closeDb() {
  if (!dbInstance) {
    return;
  }
  await dbInstance.end();
  dbInstance = null;
}

/**
 * Detects transient connection errors that are safe to retry.
 * These occur when the DB connection pool has stale/idle connections
 * that get dropped by the server or network.
 */
export function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const name = error.name.toLowerCase();
  const stack = error.stack?.toLowerCase() ?? "";
  return (
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("connect timeout") ||
    msg.includes("connection terminated") ||
    msg.includes("connection refused") ||
    msg.includes("aggregateerror") ||
    msg.includes("afterconnectmultiple") ||
    msg.includes("socket has been ended") ||
    // NodeAggregateError from internalConnectMultiple has an empty message
    // but its name/stack contains the connection error signatures
    name.includes("aggregateerror") ||
    stack.includes("internalconnectmultiple") ||
    stack.includes("afterconnectmultiple") ||
    stack.includes("connect timeout") ||
    stack.includes("econnreset") ||
    stack.includes("connection refused") ||
    stack.includes("connection terminated")
  );
}

/**
 * Wraps a DB query function and retries once on transient connection errors.
 * The first attempt may fail due to a stale idle connection in the pool;
 * the retry uses a fresh connection.
 */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isTransientDbError(error)) {
      console.warn("[db] Transient connection error, retrying once...", {
        message: error instanceof Error ? error.message : String(error),
      });
      return await fn();
    }
    throw error;
  }
}
