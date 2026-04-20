import { createHash } from "node:crypto";
import { LruCache } from "./lru-cache.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The contract that `ToolExecutor` and `Agent` depend on.
 *
 * Program to this interface rather than `ResultCache` directly. Doing so lets
 * you swap in alternative backends (Redis, Memcached, a test double) without
 * touching any orchestration code.
 *
 * @example Injecting a shared in-process cache
 * ```ts
 * const cache: Cache = new ResultCache();
 * const agent1 = new Agent(registry, { model }, { cache });
 * const agent2 = new Agent(registry, { model }, { cache });
 * ```
 */
export interface Cache {
  /**
   * Pre-registers a tool's cache capacity. Call this once per tool before
   * any agent run writes to the cache. Subsequent calls for the same tool
   * are no-ops - capacity is fixed at first registration.
   *
   * This separates cache configuration (a one-time concern at startup) from
   * cache writes (a per-call concern at runtime), so `set()` doesn't need to
   * carry capacity as a parameter on every invocation.
   */
  configure(toolName: string, maxEntries: number): void;

  /**
   * Returns the cached entry for `(toolName, input, vary)`, or `undefined`
   * on a miss or after TTL expiry.
   */
  get(toolName: string, input: unknown, vary: readonly string[]): CachedEntry | undefined;

  /**
   * Stores `output` under the canonical key for `(toolName, input, vary)`.
   * Call `configure()` first to set the LRU capacity for this tool.
   *
   * @param ttlMs  Entry lifetime in milliseconds.
   */
  set(
    toolName: string,
    input: unknown,
    vary: readonly string[],
    output: unknown,
    ttlMs: number,
  ): void;

  /** Returns hit/miss statistics for one tool, or `undefined` if never written. */
  stats(toolName: string): ResultCacheStats | undefined;

  /**
   * Evicts all entries for `toolName`, or every entry when called with no
   * argument. Useful in tests and when tool outputs are known stale.
   */
  clear(toolName?: string): void;
}

export interface CachedEntry {
  readonly output: unknown;
  readonly cachedAt: Date;
}

export interface ResultCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly currentEntries: number;
  readonly hitRate: number;
}

// ---------------------------------------------------------------------------
// Default in-process implementation
// ---------------------------------------------------------------------------

/**
 * Content-addressable, in-process result cache for tool outputs.
 *
 * **Key scheme** - the cache key is the first 16 hex chars (64 bits) of the
 * SHA-256 digest of the canonicalised input. Object keys are sorted
 * recursively, so `{a:1,b:2}` and `{b:2,a:1}` always produce the same key.
 * The `vary` strings are appended after a `|` separator (not valid JSON) so
 * they can't collide with input content. Collision probability: ~2.7×10⁻⁸
 * for 10⁶ distinct inputs.
 *
 * **Per-tool isolation** - each tool gets its own `LruCache` via `configure()`,
 * so a high-traffic tool can't evict results belonging to others.
 *
 * **Sharing across agents** - inject the same `ResultCache` into multiple
 * `Agent` constructors to deduplicate identical calls across runs.
 */
export class ResultCache implements Cache {
  // Each tool gets its own LRU so no single tool can starve the others.
  private readonly stores = new Map<string, LruCache<CachedEntry>>();
  // Capacity is fixed at configure() time and cannot change afterwards.
  private readonly capacities = new Map<string, number>();

  configure(toolName: string, maxEntries: number): void {
    if (this.capacities.has(toolName)) return; // already configured - no-op
    this.capacities.set(toolName, maxEntries);
    this.stores.set(toolName, new LruCache<CachedEntry>(maxEntries));
  }

  get(toolName: string, input: unknown, vary: readonly string[]): CachedEntry | undefined {
    return this.stores.get(toolName)?.get(cacheKey(input, vary));
  }

  set(
    toolName: string,
    input: unknown,
    vary: readonly string[],
    output: unknown,
    ttlMs: number,
  ): void {
    let store = this.stores.get(toolName);
    if (store === undefined) {
      // Fallback when configure() was never called - use a default capacity.
      // This keeps the cache functional even for tools registered after agent
      // construction, at the cost of not honouring a custom maxEntries.
      store = new LruCache<CachedEntry>(512);
      this.stores.set(toolName, store);
    }
    store.set(cacheKey(input, vary), { output, cachedAt: new Date() }, ttlMs);
  }

  stats(toolName: string): ResultCacheStats | undefined {
    const store = this.stores.get(toolName);
    if (store === undefined) return undefined;
    const s = store.stats();
    return {
      hits: s.hits,
      misses: s.misses,
      evictions: s.evictions,
      expirations: s.expirations,
      currentEntries: s.currentSize,
      hitRate: s.hitRate,
    };
  }

  clear(toolName?: string): void {
    if (toolName !== undefined) {
      this.stores.get(toolName)?.clear();
    } else {
      for (const store of this.stores.values()) store.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a stable, order-independent 16-char hex cache key from `input` and `vary`.
 *
 * Key = SHA-256(canonicalize(input) + "|" + vary.sort().join(":"))[0:16]
 *
 * The `|` separator is not valid JSON, so vary strings can't collide with
 * input content. 16 hex chars = 64-bit prefix: P(collision) ≈ 2.7×10⁻⁸ at 10⁶
 * inputs - acceptable for tool-call caching where a false positive serves stale
 * data rather than causing corruption. If you need stronger collision resistance
 * (e.g., a shared Redis cache across many agents processing millions of calls
 * per day), use the full 64-char digest and adjust your storage key accordingly.
 */
export function cacheKey(input: unknown, vary: readonly string[]): string {
  const payload = canonicalize(input) + "|" + [...vary].sort().join(":");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Produces an order-independent JSON-like string for `value`.
 *
 * Object keys are sorted at every nesting level so `{a:1,b:2}` and `{b:2,a:1}`
 * canonicalise identically. Arrays are order-sensitive. Primitives use
 * `JSON.stringify`. Circular references will stack-overflow - safe in practice
 * because tool inputs come from JSON-parsed, Zod-validated API responses which
 * cannot contain circular structures. If you pass custom tool outputs to the
 * cache that contain circular references, use the `strategy: "no-cache"` policy
 * instead of working around this function.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }

  const record = value as Record<string, unknown>;
  const sorted = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`)
    .join(",");
  return "{" + sorted + "}";
}
