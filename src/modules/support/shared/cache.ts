/**
 * Support module caching helpers.
 *
 * Provides a Redis-backed or in-memory cache for support data.
 */

import { cache } from "../../../lib/cache";

export const PROVIDER_DASHBOARD_CACHE_SECONDS = 30;

type MemoryCacheEntry<T> = {
	expiresAt: number;
	value: T;
};

export const supportMemoryCache = new Map<string, MemoryCacheEntry<unknown>>();

export async function rememberSupportJson<T>(
	name: string,
	ttlSeconds: number,
	loader: () => Promise<T>,
): Promise<T> {
	if (cache.isConfigured()) {
		return cache.rememberJson(name, ttlSeconds, loader);
	}

	const now = Date.now();
	const cached = supportMemoryCache.get(name) as MemoryCacheEntry<T> | undefined;
	if (cached && cached.expiresAt > now) {
		return cached.value;
	}

	const value = await loader();
	supportMemoryCache.set(name, {
		expiresAt: now + ttlSeconds * 1000,
		value,
	});
	return value;
}

export async function invalidateSupportCache(userId: string) {
	await Promise.all([
		cache.deletePattern(`support:${userId}:*`),
		cache.deletePattern(`user:${userId}:dashboard*`),
	]);
}

export async function invalidateProviderSupportCache() {
	for (const name of supportMemoryCache.keys()) {
		if (
			name.startsWith("support:provider-dashboard:") ||
			name.startsWith("support:provider-requests:")
		) {
			supportMemoryCache.delete(name);
		}
	}
	await Promise.all([
		cache.deletePattern("support:provider-dashboard:*"),
		cache.deletePattern("support:provider-requests:*"),
	]);
}
