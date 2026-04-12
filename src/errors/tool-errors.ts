import type { ZodIssue } from "zod";
import { LiminalError } from "./base.js";

/** Thrown when the model requests a tool name that isn't in the registry. */
export class ToolNotFoundError extends LiminalError {
  readonly code = "TOOL_NOT_FOUND" as const;
  constructor(public readonly toolName: string) {
    super(`No tool registered with name "${toolName}"`);
  }
}

/**
 * Thrown when a tool call's input fails schema validation.
 *
 * The full issue list is included so the message fed back to the model
 * is specific enough to act on ("query: Required" rather than "invalid input").
 * Non-retryable - the same input will fail the same way on every attempt.
 */
export class ToolInputValidationError extends LiminalError {
  readonly code = "TOOL_INPUT_VALIDATION" as const;
  constructor(
    public readonly toolName: string,
    public readonly issues: ZodIssue[],
  ) {
    const detail = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    super(`Invalid input for tool "${toolName}": ${detail}`);
  }
}

/**
 * Thrown when a tool's return value fails its declared output schema.
 *
 * This is always a bug in the tool implementation - the model can't fix it
 * by adjusting its call. Logged as an error rather than surfaced for retry.
 */
export class ToolOutputValidationError extends LiminalError {
  readonly code = "TOOL_OUTPUT_VALIDATION" as const;
  constructor(
    public readonly toolName: string,
    public readonly issues: ZodIssue[],
  ) {
    const detail = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    super(`Tool "${toolName}" returned invalid output: ${detail}`);
  }
}

/** Thrown when a tool's execute function itself throws. Wraps the original error as `cause`. */
export class ToolExecutionError extends LiminalError {
  readonly code = "TOOL_EXECUTION" as const;
  constructor(
    public readonly toolName: string,
    cause: unknown,
  ) {
    super(
      `Tool "${toolName}" threw during execution: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/** Thrown when a tool exceeds its configured timeout. Retryable by default. */
export class ToolTimeoutError extends LiminalError {
  readonly code = "TOOL_TIMEOUT" as const;
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" timed out after ${String(timeoutMs)}ms`);
  }
}

/**
 * Thrown when all configured retry attempts are exhausted.
 *
 * `attempts` is the total number of calls made, including the first.
 * The last error is preserved as `cause`.
 */
export class MaxRetriesExceededError extends LiminalError {
  readonly code = "MAX_RETRIES_EXCEEDED" as const;
  constructor(
    public readonly toolName: string,
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `Tool "${toolName}" failed after ${String(attempts)} ${attempts === 1 ? "attempt" : "attempts"}`,
      cause,
    );
  }
}

export type AnyToolError =
  | ToolNotFoundError
  | ToolInputValidationError
  | ToolOutputValidationError
  | ToolExecutionError
  | ToolTimeoutError
  | MaxRetriesExceededError;
