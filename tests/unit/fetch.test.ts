import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTool } from "../../src/tools/fetch.js";

// ---------------------------------------------------------------------------
// Mock the global fetch using arrayBuffer() - matches the tool implementation
// ---------------------------------------------------------------------------

function mockFetch(
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" },
): void {
  const encoded = new TextEncoder().encode(body);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      url: "https://example.com/",
      headers: {
        get: (key: string) => headers[key.toLowerCase()] ?? null,
        forEach: (cb: (value: string, key: string) => void) => {
          for (const [k, v] of Object.entries(headers)) cb(v, k);
        },
      },
      arrayBuffer: async () => encoded.buffer,
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTool", () => {
  describe("successful responses", () => {
    it("returns status, ok, body, and headers for a 200 response", async () => {
      mockFetch(200, "Hello, world!");
      const result = await fetchTool.execute({
        url: "https://example.com/",
        method: "GET",
        maxBytes: 500_000,
      });
      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.body).toBe("Hello, world!");
      expect(result.truncated).toBe(false);
    });

    it("marks ok: false for 4xx responses", async () => {
      mockFetch(404, "Not Found");
      const result = await fetchTool.execute({
        url: "https://example.com/missing",
        method: "GET",
        maxBytes: 500_000,
      });
      expect(result.status).toBe(404);
      expect(result.ok).toBe(false);
    });

    it("returns response headers as a plain object", async () => {
      mockFetch(200, "body", {
        "content-type": "application/json",
        "x-request-id": "abc123",
      });
      const result = await fetchTool.execute({
        url: "https://example.com/",
        method: "GET",
        maxBytes: 500_000,
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers["x-request-id"]).toBe("abc123");
    });

    it("sends POST with a body", async () => {
      const responseEncoded = new TextEncoder().encode('{"id":1}');
      const spy = vi.fn().mockResolvedValue({
        status: 201,
        ok: true,
        url: "https://api.example.com/items",
        headers: {
          get: () => "application/json",
          forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type"),
        },
        arrayBuffer: async () => responseEncoded.buffer,
      });
      vi.stubGlobal("fetch", spy);

      const result = await fetchTool.execute({
        url: "https://api.example.com/items",
        method: "POST",
        body: JSON.stringify({ name: "test" }),
        maxBytes: 500_000,
      });
      expect(result.status).toBe(201);
      expect(spy).toHaveBeenCalledWith(
        "https://api.example.com/items",
        expect.objectContaining({ method: "POST", body: '{"name":"test"}' }),
      );
    });
  });

  describe("body truncation", () => {
    it("truncates responses larger than maxBytes", async () => {
      mockFetch(200, "abcdefghij"); // 10 bytes
      const result = await fetchTool.execute({
        url: "https://example.com/large",
        method: "GET",
        maxBytes: 5,
      });
      expect(result.truncated).toBe(true);
      expect(result.body).toBe("abcde");
    });

    it("does not truncate responses within maxBytes", async () => {
      mockFetch(200, "short");
      const result = await fetchTool.execute({
        url: "https://example.com/short",
        method: "GET",
        maxBytes: 500_000,
      });
      expect(result.truncated).toBe(false);
      expect(result.body).toBe("short");
    });
  });

  describe("summarize hook", () => {
    it("labels the call as METHOD URL", () => {
      expect(
        fetchTool.summarize?.({ url: "https://example.com/api", method: "GET", maxBytes: 500_000 }),
      ).toBe("GET https://example.com/api");
      expect(
        fetchTool.summarize?.({
          url: "https://api.example.com/items",
          method: "POST",
          maxBytes: 500_000,
        }),
      ).toBe("POST https://api.example.com/items");
    });
  });

  describe("policy", () => {
    it("has a 30-second timeout", () => {
      expect(fetchTool.policy?.timeoutMs).toBe(30_000);
    });

    it("retries on transient network errors (TypeError from fetch)", () => {
      const retry = fetchTool.policy?.retry;
      expect(retry?.maxAttempts).toBe(3);
      expect(retry?.shouldRetry(new TypeError("fetch failed"), 1)).toBe(true);
    });

    it("retries on ECONNRESET", () => {
      const retry = fetchTool.policy?.retry;
      expect(retry?.shouldRetry(new Error("ECONNRESET"), 1)).toBe(true);
    });

    it("does not retry on non-transient errors", () => {
      const retry = fetchTool.policy?.retry;
      expect(retry?.shouldRetry(new Error("400 Bad Request"), 1)).toBe(false);
    });
  });
});
