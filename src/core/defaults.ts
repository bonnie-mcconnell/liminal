import type { RetryPolicy, CachePolicy, ToolPolicy } from "../types/index.js";
import {
  ToolTimeoutError,
  ToolExecutionError,
  ToolInputValidationError,
  ToolNotFoundError,
} from "../errors/index.js";

/**
 * Conservative retry predicate: only retry errors that are plausibly transient.
 *
 * Retrying a validation error or a missing tool wastes time and can cause
 * side effects without any chance of succeeding. Unknown errors default to
 * no-retry for the same reason.
 */
export const DEFAULT_SHOULD_RETRY: RetryPolicy["shouldRetry"] = (
  error: unknown,
  _attempt: number,
): boolean => {
  if (error instanceof ToolTimeoutError) return true;

  if (error instanceof ToolExecutionError) {
    const cause = error.cause;
    if (cause instanceof TypeError && cause.message.includes("fetch")) return true;
    if (isRateLimitError(cause)) return true;
    return false;
  }

  if (error instanceof ToolInputValidationError) return false;
  if (error instanceof ToolNotFoundError) return false;

  return false;
};

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message.toLowerCase().includes("rate limit")) return true;
    if (error.message.includes("429")) return true;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    return (error as { status: unknown }).status === 429;
  }
  return false;
}

/** Conservative retry policy applied when a tool declares no retry config. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoff: "exponential",
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterMs: 200,
  shouldRetry: DEFAULT_SHOULD_RETRY,
};

/** Cache policy applied when a tool declares no cache config. */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  strategy: "content-hash",
  ttlMs: 5 * 60 * 1000,
  vary: [],
  maxEntries: 512,
};

/** Full tool policy combining the default retry and cache policies. */
export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  timeoutMs: 30_000,
  retry: DEFAULT_RETRY_POLICY,
  cache: DEFAULT_CACHE_POLICY,
};
