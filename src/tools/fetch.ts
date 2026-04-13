import { z } from "zod";
import { ToolTimeoutError } from "../errors/index.js";
import type { ToolDefinition } from "../types/index.js";

const inputSchema = z.object({
  url: z.string().url().describe("The URL to fetch. Must be http:// or https://."),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    .default("GET")
    .describe("HTTP method. Default: GET."),
  headers: z
    .record(z.string())
    .optional()
    .describe("Additional request headers as key-value pairs."),
  body: z
    .string()
    .optional()
    .describe("Request body for POST/PUT/PATCH. Must be a string (JSON.stringify if needed)."),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(5_000_000)
    .default(500_000)
    .describe("Maximum response body bytes to read. Default: 500 KB."),
});

const outputSchema = z.object({
  status: z.number().describe("HTTP response status code."),
  ok: z.boolean().describe("True when status is 2xx."),
  headers: z.record(z.string()).describe("Response headers."),
  body: z.string().describe("Response body, truncated to maxBytes if the response is larger."),
  truncated: z.boolean().describe("True when the response body exceeded maxBytes and was cut."),
  url: z.string().describe("Final URL after any redirects."),
});

/**
 * Fetches a URL and returns the response status, headers, and body.
 *
 * Body is always returned as a string. For JSON APIs, the model can parse
 * the body directly. For HTML pages, the model receives the raw markup.
 *
 * Responses larger than `maxBytes` are truncated - check the `truncated`
 * field. The `Content-Type` header tells you how to interpret the body.
 */
export const fetchTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "fetch",
  description:
    "Makes an HTTP request and returns the response status, headers, and body. " +
    "Use for REST APIs, fetching web pages, or checking URLs. " +
    "Not for file system operations (use file_reader for that). " +
    "Returns the raw body as a string - for JSON, the model can parse it.",
  inputSchema,
  outputSchema,
  execute: async ({ url, method, headers, body, maxBytes }) => {
    const init: RequestInit = {
      method,
      headers: {
        "User-Agent": "liminal/0.3.0",
        ...headers,
      },
    };
    if (body !== undefined) init.body = body;
    const response = await fetch(url, init);

    // Collect response headers into a plain object
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Read the full body as an ArrayBuffer then slice to maxBytes.
    // arrayBuffer() buffers the entire response - for truly large responses
    // this is wasteful, but it avoids the any-typed ReadableStream reader API
    // and is correct for the tool's contract (maxBytes default: 500 KB).
    // Callers that need true streaming should use the Fetch API directly.
    const rawBuffer = await response.arrayBuffer();
    const truncated = rawBuffer.byteLength > maxBytes;
    const buffer = Buffer.from(truncated ? rawBuffer.slice(0, maxBytes) : rawBuffer);

    // Detect encoding from Content-Type; fall back to utf-8
    const contentType = response.headers.get("content-type") ?? "";
    const charsetMatch = /charset=([^\s;]+)/.exec(contentType);
    const encoding = (charsetMatch?.[1]?.toLowerCase() ?? "utf-8") as BufferEncoding;

    let bodyText: string;
    try {
      bodyText = buffer.toString(encoding);
    } catch {
      bodyText = buffer.toString("utf-8");
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: responseHeaders,
      body: bodyText,
      truncated,
      url: response.url,
    };
  },
  summarize: ({ method, url }) => `${method} ${url}`,
  policy: {
    cache: {
      // No caching for HTTP requests. Caching by input hash would mean two
      // identical POST requests share a result - the second wouldn't fire,
      // silently skipping its side effect. HTTP-level caching (ETags,
      // Cache-Control) is the right layer for this; tool-level caching is not.
      strategy: "no-cache",
    },
    retry: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      jitterMs: 200,
      shouldRetry: (err) => {
        if (err instanceof ToolTimeoutError) return true;
        if (err instanceof TypeError && err.message.includes("fetch")) return true;
        if (err instanceof Error && err.message.includes("ECONNRESET")) return true;
        return false;
      },
    },
    timeoutMs: 30_000,
  },
};
