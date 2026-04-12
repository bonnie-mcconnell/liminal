import { z } from "zod";
import { ToolTimeoutError } from "../errors/index.js";
import type { ToolDefinition } from "../types/index.js";

const inputSchema = z.object({
  query: z.string().min(1).max(400).describe("The search query to execute."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Maximum number of results to return. Default: 5."),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      description: z.string(),
    }),
  ),
  query: z.string(),
  totalResults: z.number(),
});

type SearchResult = { title: string; url: string; description: string };

/**
 * Searches the web using the Brave Search API.
 *
 * Falls back to clearly-labeled mock results when BRAVE_SEARCH_API_KEY is not set,
 * so the demo runs without credentials.
 */
export const webSearchTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "web_search",
  description:
    "Searches the web and returns a list of relevant results with titles, URLs, and descriptions. " +
    "Use for finding current information, documentation, or facts not in your training data. " +
    "Prefer specific queries over broad ones - 'TypeScript strict mode benefits' over 'TypeScript'.",
  inputSchema,
  outputSchema,
  execute: async ({ query, maxResults }) => {
    const apiKey = process.env["BRAVE_SEARCH_API_KEY"];

    const results =
      apiKey !== undefined
        ? await searchWithBrave(query, maxResults, apiKey)
        : mockSearch(query, maxResults);

    return { results, query, totalResults: results.length };
  },
  summarize: ({ query }) => query,
  policy: {
    cache: {
      strategy: "content-hash",
      ttlMs: 10 * 60 * 1000, // 10 minutes
      vary: [],
      maxEntries: 256,
    },
    retry: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterMs: 300,
      shouldRetry: (err) => {
        if (err instanceof ToolTimeoutError) return true;
        if (err instanceof TypeError && err.message.includes("fetch")) return true;
        if (err instanceof Error && err.message.includes("429")) return true;
        return false;
      },
    },
    timeoutMs: 15_000,
  },
};

async function searchWithBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API returned ${String(response.status)}: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    web?: { results?: Array<{ title: string; url: string; description?: string }> };
  };

  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description ?? "",
  }));
}

/** Returns labeled mock results for local development without an API key. */
function mockSearch(query: string, count: number): SearchResult[] {
  const base: SearchResult[] = [
    {
      title: `[Mock] ${query} - Overview and Best Practices`,
      url: `https://example.com/search?q=${encodeURIComponent(query)}`,
      description: `Comprehensive overview of ${query}, including key concepts, common patterns, and practical examples for developers.`,
    },
    {
      title: `[Mock] Understanding ${query} - A Deep Dive`,
      url: `https://docs.example.com/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-"))}`,
      description: `Technical deep-dive into ${query}, covering implementation details, performance considerations, and real-world use cases.`,
    },
    {
      title: `[Mock] ${query}: Common Mistakes and How to Avoid Them`,
      url: `https://blog.example.com/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-"))}-pitfalls`,
      description: `A practical guide to the most frequent errors developers make with ${query} and concrete strategies to avoid them.`,
    },
    {
      title: `[Mock] ${query} - Official Documentation`,
      url: `https://docs.example.com/official/${encodeURIComponent(query)}`,
      description: `Official reference documentation for ${query}. Includes API reference, configuration options, and getting-started guide.`,
    },
    {
      title: `[Mock] ${query} in Production - Case Studies`,
      url: `https://engineering.example.com/case-studies/${encodeURIComponent(query)}`,
      description: `Real-world examples of ${query} in production systems, including lessons learned and performance benchmarks.`,
    },
  ];

  return base.slice(0, count);
}
