import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LruCache } from "../../src/core/lru-cache.js";

describe("LruCache", () => {
  it("rejects maxSize < 1", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
  });

  describe("get / set", () => {
    it("returns undefined for a missing key", () => {
      expect(new LruCache<number>(10).get("missing")).toBeUndefined();
    });

    it("returns the stored value", () => {
      const cache = new LruCache<string>(10);
      cache.set("k", "hello");
      expect(cache.get("k")).toBe("hello");
    });

    it("overwrites an existing key without growing the cache", () => {
      const cache = new LruCache<number>(2);
      cache.set("k", 1);
      cache.set("k", 2);
      expect(cache.get("k")).toBe(2);
      expect(cache.stats().currentSize).toBe(1);
    });
  });

  describe("LRU eviction", () => {
    it("evicts the least recently used entry at capacity", () => {
      const cache = new LruCache<number>(2);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
    });

    it("promotes a read entry so it is not the next eviction target", () => {
      const cache = new LruCache<number>(2);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.get("a");
      cache.set("c", 3);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("a")).toBe(1);
    });

    it("counts evictions in stats", () => {
      const cache = new LruCache<number>(1);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.stats().evictions).toBe(2);
    });
  });

  describe("TTL", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns undefined after the TTL elapses", () => {
      const cache = new LruCache<number>(10);
      cache.set("k", 42, 500);
      vi.advanceTimersByTime(501);
      expect(cache.get("k")).toBeUndefined();
    });

    it("returns the value before the TTL elapses", () => {
      const cache = new LruCache<number>(10);
      cache.set("k", 42, 1000);
      vi.advanceTimersByTime(999);
      expect(cache.get("k")).toBe(42);
    });

    it("counts expirations separately from evictions", () => {
      const cache = new LruCache<number>(10);
      cache.set("k", 1, 100);
      vi.advanceTimersByTime(101);
      cache.get("k");
      expect(cache.stats().expirations).toBe(1);
      expect(cache.stats().evictions).toBe(0);
    });
  });

  describe("delete", () => {
    it("removes an entry", () => {
      const cache = new LruCache<number>(10);
      cache.set("k", 1);
      cache.delete("k");
      expect(cache.get("k")).toBeUndefined();
    });

    it("is a no-op for a missing key", () => {
      expect(() => new LruCache<number>(10).delete("x")).not.toThrow();
    });
  });

  describe("clear", () => {
    it("empties the cache and resets stats", () => {
      const cache = new LruCache<number>(10);
      cache.set("a", 1);
      cache.get("a");
      cache.clear();
      expect(cache.stats().currentSize).toBe(0);
      expect(cache.stats().hits).toBe(0);
    });
  });

  describe("stats", () => {
    it("computes hit rate as hits / (hits + misses)", () => {
      const cache = new LruCache<number>(10);
      cache.set("k", 1);
      cache.get("k");
      cache.get("k");
      cache.get("x");
      expect(cache.stats().hits).toBe(2);
      expect(cache.stats().misses).toBe(1);
      expect(cache.stats().hitRate).toBeCloseTo(2 / 3);
    });

    it("returns 0 hit rate before any access", () => {
      expect(new LruCache<number>(10).stats().hitRate).toBe(0);
    });
  });
});
