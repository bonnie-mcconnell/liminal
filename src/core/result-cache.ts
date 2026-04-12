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
   * Returns the cached entry for `(toolName, input, vary)`, or `undefined`
   * on a miss or after TTL expiry.
   */
  get(toolName: string, input: unknown, vary: readonly string[]): CachedEntry | undefined;

  /**
   * Stores `output` under the canonical key for `(toolName, input, vary)`.
   *
   * @param ttlMs       Entry lifetime in milliseconds.
   * @param maxEntries  LRU capacity for this tool's store. Only the value
   *                    from the **first** write for a given `toolName` is
   *                    used; subsequent writes with a different value are
   *                    silently ignored. Register tools and start agents in
   *                    the correct order to avoid surprises.
   */
  set(
    toolName: string,
    input: unknown,
    vary: readonly string[],
    output: unknown,
    ttlMs: number,
    maxEntries: number,
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
 * **Key scheme** - the cache key is the first 16 hex characters (64 bits) of
 * the SHA-256 digest of the canonicalised input. "Canonicalised" means object
 * keys are sorted recursively, so `{a:1,b:2}` and `{b:2,a:1}` always produce
 * the same digest. Arrays are order-sensitive. The `vary` strings are sorted
 * and appended after a separator so they cannot collide with input content.
 *
 * A 64-bit prefix gives a collision probability of ≈ 2.7 × 10⁻⁸ for 10⁶
 * distinct inputs - far below any practical threshold for tool-call caching.
 * SHA-256 is used rather than a non-cryptographic hash (djb2, FNV, etc.)
 * because its avalanche property guarantees that a one-bit difference in input
 * produces an unrecognisably different digest. Non-cryptographic hashes can
 * cluster on structured data such as JSON.
 *
 * **Per-tool isolation** - each tool gets its own `LruCache` instance so a
 * tool that generates many distinct inputs cannot evict entries belonging to
 * other tools. Capacity is set on the first write for a given tool name and
 * is immutable thereafter.
 *
 * **Sharing across agents** - inject the same `ResultCache` (or any `Cache`
 * implementation) into multiple `Agent` constructors to deduplicate identical
 * tool calls across concurrent or sequential runs:
 *
 * ```ts
 * const cache = new ResultCache();
 * const a1 = new Agent(registry, config, { cache });
 * const a2 = new Agent(registry, config, { cache });
 * ```
 */
export class ResultCache implements Cache {
  // Each tool gets its own LRU so no single tool can starve the others.
  private readonly stores = new Map<string, LruCache<CachedEntry>>();

  get(toolName: string, input: unknown, vary: readonly string[]): CachedEntry | undefined {
    return this.stores.get(toolName)?.get(cacheKey(input, vary));
  }

  set(
    toolName: string,
    input: unknown,
    vary: readonly string[],
    output: unknown,
    ttlMs: number,
    maxEntries: number,
  ): void {
    let store = this.stores.get(toolName);
    if (store === undefined) {
      // Capacity is fixed here at the first write. The LRU instance lives for
      // the lifetime of this ResultCache - capacity cannot be changed later.
      // Tools should be registered (and their policies therefore known) before
      // the first agent run writes to the cache.
      store = new LruCache<CachedEntry>(maxEntries);
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
 * Derives a stable, order-independent cache key from `input` and `vary`.
 *
 * The key is the first 16 hex characters (64 bits) of the SHA-256 digest of:
 *
 *   canonicalize(input) + "|" + vary.sort().join(":")
 *
 * The `|` separator is not valid JSON, so the vary section cannot be confused
 * with input content. The vary strings themselves are sorted so
 * `["b","a"]` and `["a","b"]` produce the same key.
 *
 * 64-bit prefix collision probability for N distinct inputs (birthday bound):
 *   P ≈ N² / (2 × 2⁶⁴) ≈ 2.7 × 10⁻⁸ for N = 10⁶
 *
 * If you need a stronger guarantee (e.g. the cache is shared across security
 * boundaries), return the full 64-character hex digest instead.
 */
export function cacheKey(input: unknown, vary: readonly string[]): string {
  const payload = canonicalize(input) + "|" + [...vary].sort().join(":");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Produces an order-independent JSON-like string for `value`.
 *
 * Rules:
 * - Primitive values (string, number, boolean, null, undefined) are serialised
 *   with `JSON.stringify` so they are unambiguous and round-trip safely.
 * - Object keys are sorted at every nesting level, so insertion order is
 *   irrelevant: `{a:1,b:2}` and `{b:2,a:1}` canonicalise identically.
 * - Arrays are order-sensitive: `[1,2]` and `[2,1]` produce different strings.
 *   This matches the semantic expectation - array element order is significant.
 * - Circular references will cause a stack overflow. This is safe in practice
 *   because tool inputs come from JSON-parsed API responses and Zod-validated
 *   schemas, neither of which can produce circular object graphs.
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
