import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, normalize } from "node:path";
import type { ToolDefinition } from "../types/index.js";

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Path to the file to read, relative to the current working directory. " +
        "Absolute paths and directory traversal (../) are rejected.",
    ),
  encoding: z
    .enum(["utf-8", "base64"])
    .default("utf-8")
    .describe("Character encoding. Use base64 for binary files."),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(100_000)
    .describe("Maximum bytes to read. Files larger than this are truncated."),
});

const outputSchema = z.object({
  content: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  truncated: z.boolean(),
  encoding: z.enum(["utf-8", "base64"]),
});

const MAX_FILE_SIZE_BYTES = 1_000_000;

/** Reads a file with path validation: relative paths only, no directory traversal. */
export const fileReaderTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "file_reader",
  description:
    "Reads the contents of a file and returns them as a string. " +
    "Accepts relative paths only. Supports text files (utf-8) and binary files (base64). " +
    "Large files are automatically truncated - check the truncated field in the response.",
  inputSchema,
  outputSchema,
  execute: async ({ path: rawPath, encoding, maxBytes }) => {
    const safePath = validatePath(rawPath);

    const fileStat = await stat(safePath).catch(() => {
      throw new Error(`File not found or inaccessible: "${rawPath}"`);
    });

    if (!fileStat.isFile()) {
      throw new Error(`"${rawPath}" is not a file`);
    }

    const limitBytes = Math.min(maxBytes, MAX_FILE_SIZE_BYTES);
    const truncated = fileStat.size > limitBytes;

    const buffer = await readFile(safePath);
    const slice = truncated ? buffer.subarray(0, limitBytes) : buffer;
    const content = encoding === "base64" ? slice.toString("base64") : slice.toString("utf-8");

    return {
      content: truncated
        ? content + `\n\n[... file truncated after ${String(limitBytes)} bytes ...]`
        : content,
      path: rawPath,
      sizeBytes: fileStat.size,
      truncated,
      encoding,
    };
  },
  summarize: ({ path }) => path,
  policy: {
    cache: {
      // Short TTL because files change. A longer TTL would require mtime-based
      // invalidation which is more complexity than the demo warrants.
      strategy: "content-hash",
      ttlMs: 30_000,
      vary: [],
      maxEntries: 128,
    },
    retry: {
      maxAttempts: 2,
      backoff: "linear",
      baseDelayMs: 200,
      maxDelayMs: 500,
      jitterMs: 50,
      shouldRetry: (err) =>
        err instanceof Error && (err.message.includes("EMFILE") || err.message.includes("EAGAIN")),
    },
    timeoutMs: 5_000,
  },
};

function validatePath(rawPath: string): string {
  const cwd = process.cwd();
  const normalized = normalize(rawPath);

  if (normalized.startsWith("/") || /^[A-Za-z]:\\/.test(normalized)) {
    throw new Error(`Absolute paths are not permitted: "${rawPath}"`);
  }

  const resolved = resolve(cwd, normalized);
  if (relative(cwd, resolved).startsWith("..")) {
    throw new Error(`Path traversal rejected: "${rawPath}" resolves outside the working directory`);
  }

  return resolved;
}
