import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { ToolExecutor, computeDelay } from "../../src/core/executor.js";
import { ToolRegistry } from "../../src/core/registry.js";
import { ResultCache } from "../../src/core/result-cache.js";
import { createLogger } from "../../src/observability/logger.js";
import { EventEmitter } from "../../src/observability/event-emitter.js";
import {
  ToolNotFoundError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolTimeoutError,
  MaxRetriesExceededError,
  ToolExecutionError,
} from "../../src/errors/index.js";
import type { ToolDefinition } from "../../src/types/index.js";
import type { ToolEvent } from "../../src/types/events.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeExecutor(tools: ToolDefinition[] = []) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return new ToolExecutor(registry, new ResultCache(), createLogger("test"));
}

function makeExecutorWithEvents(tools: ToolDefinition[] = []) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const emitter = new EventEmitter<ToolEvent>();
  const events: ToolEvent[] = [];
  emitter.on((e) => events.push(e));
  const executor = new ToolExecutor(registry, new ResultCache(), createLogger("test"), emitter);
  return { executor, events };
}

function makeTool(
  name: string,
  executeFn: (input: { value: number }) => Promise<{ result: number }>,
  policyOverrides: Partial<ToolDefinition["policy"]> = {},
): ToolDefinition {
  return {
    name,
    description: "Test tool",
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ result: z.number() }),
    execute: executeFn as (input: unknown) => Promise<unknown>,
    policy: {
      timeoutMs: 5_000,
      retry: {
        maxAttempts: 1,
        backoff: "none",
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        shouldRetry: () => false,
      },
      cache: { strategy: "no-cache" },
      ...policyOverrides,
    },
  };
}

function call(toolName: string, input: unknown = { value: 1 }) {
  return { id: `call_${Math.random().toString(36).slice(2)}`, toolName, rawInput: input };
}

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe("ToolExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("tool lookup", () => {
    it("returns ToolNotFoundError for an unregistered tool name", async () => {
      const result = await makeExecutor().execute(call("unknown_tool"));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(ToolNotFoundError);
        expect(result.attempts).toBe(0);
      }
    });
  });

  describe("input validation", () => {
    it("returns ToolInputValidationError for missing required fields", async () => {
      const executor = makeExecutor([makeTool("t", async () => ({ result: 1 }))]);
      const result = await executor.execute(call("t", {}));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(ToolInputValidationError);
        expect(result.attempts).toBe(0);
      }
    });

    it("returns ToolInputValidationError for a wrong type", async () => {
      const executor = makeExecutor([makeTool("t", async () => ({ result: 1 }))]);
      const result = await executor.execute(call("t", { value: "not-a-number" }));
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toBeInstanceOf(ToolInputValidationError);
    });
  });

  describe("successful execution", () => {
    it("returns the tool output", async () => {
      const executor = makeExecutor([makeTool("t", async ({ value }) => ({ result: value * 2 }))]);
      const result = await executor.execute(call("t", { value: 5 }));
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.output).toEqual({ result: 10 });
        expect(result.cacheHit).toBe(false);
        expect(result.attempts).toBe(1);
      }
    });
  });

  describe("timeout", () => {
    it("returns ToolTimeoutError when the tool exceeds its timeout", async () => {
      const tool = makeTool(
        "slow",
        () => new Promise((resolve) => setTimeout(() => resolve({ result: 1 }), 10_000)),
        {
          timeoutMs: 100,
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
        },
      );
      const resultPromise = makeExecutor([tool]).execute(call("slow", { value: 1 }));
      await vi.advanceTimersByTimeAsync(150);
      const result = await resultPromise;
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toBeInstanceOf(ToolTimeoutError);
    });
  });

  describe("retry", () => {
    it("exhausts maxAttempts and returns MaxRetriesExceededError", async () => {
      let calls = 0;
      const tool = makeTool(
        "flaky",
        async () => {
          calls++;
          throw new Error("fail");
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      const result = await makeExecutor([tool]).execute(call("flaky", { value: 1 }));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(MaxRetriesExceededError);
        expect(result.attempts).toBe(3);
      }
      expect(calls).toBe(3);
    });

    it("does not retry when shouldRetry returns false", async () => {
      let calls = 0;
      const tool = makeTool(
        "non-retryable",
        async () => {
          calls++;
          throw new Error("fail");
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
        },
      );
      await makeExecutor([tool]).execute(call("non-retryable", { value: 1 }));
      expect(calls).toBe(1);
    });

    it("succeeds on a subsequent attempt after transient failure", async () => {
      let calls = 0;
      const tool = makeTool(
        "recovers",
        async ({ value }) => {
          if (++calls < 2) throw new Error("transient");
          return { result: value };
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      const result = await makeExecutor([tool]).execute(call("recovers", { value: 7 }));
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.attempts).toBe(2);
        expect(result.output).toEqual({ result: 7 });
      }
    });

    it("retries maxAttempts times with exponential backoff config", async () => {
      // Verify all attempts are made; delay math is covered by computeDelay unit tests.
      let calls = 0;
      const tool = makeTool(
        "exp-backoff",
        async () => {
          calls++;
          throw new Error("fail");
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "exponential",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      await makeExecutor([tool]).execute(call("exp-backoff", { value: 1 }));
      expect(calls).toBe(3);
    });

    it("retries maxAttempts times with linear backoff config", async () => {
      let calls = 0;
      const tool = makeTool(
        "linear-backoff",
        async () => {
          calls++;
          throw new Error("fail");
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "linear",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      await makeExecutor([tool]).execute(call("linear-backoff", { value: 1 }));
      expect(calls).toBe(3);
    });

    it("retries maxAttempts times even when maxDelayMs clamps the delay to zero", async () => {
      let calls = 0;
      const tool = makeTool(
        "clamped",
        async () => {
          calls++;
          throw new Error("fail");
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "exponential",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      await makeExecutor([tool]).execute(call("clamped", { value: 1 }));
      expect(calls).toBe(3);
    });
  });

  describe("caching", () => {
    it("returns a cache hit on the second identical call", async () => {
      let calls = 0;
      const tool = makeTool(
        "cached",
        async ({ value }) => {
          calls++;
          return { result: value };
        },
        { cache: { strategy: "content-hash", ttlMs: 60_000, vary: [], maxEntries: 10 } },
      );
      const executor = makeExecutor([tool]);
      await executor.execute(call("cached", { value: 3 }));
      const second = await executor.execute(call("cached", { value: 3 }));
      expect(second.status).toBe("success");
      if (second.status === "success") expect(second.cacheHit).toBe(true);
      expect(calls).toBe(1);
    });

    it("misses the cache for different inputs", async () => {
      let calls = 0;
      const tool = makeTool(
        "cached2",
        async ({ value }) => {
          calls++;
          return { result: value };
        },
        { cache: { strategy: "content-hash", ttlMs: 60_000, vary: [], maxEntries: 10 } },
      );
      const executor = makeExecutor([tool]);
      await executor.execute(call("cached2", { value: 1 }));
      await executor.execute(call("cached2", { value: 2 }));
      expect(calls).toBe(2);
    });

    it("hits the cache regardless of input object key order", async () => {
      let calls = 0;
      const registry = new ToolRegistry();
      registry.register({
        name: "order_test",
        description: "test",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        outputSchema: z.object({ result: z.number() }),
        execute: async ({ a, b }: { a: number; b: number }) => {
          calls++;
          return { result: a + b };
        },
        policy: {
          timeoutMs: 1000,
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
          cache: { strategy: "content-hash", ttlMs: 60_000, vary: [], maxEntries: 10 },
        },
      });
      const executor = new ToolExecutor(registry, new ResultCache(), createLogger("test"));
      await executor.execute({ id: "c1", toolName: "order_test", rawInput: { a: 1, b: 2 } });
      const second = await executor.execute({
        id: "c2",
        toolName: "order_test",
        rawInput: { b: 2, a: 1 },
      });
      expect(second.status).toBe("success");
      if (second.status === "success") expect(second.cacheHit).toBe(true);
      expect(calls).toBe(1);
    });
  });

  describe("output validation", () => {
    it("returns ToolOutputValidationError when the tool returns wrong-shaped data", async () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "bad_output",
        description: "test",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ result: z.number() }),
        execute: async () => ({ result: "not a number" as unknown as number }),
        policy: {
          timeoutMs: 1000,
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
          cache: { strategy: "no-cache" },
        },
      });
      const executor = new ToolExecutor(registry, new ResultCache(), createLogger("test"));
      const result = await executor.execute({
        id: "c1",
        toolName: "bad_output",
        rawInput: { value: 1 },
      });
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toBeInstanceOf(ToolOutputValidationError);
    });
  });

  describe("never throws", () => {
    it("returns an error result when shouldRetry itself throws", async () => {
      // If a custom policy's shouldRetry function throws, that must not
      // propagate out of execute() - it would break the never-throws contract.
      // The fix: wrap shouldRetry in try/catch and treat a crash as "don't retry".
      const registry = new ToolRegistry();
      registry.register({
        name: "bad_policy",
        description: "test",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ result: z.number() }),
        execute: async () => {
          throw new Error("tool failed");
        },
        policy: {
          timeoutMs: 1000,
          retry: {
            maxAttempts: 3,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => {
              throw new Error("policy exploded");
            },
          },
          cache: { strategy: "no-cache" },
        },
      });
      const executor = new ToolExecutor(registry, new ResultCache(), createLogger("test"));
      // Must not throw - must return a ToolResult with status: "error"
      const result = await executor.execute({
        id: "c1",
        toolName: "bad_policy",
        rawInput: { value: 1 },
      });
      expect(result.status).toBe("error");
    });

    it("returns an error result when the tool throws synchronously", async () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "sync_throw",
        description: "test",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ result: z.number() }),
        execute: () => {
          throw new Error("sync error");
        },
        policy: {
          timeoutMs: 1000,
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
          cache: { strategy: "no-cache" },
        },
      });
      const executor = new ToolExecutor(registry, new ResultCache(), createLogger("test"));
      const result = await executor.execute({
        id: "c1",
        toolName: "sync_throw",
        rawInput: { value: 1 },
      });
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toBeInstanceOf(ToolExecutionError);
    });
  });
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe("ToolExecutor - event emission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("successful first-attempt call", () => {
    it("emits dispatched then succeeded in order", async () => {
      const { executor, events } = makeExecutorWithEvents([
        makeTool("t", async ({ value }) => ({ result: value })),
      ]);
      await executor.execute(call("t", { value: 1 }));
      expect(events.map((e) => e.type)).toEqual(["dispatched", "succeeded"]);
    });

    it("succeeded event carries correct output and attempt count", async () => {
      const { executor, events } = makeExecutorWithEvents([
        makeTool("t", async ({ value }) => ({ result: value * 3 })),
      ]);
      await executor.execute(call("t", { value: 4 }));
      const succeeded = events.find((e) => e.type === "succeeded")!;
      if (succeeded.type === "succeeded") {
        expect(succeeded.output).toEqual({ result: 12 });
        expect(succeeded.attempts).toBe(1);
        expect(succeeded.durationMs).toBeGreaterThanOrEqual(0);
        expect(succeeded.toolName).toBe("t");
      }
    });

    it("dispatched event carries attempt number 1", async () => {
      const { executor, events } = makeExecutorWithEvents([
        makeTool("t", async ({ value }) => ({ result: value })),
      ]);
      await executor.execute(call("t", { value: 1 }));
      const dispatched = events.find((e) => e.type === "dispatched")!;
      if (dispatched.type === "dispatched") expect(dispatched.attempt).toBe(1);
    });
  });

  describe("cache hit", () => {
    it("emits cache_hit only - no dispatched or succeeded", async () => {
      const tool = makeTool("cached", async ({ value }) => ({ result: value }), {
        cache: { strategy: "content-hash", ttlMs: 60_000, vary: [], maxEntries: 10 },
      });
      const { executor, events } = makeExecutorWithEvents([tool]);
      await executor.execute(call("cached", { value: 1 }));
      events.length = 0;
      await executor.execute(call("cached", { value: 1 }));
      expect(events.map((e) => e.type)).toEqual(["cache_hit"]);
    });

    it("cache_hit event carries the cached output", async () => {
      const tool = makeTool("cached2", async ({ value }) => ({ result: value * 7 }), {
        cache: { strategy: "content-hash", ttlMs: 60_000, vary: [], maxEntries: 10 },
      });
      const { executor, events } = makeExecutorWithEvents([tool]);
      await executor.execute(call("cached2", { value: 2 }));
      events.length = 0;
      await executor.execute(call("cached2", { value: 2 }));
      const hit = events.find((e) => e.type === "cache_hit")!;
      if (hit.type === "cache_hit") expect(hit.output).toEqual({ result: 14 });
    });
  });

  describe("retry lifecycle", () => {
    it("emits the full sequence for a call that fails then succeeds", async () => {
      let attempts = 0;
      const tool = makeTool(
        "flaky",
        async ({ value }) => {
          if (++attempts < 2) throw new Error("transient");
          return { result: value };
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      const { executor, events } = makeExecutorWithEvents([tool]);
      await executor.execute(call("flaky", { value: 5 }));
      expect(events.map((e) => e.type)).toEqual([
        "dispatched",
        "attempt_failed",
        "retrying",
        "dispatched",
        "succeeded",
      ]);
    });

    it("emits the full sequence for a call that exhausts all retries", async () => {
      const tool = makeTool(
        "always_fails",
        async () => {
          throw new Error("permanent");
        },
        {
          retry: {
            maxAttempts: 3,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      const { executor, events } = makeExecutorWithEvents([tool]);
      await executor.execute(call("always_fails", { value: 1 }));
      expect(events.map((e) => e.type)).toEqual([
        "dispatched",
        "attempt_failed",
        "retrying",
        "dispatched",
        "attempt_failed",
        "retrying",
        "dispatched",
        "attempt_failed",
        "failed",
      ]);
    });

    it("attempt_failed event carries the thrown error", async () => {
      const cause = new Error("specific error");
      const tool = makeTool(
        "throws",
        async () => {
          throw cause;
        },
        {
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
        },
      );
      const { executor, events } = makeExecutorWithEvents([tool]);
      await executor.execute(call("throws", { value: 1 }));
      const failed = events.find((e) => e.type === "attempt_failed")!;
      if (failed.type === "attempt_failed") expect(failed.error).toBe(cause);
    });

    it("retrying event carries the computed delay", async () => {
      let attempts = 0;
      const tool = makeTool(
        "retries_once",
        async ({ value }) => {
          if (++attempts < 2) throw new Error("transient");
          return { result: value };
        },
        {
          retry: {
            maxAttempts: 2,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
        },
      );
      const { executor, events } = makeExecutorWithEvents([tool]);
      await executor.execute(call("retries_once", { value: 1 }));
      const retrying = events.find((e) => e.type === "retrying")!;
      if (retrying.type === "retrying") expect(retrying.delayMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("pre-dispatch failures", () => {
    it("emits failed with attempts=0 when the tool is not found", async () => {
      const { executor, events } = makeExecutorWithEvents();
      await executor.execute(call("ghost", { value: 1 }));
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("failed");
      if (events[0]?.type === "failed") expect(events[0].attempts).toBe(0);
    });

    it("emits failed with attempts=0 when input validation fails", async () => {
      const { executor, events } = makeExecutorWithEvents([
        makeTool("t", async ({ value }) => ({ result: value })),
      ]);
      await executor.execute(call("t", { value: "not-a-number" }));
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("failed");
      if (events[0]?.type === "failed") {
        expect(events[0].attempts).toBe(0);
        expect(events[0].toolName).toBe("t");
      }
    });
  });

  describe("event metadata", () => {
    it("every event carries callId, toolName, and a valid ISO timestamp", async () => {
      const { executor, events } = makeExecutorWithEvents([
        makeTool("t", async ({ value }) => ({ result: value })),
      ]);
      const c = call("t", { value: 1 });
      await executor.execute(c);
      for (const event of events) {
        expect(event.callId).toBe(c.id);
        expect(event.toolName).toBe("t");
        expect(new Date(event.ts).toISOString()).toBe(event.ts);
      }
    });
  });

  describe("listener isolation", () => {
    it("a throwing listener does not prevent the executor from completing", async () => {
      // The executor wraps emit() in try/catch, so a bad listener must not
      // propagate into the executor's result path.
      const registry = new ToolRegistry();
      registry.register(makeTool("t", async ({ value }) => ({ result: value })));
      const emitter = new EventEmitter<ToolEvent>();
      emitter.on(() => {
        throw new Error("bad listener");
      });
      const executor = new ToolExecutor(registry, new ResultCache(), createLogger("test"), emitter);
      const result = await executor.execute(call("t", { value: 1 }));
      // Despite the throwing listener, the call succeeds.
      expect(result.status).toBe("success");
    });

    it("unsubscribing stops the listener from receiving further events", async () => {
      const emitter = new EventEmitter<ToolEvent>();
      const received: string[] = [];
      const off = emitter.on((e) => received.push(e.type));
      off();
      emitter.emit({
        type: "dispatched",
        callId: "c1",
        toolName: "t",
        ts: new Date().toISOString(),
        attempt: 1,
      });
      expect(received).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// computeDelay - pure unit tests, no async, no fake timers needed
// ---------------------------------------------------------------------------

describe("computeDelay", () => {
  it("returns 0 for backoff: none", () => {
    expect(
      computeDelay(
        {
          backoff: "none",
          baseDelayMs: 500,
          maxDelayMs: 10_000,
          jitterMs: 0,
          maxAttempts: 3,
          shouldRetry: () => true,
        },
        1,
      ),
    ).toBe(0);
  });

  it("computes exponential backoff: base × 2^(attempt-1)", () => {
    const policy = {
      backoff: "exponential" as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterMs: 0,
      maxAttempts: 3,
      shouldRetry: () => true,
    };
    expect(computeDelay(policy, 1)).toBe(100); // 100 × 2^0
    expect(computeDelay(policy, 2)).toBe(200); // 100 × 2^1
    expect(computeDelay(policy, 3)).toBe(400); // 100 × 2^2
  });

  it("computes linear backoff: base × attempt", () => {
    const policy = {
      backoff: "linear" as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterMs: 0,
      maxAttempts: 3,
      shouldRetry: () => true,
    };
    expect(computeDelay(policy, 1)).toBe(100);
    expect(computeDelay(policy, 2)).toBe(200);
    expect(computeDelay(policy, 3)).toBe(300);
  });

  it("clamps exponential delay at maxDelayMs", () => {
    const policy = {
      backoff: "exponential" as const,
      baseDelayMs: 1_000,
      maxDelayMs: 500,
      jitterMs: 0,
      maxAttempts: 5,
      shouldRetry: () => true,
    };
    expect(computeDelay(policy, 1)).toBe(500);
    expect(computeDelay(policy, 2)).toBe(500);
  });

  it("clamps linear delay at maxDelayMs", () => {
    const policy = {
      backoff: "linear" as const,
      baseDelayMs: 400,
      maxDelayMs: 500,
      jitterMs: 0,
      maxAttempts: 5,
      shouldRetry: () => true,
    };
    expect(computeDelay(policy, 1)).toBe(400);
    expect(computeDelay(policy, 2)).toBe(500); // 800 clamped to 500
  });

  it("adds jitter in [0, jitterMs] to non-zero delays", () => {
    const policy = {
      backoff: "exponential" as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterMs: 50,
      maxAttempts: 3,
      shouldRetry: () => true,
    };
    // Run many times to verify jitter bounds probabilistically.
    for (let i = 0; i < 100; i++) {
      const d = computeDelay(policy, 1);
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(150);
    }
  });

  it("does not add jitter when backoff is none", () => {
    const policy = {
      backoff: "none" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterMs: 50,
      maxAttempts: 3,
      shouldRetry: () => true,
    };
    expect(computeDelay(policy, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal support
// ---------------------------------------------------------------------------

describe("AbortSignal", () => {
  const noRetryPolicy = {
    timeoutMs: 2_000,
    retry: {
      maxAttempts: 1,
      backoff: "none" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterMs: 0,
      shouldRetry: () => false,
    },
    cache: { strategy: "no-cache" as const },
  };

  it("returns a ToolExecutionError immediately when signal is already aborted before execute()", async () => {
    const tool = makeTool("t", async () => ({ result: 42 }), noRetryPolicy);
    const executor = makeExecutor([tool]);
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(
      { id: "c1", toolName: "t", rawInput: { value: 1 } },
      controller.signal,
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error).toBeInstanceOf(ToolExecutionError);
    expect(result.attempts).toBe(0);
  });

  it("emits a 'failed' event with attempts: 0 when aborted pre-dispatch", async () => {
    const tool = makeTool("t", async () => ({ result: 1 }), noRetryPolicy);
    const { executor, events } = makeExecutorWithEvents([tool]);
    const controller = new AbortController();
    controller.abort();

    await executor.execute({ id: "c1", toolName: "t", rawInput: { value: 1 } }, controller.signal);

    const failed = events.find((e) => e.type === "failed");
    expect(failed).toBeDefined();
    expect(failed?.attempts).toBe(0);
  });

  it("aborts mid-execution via the signal race - tool completes but signal fires first", async () => {
    // Tool takes 100ms; signal fires at 20ms. The abort race should win.
    const tool = makeTool(
      "slow",
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { result: 1 };
      },
      { ...noRetryPolicy, timeoutMs: 5_000 },
    );
    const executor = makeExecutor([tool]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await executor.execute(
      { id: "c1", toolName: "slow", rawInput: { value: 0 } },
      controller.signal,
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error).toBeInstanceOf(ToolExecutionError);
  });

  it("does not affect execution when no signal is passed", async () => {
    const tool = makeTool("t", async () => ({ result: 7 }), noRetryPolicy);
    const executor = makeExecutor([tool]);

    const result = await executor.execute({ id: "c1", toolName: "t", rawInput: { value: 0 } });

    expect(result.status).toBe("success");
  });

  it("aborted signal between retries stops the next attempt", async () => {
    // Tool always fails; shouldRetry returns true; but signal fires before attempt 2.
    const controller = new AbortController();
    let calls = 0;
    const tool = makeTool(
      "flaky",
      async () => {
        calls++;
        // Abort after first call so the retry-loop check catches it
        controller.abort();
        throw new Error("transient");
      },
      {
        timeoutMs: 2_000,
        retry: {
          maxAttempts: 3,
          backoff: "none" as const,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterMs: 0,
          shouldRetry: () => true,
        },
        cache: { strategy: "no-cache" as const },
      },
    );
    const executor = makeExecutor([tool]);

    const result = await executor.execute(
      { id: "c1", toolName: "flaky", rawInput: { value: 0 } },
      controller.signal,
    );

    // Should have stopped after the abort, not retried to exhaustion
    expect(calls).toBe(1);
    expect(result.status).toBe("error");
  });

  it("executes the sleep delay between retry attempts when baseDelayMs > 0", async () => {
    // Use a 5ms delay - fast enough not to slow the suite, long enough for
    // Date.now() to measure reliably. This covers the sleep() code path.
    let calls = 0;
    const tool = makeTool(
      "delayed_retry",
      async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
        return { result: 99 };
      },
      {
        timeoutMs: 5_000,
        retry: {
          maxAttempts: 2,
          backoff: "linear" as const,
          baseDelayMs: 5,
          maxDelayMs: 10,
          jitterMs: 0,
          shouldRetry: () => true,
        },
        cache: { strategy: "no-cache" as const },
      },
    );
    const executor = makeExecutor([tool]);
    const start = Date.now();

    const result = await executor.execute({
      id: "c1",
      toolName: "delayed_retry",
      rawInput: { value: 0 },
    });

    const elapsed = Date.now() - start;
    expect(result.status).toBe("success");
    expect(calls).toBe(2);
    // At least the baseDelayMs should have elapsed between attempts
    expect(elapsed).toBeGreaterThanOrEqual(4); // 5ms - 1ms timing tolerance
  });
});
