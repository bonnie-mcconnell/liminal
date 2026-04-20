import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webSearchTool } from "../../src/tools/web-search.js";
import { ToolTimeoutError } from "../../src/errors/index.js";

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      statusText: response.ok ? "OK" : "Error",
      json: () => Promise.resolve(response.body ?? {}),
    }),
  );
}

async function search(query: string, maxResults = 3) {
  return webSearchTool.execute({ query, maxResults });
}

describe("webSearchTool", () => {
  beforeEach(() => {
    delete process.env["BRAVE_SEARCH_API_KEY"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env["BRAVE_SEARCH_API_KEY"];
  });

  describe("mock fallback (no API key)", () => {
    it("returns results without making a network request", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await search("TypeScript strict mode");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.results.length).toBeGreaterThan(0);
    });

    it("includes the query term in mock result titles and descriptions", async () => {
      const result = await search("TypeScript strict mode");

      for (const r of result.results) {
        const combined = r.title + r.description;
        expect(combined.toLowerCase()).toContain("typescript strict mode");
      }
    });

    it("respects the maxResults limit", async () => {
      const result = await search("anything", 2);
      expect(result.results).toHaveLength(2);
    });

    it("returns a result with the correct structure", async () => {
      const result = await search("test");

      expect(result).toHaveProperty("query", "test");
      expect(result).toHaveProperty("totalResults");
      expect(Array.isArray(result.results)).toBe(true);

      const first = result.results[0]!;
      expect(typeof first.title).toBe("string");
      expect(typeof first.url).toBe("string");
      expect(typeof first.description).toBe("string");
    });

    it("labels mock results clearly so they are never mistaken for real data", async () => {
      const result = await search("important topic");
      for (const r of result.results) {
        expect(r.title).toMatch(/^\[Mock\]/);
      }
    });
  });

  describe("Brave Search API path (with API key)", () => {
    beforeEach(() => {
      process.env["BRAVE_SEARCH_API_KEY"] = "test_key_abc";
    });

    it("calls the Brave Search API with the correct URL and headers", async () => {
      mockFetch({
        ok: true,
        body: {
          web: {
            results: [
              { title: "Real Result", url: "https://example.com", description: "A real result." },
            ],
          },
        },
      });

      await search("TypeScript", 1);

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("api.search.brave.com");
      expect(url).toContain("TypeScript");
      expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("test_key_abc");
    });

    it("maps API response fields to the output schema", async () => {
      mockFetch({
        ok: true,
        body: {
          web: {
            results: [
              {
                title: "TypeScript Docs",
                url: "https://typescriptlang.org",
                description: "Official docs.",
              },
              {
                title: "TS Handbook",
                url: "https://typescriptlang.org/docs",
                description: "Handbook.",
              },
            ],
          },
        },
      });

      const result = await search("TypeScript", 5);

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        title: "TypeScript Docs",
        url: "https://typescriptlang.org",
        description: "Official docs.",
      });
    });

    it("handles a missing web.results field gracefully", async () => {
      mockFetch({ ok: true, body: {} });
      const result = await search("empty response");
      expect(result.results).toEqual([]);
      expect(result.totalResults).toBe(0);
    });

    it("throws when the API returns a non-OK status", async () => {
      mockFetch({ ok: false, status: 500 });
      await expect(search("bad request")).rejects.toThrow("500");
    });

    it("throws with the status code in the message for 429", async () => {
      mockFetch({ ok: false, status: 429 });
      await expect(search("rate limited")).rejects.toThrow("429");
    });

    it("respects maxResults by slicing API results", async () => {
      mockFetch({
        ok: true,
        body: {
          web: {
            results: Array.from({ length: 10 }, (_, i) => ({
              title: `Result ${i}`,
              url: `https://example.com/${i}`,
              description: `Desc ${i}`,
            })),
          },
        },
      });

      const result = await search("many results", 3);
      expect(result.results).toHaveLength(3);
    });
  });

  describe("tool metadata", () => {
    it("has a non-empty name and description", () => {
      expect(webSearchTool.name).toBe("web_search");
      expect(webSearchTool.description.length).toBeGreaterThan(20);
    });

    it("accepts a valid input without Zod errors", () => {
      const parsed = webSearchTool.inputSchema.safeParse({ query: "hello", maxResults: 5 });
      expect(parsed.success).toBe(true);
    });

    it("rejects an empty query string", () => {
      const parsed = webSearchTool.inputSchema.safeParse({ query: "" });
      expect(parsed.success).toBe(false);
    });

    it("applies the default maxResults of 5 when not specified", () => {
      const parsed = webSearchTool.inputSchema.safeParse({ query: "hello" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.maxResults).toBe(5);
      }
    });
  });

  describe("policy", () => {
    const retry = webSearchTool.policy?.retry;

    it("retries on ToolTimeoutError", () => {
      expect(retry?.shouldRetry(new ToolTimeoutError("web_search", 1000), 1)).toBe(true);
    });

    it("retries on fetch TypeError (network failure)", () => {
      expect(retry?.shouldRetry(new TypeError("fetch failed: ECONNREFUSED"), 1)).toBe(true);
    });

    it("retries on 429 rate-limit error", () => {
      expect(retry?.shouldRetry(new Error("Request failed with status 429"), 1)).toBe(true);
    });

    it("does not retry on non-transient errors", () => {
      expect(retry?.shouldRetry(new Error("404 Not Found"), 1)).toBe(false);
    });
  });
});
