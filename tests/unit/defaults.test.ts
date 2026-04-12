import { describe, it, expect } from "vitest";
import { DEFAULT_SHOULD_RETRY } from "../../src/core/defaults.js";
import {
  ToolTimeoutError,
  ToolExecutionError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolNotFoundError,
  MaxRetriesExceededError,
} from "../../src/errors/index.js";

describe("DEFAULT_SHOULD_RETRY", () => {
  describe("retryable", () => {
    it("retries ToolTimeoutError", () => {
      expect(DEFAULT_SHOULD_RETRY(new ToolTimeoutError("t", 5000), 1)).toBe(true);
    });

    it("retries ToolExecutionError wrapping a fetch TypeError", () => {
      const err = new ToolExecutionError("t", new TypeError("fetch failed: ECONNRESET"));
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(true);
    });

    it("retries ToolExecutionError wrapping a 429 response", () => {
      const err = new ToolExecutionError("t", new Error("Request failed with status 429"));
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(true);
    });

    it("retries ToolExecutionError wrapping a 'rate limit' message", () => {
      const err = new ToolExecutionError("t", new Error("rate limit exceeded, try again later"));
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(true);
    });

    it("retries ToolExecutionError wrapping an object with status 429", () => {
      const err = new ToolExecutionError("t", { status: 429 });
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(true);
    });
  });

  describe("non-retryable", () => {
    it("does not retry ToolInputValidationError", () => {
      const err = new ToolInputValidationError("t", [
        {
          path: ["query"],
          message: "Required",
          code: "invalid_type" as const,
          expected: "string" as const,
          received: "undefined" as const,
        },
      ]);
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(false);
    });

    it("does not retry ToolNotFoundError", () => {
      expect(DEFAULT_SHOULD_RETRY(new ToolNotFoundError("t"), 1)).toBe(false);
    });

    it("does not retry ToolOutputValidationError", () => {
      expect(DEFAULT_SHOULD_RETRY(new ToolOutputValidationError("t", []), 1)).toBe(false);
    });

    it("does not retry MaxRetriesExceededError", () => {
      expect(DEFAULT_SHOULD_RETRY(new MaxRetriesExceededError("t", 3, new Error()), 1)).toBe(false);
    });

    it("does not retry ToolExecutionError wrapping a generic logic error", () => {
      const err = new ToolExecutionError("t", new Error("undefined is not a function"));
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(false);
    });

    it("does not retry unknown errors", () => {
      expect(DEFAULT_SHOULD_RETRY(new Error("unknown"), 1)).toBe(false);
      expect(DEFAULT_SHOULD_RETRY("string error", 1)).toBe(false);
      expect(DEFAULT_SHOULD_RETRY(null, 1)).toBe(false);
    });
  });

  describe("attempt number", () => {
    it("ignores the attempt number - maxAttempts enforces the ceiling", () => {
      const err = new ToolTimeoutError("t", 1000);
      expect(DEFAULT_SHOULD_RETRY(err, 1)).toBe(true);
      expect(DEFAULT_SHOULD_RETRY(err, 99)).toBe(true);
    });
  });
});
