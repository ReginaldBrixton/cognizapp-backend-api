/**
 * gemini-keys.ts
 *
 * Smart Gemini API key rotation with per-minute rate control.
 *
 * Rules:
 *   - Reads GEMINI_API_KEY_1 … GEMINI_API_KEY_N plus fallback GEMINI_API_KEY.
 *   - Each key must not be used more than MAX_USES_PER_KEY_PER_MINUTE times
 *     within any 60-second sliding window.
 *   - Cycles through keys in order; skips exhausted keys and wraps around.
 *   - Falls back gracefully if all keys are exhausted (returns least-recently-used key).
 */

const MAX_USES_PER_KEY_PER_MINUTE = 2
const WINDOW_MS = 60_000

interface KeyUsageEntry {
  uses: number
  windowStart: number
}

const keyUsageMap = new Map<number, KeyUsageEntry>()

function configuredKeys(): string[] {
  const numberedKeys = Object.entries(process.env)
    .map(([name, value]) => {
      const match = /^GEMINI_API_KEY_(\d+)$/.exec(name)
      return match && value?.trim()
        ? { index: Number(match[1]), value: value.trim() }
        : null
    })
    .filter((item): item is { index: number; value: string } => Boolean(item))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.value)

  const fallback =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()

  return fallback ? [...numberedKeys, fallback] : numberedKeys
}

export function getConfiguredGeminiKeyCount(): number {
  return configuredKeys().length
}

/**
 * Returns the next available Gemini API key, respecting the per-minute cap.
 *
 * Strategy: round-robin starting from the last-used index, skipping keys that
 * have hit the per-minute cap. If all keys are exhausted in this window, falls
 * back to the key with the oldest window start (closest to resetting).
 */
export async function getNextGeminiKey(): Promise<string> {
  const keys = configuredKeys()
  if (keys.length === 0) return ""

  const now = Date.now()
  const total = keys.length

  // Find the last used index (global round-robin position)
  // We store it in a module-level variable so it persists per-process
  const startIdx = (getNextGeminiKey as { _cursor?: number })._cursor ?? 0;

  let bestFallbackIdx = 0
  let bestFallbackWindowStart = Infinity

  for (let i = 0; i < total; i++) {
    const idx = (startIdx + i) % total
    let entry = keyUsageMap.get(idx)

    // Reset window if more than 60s has passed
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      entry = { uses: 0, windowStart: now }
      keyUsageMap.set(idx, entry)
    }

    if (entry.uses < MAX_USES_PER_KEY_PER_MINUTE) {
      // This key is available — use it
      entry.uses += 1;
      (getNextGeminiKey as { _cursor?: number })._cursor = (idx + 1) % total
      return keys[idx]
    }

    // Track the best fallback (key whose window will reset soonest)
    if (entry.windowStart < bestFallbackWindowStart) {
      bestFallbackWindowStart = entry.windowStart
      bestFallbackIdx = idx
    }
  }

  // All keys exhausted this window — use the fallback and still increment counter
  const fallbackEntry = keyUsageMap.get(bestFallbackIdx)!
  fallbackEntry.uses += 1;
  (getNextGeminiKey as { _cursor?: number })._cursor = (bestFallbackIdx + 1) % total
  console.warn(`[gemini-keys] All ${total} keys exhausted for this minute. Reusing least-used key (index ${bestFallbackIdx}).`)
  return keys[bestFallbackIdx]
}
