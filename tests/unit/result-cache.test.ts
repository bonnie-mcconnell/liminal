import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResultCache, cacheKey, canonicalize } from "../../src/core/result-cache.js";

const TTL = 60_000;
const MAX = 512;

function set(
  cache: ResultCache,
  tool: string,
  input: unknown,
  output: unknown,
  vary: string[] = [],
) {
  cache.set(tool, input, vary, output, TTL, MAX);
}

function get(cache: ResultCache, tool: string, input: unknown, vary: string[] = []) {
  return cache.get(tool, input, vary);
}

// ---------------------------------------------------------------------------
// canonicalize - unit tests for the serialisation primitive
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  it("serialises primitives with JSON.stringify semantics", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(undefined)).toBe("undefined");
  });

  it("sorts object keys at the top level", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it("sorts object keys recursively in nested objects", () => {
    expect(canonicalize({ x: { b: 2, a: 1 } })).toBe(canonicalize({ x: { a: 1, b: 2 } }));
  });

  it("treats arrays as order-sensitive", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("distinguishes an empty array from an empty object", () => {
    expect(canonicalize([])).not.toBe(canonicalize({}));
  });

  it("distinguishes the number 1 from the string '1'", () => {
    expect(canonicalize(1)).not.toBe(canonicalize("1"));
  });
});

// ---------------------------------------------------------------------------
// cacheKey - verifies the SHA-256 derivation properties
// ---------------------------------------------------------------------------

describe("cacheKey", () => {
  it("produces a 16-character hex string", () => {
    const key = cacheKey({ query: "hello" }, []);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable: same input always produces the same key", () => {
    expect(cacheKey({ a: 1 }, [])).toBe(cacheKey({ a: 1 }, []));
  });

  it("is order-independent for object keys", () => {
    expect(cacheKey({ a: 1, b: 2 }, [])).toBe(cacheKey({ b: 2, a: 1 }, []));
  });

  it("is order-sensitive for arrays", () => {
    expect(cacheKey([1, 2], [])).not.toBe(cacheKey([2, 1], []));
  });

  it("is order-independent for vary strings", () => {
    expect(cacheKey({}, ["b", "a"])).toBe(cacheKey({}, ["a", "b"]));
  });

  it("partitions by vary - same input, different vary → different key", () => {
    expect(cacheKey({ q: "x" }, ["user:1"])).not.toBe(cacheKey({ q: "x" }, ["user:2"]));
  });

  it("vary does not collide with input content", () => {
    // The separator "|" is not valid JSON, so vary values cannot be confused
    // with input fields regardless of what the vary strings contain.
    const withVary = cacheKey({ q: "a" }, ["b"]);
    const withoutVary = cacheKey({ q: "a|b" }, []);
    expect(withVary).not.toBe(withoutVary);
  });

  it("produces different keys for different primitive values", () => {
    expect(cacheKey(1, [])).not.toBe(cacheKey(2, []));
    expect(cacheKey("a", [])).not.toBe(cacheKey("b", []));
  });

  it("produces different keys for structurally different objects", () => {
    expect(cacheKey({ a: 1 }, [])).not.toBe(cacheKey({ a: 2 }, []));
    expect(cacheKey({ a: 1 }, [])).not.toBe(cacheKey({ b: 1 }, []));
  });
});

// ---------------------------------------------------------------------------
// ResultCache - integration-level behaviour
// ---------------------------------------------------------------------------

describe("ResultCache", () => {
  describe("canonical key computation", () => {
    it("returns the same entry for objects with different key insertion order", () => {
      const cache = new ResultCache();
      set(cache, "tool", { a: 1, b: 2 }, "result-ab");

      const hit = get(cache, "tool", { b: 2, a: 1 });
      expect(hit).toBeDefined();
      expect(hit?.output).toBe("result-ab");
    });

    it("treats arrays as order-sensitive: [1,2] ≠ [2,1]", () => {
      const cache = new ResultCache();
      set(cache, "tool", [1, 2], "result-12");

      expect(get(cache, "tool", [2, 1])).toBeUndefined();
    });

    it("distinguishes between different tools for the same input", () => {
      const cache = new ResultCache();
      set(cache, "tool_a", { q: "hello" }, "from-a");
      set(cache, "tool_b", { q: "hello" }, "from-b");

      expect(get(cache, "tool_a", { q: "hello" })?.output).toBe("from-a");
      expect(get(cache, "tool_b", { q: "hello" })?.output).toBe("from-b");
    });

    it("produces different entries for different vary values", () => {
      const cache = new ResultCache();
      set(cache, "tool", { q: "hello" }, "for-user-1", ["user:1"]);
      set(cache, "tool", { q: "hello" }, "for-user-2", ["user:2"]);

      expect(get(cache, "tool", { q: "hello" }, ["user:1"])?.output).toBe("for-user-1");
      expect(get(cache, "tool", { q: "hello" }, ["user:2"])?.output).toBe("for-user-2");
    });

    it("treats vary arrays as order-independent", () => {
      const cache = new ResultCache();
      set(cache, "tool", {}, "v", ["b", "a"]);

      expect(get(cache, "tool", {}, ["a", "b"])?.output).toBe("v");
    });

    it("handles deeply nested objects correctly", () => {
      const cache = new ResultCache();
      set(cache, "tool", { x: { y: { z: 1 } } }, "deep");

      expect(get(cache, "tool", { x: { y: { z: 1 } } })?.output).toBe("deep");
      expect(get(cache, "tool", { x: { y: { z: 2 } } })).toBeUndefined();
    });

    it("does not mistake vary content for input content", () => {
      const cache = new ResultCache();
      // Input {q:"a"} with vary ["b"] must not collide with input {q:"a|b"} no vary.
      set(cache, "tool", { q: "a" }, "with-vary", ["b"]);
      set(cache, "tool", { q: "a|b" }, "no-vary", []);

      expect(get(cache, "tool", { q: "a" }, ["b"])?.output).toBe("with-vary");
      expect(get(cache, "tool", { q: "a|b" }, [])?.output).toBe("no-vary");
    });
  });

  describe("TTL expiration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns undefined after the TTL elapses", () => {
      const cache = new ResultCache();
      cache.set("tool", {}, [], "value", 500, MAX);
      vi.advanceTimersByTime(501);
      expect(get(cache, "tool", {})).toBeUndefined();
    });

    it("returns the value before the TTL elapses", () => {
      const cache = new ResultCache();
      cache.set("tool", {}, [], "value", 1_000, MAX);
      vi.advanceTimersByTime(999);
      expect(get(cache, "tool", {})?.output).toBe("value");
    });
  });

  describe("per-tool isolation", () => {
    it("clearing one tool does not affect another", () => {
      const cache = new ResultCache();
      set(cache, "tool_a", {}, "a");
      set(cache, "tool_b", {}, "b");

      cache.clear("tool_a");

      expect(get(cache, "tool_a", {})).toBeUndefined();
      expect(get(cache, "tool_b", {})?.output).toBe("b");
    });

    it("clearing without arguments evicts every tool", () => {
      const cache = new ResultCache();
      set(cache, "tool_a", {}, "a");
      set(cache, "tool_b", {}, "b");

      cache.clear();

      expect(get(cache, "tool_a", {})).toBeUndefined();
      expect(get(cache, "tool_b", {})).toBeUndefined();
    });

    it("stats returns undefined for a tool that has never been written", () => {
      const cache = new ResultCache();
      expect(cache.stats("unknown")).toBeUndefined();
    });

    it("tracks hits and misses per tool correctly", () => {
      const cache = new ResultCache();
      set(cache, "tool", {}, "v");

      get(cache, "tool", {}); // hit
      get(cache, "tool", { x: 1 }); // miss

      const stats = cache.stats("tool");
      expect(stats?.hits).toBe(1);
      expect(stats?.misses).toBe(1);
      expect(stats?.hitRate).toBeCloseTo(0.5);
    });
  });

  describe("cachedAt timestamp", () => {
    it("records a cachedAt date close to the time of insertion", () => {
      const before = new Date();
      const cache = new ResultCache();
      set(cache, "tool", {}, "v");
      const after = new Date();

      const entry = get(cache, "tool", {});
      expect(entry).toBeDefined();
      expect(entry!.cachedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(entry!.cachedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe("Cache interface compliance", () => {
    it("satisfies the Cache interface (compile-time verified by TypeScript, runtime smoke test)", () => {
      // If ResultCache doesn't implement Cache, this assignment fails at compile time.
      // The runtime test just confirms the methods exist and behave.
      const cache: import("../../src/core/result-cache.js").Cache = new ResultCache();

      cache.set("t", { v: 1 }, [], "out", 60_000, 10);
      expect(cache.get("t", { v: 1 }, [])?.output).toBe("out");
      expect(cache.stats("t")).toBeDefined();
      cache.clear("t");
      expect(cache.get("t", { v: 1 }, [])).toBeUndefined();
    });
  });
});
