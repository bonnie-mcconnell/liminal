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
 * Executes a single tool call: cache check → input validation → dispatch with
 * timeout → retry with jitter → output validation → cache write → result.
 *
 * Never throws - every failure path returns a typed `ToolResult` so the agent
 * loop can forward structured feedback to the model. Pass an `AbortSignal` to
 * stop execution before the next attempt; in-flight attempts run to completion.
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly cache: Cache,
    private readonly log: Logger,
    private readonly events?: EventEmitter<ToolEvent>,
  ) {}

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    // Bail out before touching anything if already cancelled.
    if (signal?.aborted === true) {
      const error = new ToolExecutionError(call.toolName, signal.reason);
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

    // Discriminated union narrowing - accessing ttlMs on a "no-cache" policy is a compile error.
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

    return this.executeWithRetry(
      call,
      tool.execute,
      validatedInput,
      tool.outputSchema,
      policy,
      signal,
    );
  }

  private async executeWithRetry(
    call: ToolCall,
    executeFn: (input: unknown, signal?: AbortSignal) => Promise<unknown>,
    input: unknown,
    outputSchema: ZodTypeAny,
    policy: ToolPolicy,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const runStart = Date.now();
    let attempt = 0;
    let lastError: unknown;

    while (attempt < policy.retry.maxAttempts) {
      // Check before every attempt - signal could have fired since the pre-dispatch check.
      if (signal?.aborted === true) {
        const error = new ToolExecutionError(call.toolName, signal.reason);
        this.log.warn("tool.aborted", { callId: call.id, toolName: call.toolName, attempt });
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
        // Manually managed timeout so we can clear it on success - a dangling
        // timer keeps the event loop alive.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new ToolTimeoutError(call.toolName, policy.timeoutMs));
          }, policy.timeoutMs);
        });

        // Race the abort signal alongside execution and timeout. { once: true }
        // removes the listener on fire, but not on success - explicit cleanup
        // in the finally block prevents a dangling listener and its potential
        // unhandled rejection if the signal fires later.
        let onAbort: (() => void) | undefined;
        let abortReject: ((err: unknown) => void) | undefined;
        const abortPromise =
          signal !== undefined
            ? new Promise<never>((_, reject) => {
                abortReject = reject;
                if (signal.aborted) {
                  reject(new ToolExecutionError(call.toolName, signal.reason));
                  return;
                }
                onAbort = () => {
                  reject(new ToolExecutionError(call.toolName, signal.reason));
                };
                signal.addEventListener("abort", onAbort, { once: true });
              })
            : undefined;

        const racers: Promise<unknown>[] = [executeFn(input, signal), timeoutPromise];
        if (abortPromise !== undefined) racers.push(abortPromise);

        try {
          rawOutput = await Promise.race(racers);
        } finally {
          clearTimeout(timeoutHandle);
          if (onAbort !== undefined && signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          // Silence the losing abort promise - we only care about the race winner.
          abortPromise?.catch(() => undefined);
          void abortReject; // referenced to prevent TS unused-var warning
        }
      } catch (err) {
        lastError = err;
        // Wrap shouldRetry so a buggy policy function can't break the never-throws contract.
        let willRetry = false;
        try {
          willRetry = policy.retry.shouldRetry(err, attempt) && attempt < policy.retry.maxAttempts;
        } catch (policyErr) {
          this.log.warn("tool.should_retry_threw", {
            callId: call.id,
            toolName: call.toolName,
            attempt,
            error: String(policyErr),
          });
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
        // Output validation failure is a bug in the tool, not the model - retrying won't help.
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
        this.cache.set(call.toolName, input, policy.cache.vary, outParse.data, policy.cache.ttlMs);
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

    // Wrap in MaxRetriesExceededError only when retries were configured.
    // For single-attempt tools the underlying error is the right signal.
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
 * Delay before the next retry attempt, with uniform jitter in [0, jitterMs].
 * Exponential: baseDelayMs × 2^(attempt−1), capped at maxDelayMs.
 * Linear:      baseDelayMs × attempt, same cap.
 * Jitter desynchronises clients that all fail at the same moment.
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
