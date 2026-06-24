import { createClient } from "redis";

import { env } from "../config/env";

type RedisClient = ReturnType<typeof createClient>;
type MemoryEntry = { value: string; expiresAt: number };

let clientPromise: Promise<RedisClient | null> | null = null;
let warnedUnavailable = false;
let lastRedisFailureAt = 0;

const memoryCache = new Map<string, MemoryEntry>();
const REDIS_RETRY_COOLDOWN_MS = 30_000;

function cacheConfigured() {
  return Boolean(env.redisUrl || (env.redisHost && env.redisPassword));
}

function key(name: string) {
  return `${env.redisKeyPrefix}:${name}`;
}

function getMemory(redisKey: string) {
  const entry = memoryCache.get(redisKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(redisKey);
    return null;
  }

  return entry.value;
}

function setMemory(redisKey: string, value: string, ttlSeconds: number) {
  memoryCache.set(redisKey, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function deleteMemoryPattern(pattern: string) {
  const escaped = key(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const matcher = new RegExp(`^${escaped}$`);

  for (const redisKey of memoryCache.keys()) {
    if (matcher.test(redisKey)) {
      memoryCache.delete(redisKey);
    }
  }
}

function warnRedis(error: unknown) {
  if (warnedUnavailable) {
    return;
  }
  warnedUnavailable = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[redis] cache unavailable; continuing without Redis: ${message}`,
  );
}

async function getClient() {
  if (!cacheConfigured()) {
    return null;
  }

  if (
    clientPromise &&
    lastRedisFailureAt &&
    Date.now() - lastRedisFailureAt >= REDIS_RETRY_COOLDOWN_MS
  ) {
    clientPromise = null;
  }

  clientPromise ??= (async () => {
    try {
      const client = env.redisUrl
        ? createClient({ url: env.redisUrl })
        : createClient({
            username: env.redisUser,
            password: env.redisPassword,
            socket: env.redisTls
              ? {
                  host: env.redisHost,
                  port: env.redisPort,
                  tls: true,
                  connectTimeout: 1000,
                  reconnectStrategy: false,
                }
              : {
                  host: env.redisHost,
                  port: env.redisPort,
                  connectTimeout: 1000,
                  reconnectStrategy: false,
                },
          });

      client.on("error", warnRedis);
      await Promise.race([
        client.connect(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Redis connection timed out")),
            1500,
          ),
        ),
      ]);
      lastRedisFailureAt = 0;
      return client;
    } catch (error) {
      lastRedisFailureAt = Date.now();
      warnRedis(error);
      return null;
    }
  })();

  return clientPromise;
}

export const cache = {
  isConfigured: cacheConfigured,

  key,

  async getJson<T>(name: string): Promise<T | null> {
    const redisKey = key(name);
    const memoryValue = getMemory(redisKey);
    if (memoryValue) {
      return JSON.parse(memoryValue) as T;
    }

    try {
      const client = await getClient();
      const value = await client?.get(redisKey);
      if (value != null) {
        setMemory(redisKey, value, 30);
        return JSON.parse(value) as T;
      }

      return null;
    } catch (error) {
      warnRedis(error);
      return null;
    }
  },

  async setJson(name: string, value: unknown, ttlSeconds: number) {
    const redisKey = key(name);
    const serialized = JSON.stringify(value);
    setMemory(redisKey, serialized, ttlSeconds);

    void (async () => {
      try {
        const client = await getClient();
        if (!client) {
          return;
        }
        await client.set(redisKey, serialized, { EX: ttlSeconds });
      } catch (error) {
        warnRedis(error);
      }
    })();
  },

  async rememberJson<T>(
    name: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.getJson<T>(name);
    if (cached !== null) {
      return cached;
    }
    const value = await loader();
    await this.setJson(name, value, ttlSeconds);
    return value;
  },

  async increment(name: string, ttlSeconds = 300) {
    const redisKey = key(name);
    const memoryKey = `${redisKey}:counter`;
    const currentMemory = Number(getMemory(memoryKey) ?? "0") + 1;
    setMemory(memoryKey, String(currentMemory), ttlSeconds);

    try {
      const client = await getClient();
      if (!client) {
        return currentMemory;
      }
      const value = await client.incr(redisKey);
      if (value === 1) {
        await client.expire(redisKey, ttlSeconds);
      }
      return value;
    } catch (error) {
      warnRedis(error);
      return currentMemory;
    }
  },

  async deletePattern(pattern: string) {
    deleteMemoryPattern(pattern);

    try {
      const client = await getClient();
      if (!client) {
        return;
      }

      for await (const item of client.scanIterator({
        MATCH: key(pattern),
        COUNT: 100,
      })) {
        const redisKeys = Array.isArray(item) ? item : [item];
        if (redisKeys.length > 0) {
          await Promise.all(redisKeys.map((redisKey) => client.del(redisKey)));
        }
      }
    } catch (error) {
      warnRedis(error);
    }
  },
};
