import type { ZodTypeAny, ZodIssue } from "zod";
import type { ToolCall, ToolResult, ToolPolicy } from "../types/index.js";
import type { ToolEvent } from "../types/events.js";
import type { ToolRegistry } from "./registry.js";
import type { Cache } from "./result-cache.js";
import type { Logger } from "../observability/logger.js";
import type { EventEmitter } from "../observability/event-emitter.js";
import { DEFAULT_TOOL_POLICY } from "./defaults.js";
import {
  ToolNotFoundError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolExecutionError,
  ToolTimeoutError,
  MaxRetriesExceededError,
} from "../errors/index.js";

/**
 * Executes a single tool call through the full lifecycle:
 * cache check → input validation → dispatch with timeout → retry →
 * output validation → cache write → result.
 *
 * **Never throws.** Every failure path returns a `ToolResult` with
 * `status: "error"` so the agent loop can forward structured feedback to the
 * model rather than crashing the run. Only budget violations and the
 * iteration ceiling (both handled in `Agent`) cause a hard abort.
 *
 * **Event emission.** When an `EventEmitter<ToolEvent>` is provided, the
 * executor emits a typed event at each significant lifecycle transition.
 * Emission is a synchronous side-channel - it does not affect the return
 * value, timing, or error handling of `execute`. Consumers use this for
 * progress indicators, dashboards, and test assertions without coupling
 * to the agent loop.
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly cache: Cache,
    private readonly log: Logger,
    private readonly events?: EventEmitter<ToolEvent>,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.toolName);
    if (tool === undefined) {
      this.log.warn("tool.not_found", { callId: call.id, toolName: call.toolName });
      const error = new ToolNotFoundError(call.toolName);
      this.emit({
        type: "failed",
        callId: call.id,
        toolName: call.toolName,
        ts: now(),
        error,
        attempts: 0,
      });
      return { status: "error", callId: call.id, toolName: call.toolName, error, attempts: 0 };
    }

    const policy = this.registry.getPolicy(call.toolName) ?? DEFAULT_TOOL_POLICY;

    const parseResult = tool.inputSchema.safeParse(call.rawInput);
    if (!parseResult.success) {
      const error = new ToolInputValidationError(call.toolName, parseResult.error.issues);
      this.log.warn("tool.input_invalid", {
        callId: call.id,
        toolName: call.toolName,
        issues: parseResult.error.issues.map((i: ZodIssue) => `${i.path.join(".")}: ${i.message}`),
      });
      this.emit({
        type: "failed",
        callId: call.id,
        toolName: call.toolName,
        ts: now(),
        error,
        attempts: 0,
      });
      return { status: "error", callId: call.id, toolName: call.toolName, error, attempts: 0 };
    }

    const validatedInput: unknown = parseResult.data;

    // Narrow the cache policy before accessing strategy-specific fields.
    // The discriminated union on CachePolicy requires this narrowing -
    // accessing ttlMs on a "no-cache" policy is a compile error.
    if (policy.cache.strategy === "content-hash") {
      const cached = this.cache.get(call.toolName, validatedInput, policy.cache.vary);
      if (cached !== undefined) {
        this.log.debug("tool.cache_hit", { callId: call.id, toolName: call.toolName });
        this.emit({
          type: "cache_hit",
          callId: call.id,
          toolName: call.toolName,
          ts: now(),
          output: cached.output,
        });
        return {
          status: "success",
          callId: call.id,
          toolName: call.toolName,
          output: cached.output,
          durationMs: 0,
          attempts: 0,
          cacheHit: true,
        };
      }
    }

    return this.executeWithRetry(call, tool.execute, validatedInput, tool.outputSchema, policy);
  }

  private async executeWithRetry(
    call: ToolCall,
    executeFn: (input: unknown) => Promise<unknown>,
    input: unknown,
    outputSchema: ZodTypeAny,
    policy: ToolPolicy,
  ): Promise<ToolResult> {
    const runStart = Date.now();
    let attempt = 0;
    let lastError: unknown;

    while (attempt < policy.retry.maxAttempts) {
      attempt++;

      if (attempt > 1) {
        const delay = computeDelay(policy.retry, attempt - 1);
        this.log.warn("tool.retrying", {
          callId: call.id,
          toolName: call.toolName,
          attempt,
          delayMs: Math.round(delay),
        });
        this.emit({
          type: "retrying",
          callId: call.id,
          toolName: call.toolName,
          ts: now(),
          attempt,
          delayMs: Math.round(delay),
        });
        if (delay > 0) await sleep(delay);
      }

      this.log.debug("tool.dispatched", { callId: call.id, toolName: call.toolName, attempt });
      this.emit({
        type: "dispatched",
        callId: call.id,
        toolName: call.toolName,
        ts: now(),
        attempt,
      });

      const attemptStart = Date.now();
      let rawOutput: unknown;

      try {
        // Use a manually managed timeout handle so we can clear it promptly on
        // success - a dangling timer would keep the event loop alive.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new ToolTimeoutError(call.toolName, policy.timeoutMs));
          }, policy.timeoutMs);
        });
        try {
          rawOutput = await Promise.race([executeFn(input), timeoutPromise]);
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (err) {
        lastError = err;
        // Wrap shouldRetry in try/catch: a buggy policy function must not
        // propagate out of execute() and break the never-throws contract.
        let willRetry = false;
        try {
          willRetry = policy.retry.shouldRetry(err, attempt) && attempt < policy.retry.maxAttempts;
        } catch {
          // Treat a crashing shouldRetry as "don't retry" — conservative and safe.
          willRetry = false;
        }
        this.emit({
          type: "attempt_failed",
          callId: call.id,
          toolName: call.toolName,
          ts: now(),
          attempt,
          error: err,
        });
        if (!willRetry) break;
        continue;
      }

      const outParse = outputSchema.safeParse(rawOutput);
      if (!outParse.success) {
        const error = new ToolOutputValidationError(call.toolName, outParse.error.issues);
        this.log.error("tool.output_invalid", {
          callId: call.id,
          toolName: call.toolName,
          issues: outParse.error.issues.map((i: ZodIssue) => `${i.path.join(".")}: ${i.message}`),
        });
        // Output validation failure is always a bug in the tool implementation,
        // not in the model's call. Don't retry - same code, same bad output.
        this.emit({
          type: "failed",
          callId: call.id,
          toolName: call.toolName,
          ts: now(),
          error,
          attempts: attempt,
        });
        return {
          status: "error",
          callId: call.id,
          toolName: call.toolName,
          error,
          attempts: attempt,
        };
      }

      const durationMs = Date.now() - attemptStart;

      if (policy.cache.strategy === "content-hash") {
        this.cache.set(
          call.toolName,
          input,
          policy.cache.vary,
          outParse.data,
          policy.cache.ttlMs,
          policy.cache.maxEntries,
        );
      }

      this.log.info("tool.succeeded", {
        callId: call.id,
        toolName: call.toolName,
        durationMs,
        attempts: attempt,
        totalMs: Date.now() - runStart,
      });
      this.emit({
        type: "succeeded",
        callId: call.id,
        toolName: call.toolName,
        ts: now(),
        output: outParse.data,
        durationMs,
        attempts: attempt,
      });

      return {
        status: "success",
        callId: call.id,
        toolName: call.toolName,
        output: outParse.data,
        durationMs,
        attempts: attempt,
        cacheHit: false,
      };
    }

    // All attempts exhausted. MaxRetriesExceededError wraps the underlying
    // error only when retries were actually configured (maxAttempts > 1) -
    // for a single-attempt tool, the underlying error is the right signal.
    const wrapped =
      lastError instanceof ToolTimeoutError || lastError instanceof ToolExecutionError
        ? lastError
        : new ToolExecutionError(call.toolName, lastError);

    const finalError =
      attempt >= policy.retry.maxAttempts && policy.retry.maxAttempts > 1
        ? new MaxRetriesExceededError(call.toolName, attempt, wrapped)
        : wrapped;

    this.log.error("tool.failed", {
      callId: call.id,
      toolName: call.toolName,
      attempts: attempt,
      errorCode: finalError.code,
      totalMs: Date.now() - runStart,
    });
    this.emit({
      type: "failed",
      callId: call.id,
      toolName: call.toolName,
      ts: now(),
      error: finalError,
      attempts: attempt,
    });

    return {
      status: "error",
      callId: call.id,
      toolName: call.toolName,
      error: finalError,
      attempts: attempt,
    };
  }

  private emit(event: ToolEvent): void {
    // Wrap in try/catch so a misbehaving listener never corrupts executor flow.
    // The log.error call is intentionally outside the try so it always fires.
    if (this.events === undefined) return;
    try {
      this.events.emit(event);
    } catch (err) {
      this.log.error("event.listener_threw", { event: event.type, error: String(err) });
    }
  }
}

/**
 * Computes the delay before the next retry attempt.
 *
 * Exponential backoff: `baseDelayMs × 2^(attempt−1)`, capped at `maxDelayMs`.
 * Linear backoff:      `baseDelayMs × attempt`, same cap.
 * None:                0 (used for non-retryable tools like the calculator).
 *
 * A uniform random jitter in `[0, jitterMs]` is added to every non-zero delay.
 * Without jitter, a burst of callers that all fail at t=0 will all retry at
 * t+delay, producing the same load spike that caused the original failure.
 * Jitter spreads retries across the interval, allowing the target service to
 * recover gradually.
 */
export function computeDelay(policy: ToolPolicy["retry"], attempt: number): number {
  if (policy.backoff === "none") return 0;

  const base =
    policy.backoff === "exponential"
      ? policy.baseDelayMs * Math.pow(2, attempt - 1)
      : policy.baseDelayMs * attempt;

  return Math.min(base, policy.maxDelayMs) + Math.random() * policy.jitterMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString();
}
