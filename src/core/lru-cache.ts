interface Node<V> {
  key: string;
  value: V;
  expiresAt: number; // Unix ms, or Infinity
  prev: Node<V> | null;
  next: Node<V> | null;
}

export interface LruCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly currentSize: number;
  readonly hitRate: number;
}

/**
 * Generic LRU cache: O(1) get/set via a doubly-linked list + Map.
 * Accessed nodes move to the head; the tail is evicted at capacity.
 * TTL entries are lazily expired on next access after their deadline.
 */
export class LruCache<V> {
  private readonly map = new Map<string, Node<V>>();
  private head: Node<V> | null = null;
  private tail: Node<V> | null = null;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new RangeError("LruCache maxSize must be at least 1");
  }

  /** Returns the value for `key`, or `undefined` if absent or expired. */
  get(key: string): V | undefined {
    const node = this.map.get(key);

    if (node === undefined) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > node.expiresAt) {
      this.remove(node);
      this.expirations++;
      this.misses++;
      return undefined;
    }

    this.moveToHead(node);
    this.hits++;
    return node.value;
  }

  /** Stores `value` under `key`, evicting the LRU entry if at capacity. */
  set(key: string, value: V, ttlMs: number = Infinity): void {
    const existing = this.map.get(key);

    if (existing !== undefined) {
      existing.value = value;
      existing.expiresAt = ttlMs === Infinity ? Infinity : Date.now() + ttlMs;
      this.moveToHead(existing);
      return;
    }

    const node: Node<V> = {
      key,
      value,
      expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
      prev: null,
      next: this.head,
    };

    if (this.head !== null) this.head.prev = node;
    this.head = node;
    if (this.tail === null) this.tail = node;

    this.map.set(key, node);

    if (this.map.size > this.maxSize) {
      this.evictTail();
    }
  }

  /** Removes an entry explicitly. No-op if absent. */
  delete(key: string): void {
    const node = this.map.get(key);
    if (node !== undefined) this.remove(node);
  }

  /** Evicts all cached entries but preserves hit/miss/eviction counters. */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Resets hit, miss, eviction, and expiration counters to zero.
   * Call this when you want to measure cache performance over a specific window
   * without evicting entries (e.g., between agent runs on a shared cache).
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  stats(): LruCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      currentSize: this.map.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  private moveToHead(node: Node<V>): void {
    if (node === this.head) return;
    this.detach(node);
    node.prev = null;
    node.next = this.head;
    if (this.head !== null) this.head.prev = node;
    this.head = node;
    if (this.tail === null) this.tail = node;
  }

  private evictTail(): void {
    if (this.tail === null) return;
    this.remove(this.tail);
    this.evictions++;
  }

  private remove(node: Node<V>): void {
    this.map.delete(node.key);
    this.detach(node);
  }

  private detach(node: Node<V>): void {
    if (node.prev !== null) node.prev.next = node.next;
    if (node.next !== null) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }
}
