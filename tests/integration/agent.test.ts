import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  BudgetExceededError,
  CyclicDependencyError,
  MaxIterationsError,
  ToolNotFoundError,
  PlannerError,
} from "../../src/errors/index.js";
import { ResultCache } from "../../src/core/result-cache.js";
import type { ToolDefinition } from "../../src/types/index.js";

const MODEL = "claude-opus-4-6";

type MockContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface MockResponse {
  stop_reason: "end_turn" | "tool_use";
  content: MockContent[];
  usage: { input_tokens: number; output_tokens: number };
}

let _queue: MockResponse[] = [];
let _callCount = 0;

function setResponses(responses: MockResponse[]): void {
  _queue = [...responses];
  _callCount = 0;
}

function callCount(): number {
  return _callCount;
}

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockImplementation(() => {
        const response = _queue[_callCount++];
        if (response === undefined) {
          throw new Error(
            `Mock exhausted: messages.create called ${_callCount} time(s) ` +
              `but only ${_queue.length} response(s) were configured.`,
          );
        }
        return Promise.resolve(response);
      }),
    },
  })),
}));

const { Agent } = await import("../../src/core/agent.js");
const { ToolRegistry } = await import("../../src/core/registry.js");

function textResponse(text: string, tokens = { input: 100, output: 50 }): MockResponse {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
  };
}

function toolResponse(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  tokens = { input: 200, output: 80 },
): MockResponse {
  return {
    stop_reason: "tool_use",
    content: calls.map((c) => ({ type: "tool_use" as const, ...c })),
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
  };
}

function echoTool(name = "echo"): ToolDefinition {
  return {
    name,
    description: "Returns its input value unchanged.",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    execute: async ({ value }: { value: string }) => ({ echoed: value }),
    policy: {
      timeoutMs: 2_000,
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
  };
}

describe("Agent - integration", () => {
  beforeEach(() => setResponses([]));

  describe("direct answer", () => {
    it("returns model text when no tools are invoked", async () => {
      setResponses([textResponse("The answer is 42.")]);

      const result = await new Agent(new ToolRegistry(), { model: MODEL }).run("What is 6 × 7?");

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.output).toBe("The answer is 42.");
      expect(result.trace.steps).toHaveLength(1);
      expect(result.trace.steps[0]?.toolCalls).toHaveLength(0);
    });
  });

  describe("two-step run", () => {
    it("executes the tool and feeds its result back before the final answer", async () => {
      setResponses([
        toolResponse([{ id: "c1", name: "echo", input: { value: "hello" } }]),
        textResponse("The tool echoed: hello."),
      ]);

      const registry = new ToolRegistry().register(echoTool());
      const result = await new Agent(registry, { model: MODEL }).run("Echo hello.");

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.output).toBe("The tool echoed: hello.");
      expect(result.trace.steps).toHaveLength(2);

      const step0 = result.trace.steps[0]!;
      expect(step0.toolCalls).toHaveLength(1);
      expect(step0.toolResults[0]?.status).toBe("success");
      expect(step0.toolResults[0]?.toolName).toBe("echo");
    });
  });

  describe("parallel execution", () => {
    it("runs independent calls concurrently - fast tool finishes before slow tool", async () => {
      const order: string[] = [];

      setResponses([
        toolResponse([
          { id: "slow", name: "slow_tool", input: { value: "s" } },
          { id: "fast", name: "fast_tool", input: { value: "f" } },
        ]),
        textResponse("Done."),
      ]);

      const slowTool: ToolDefinition = {
        name: "slow_tool",
        description: "Slow.",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        execute: async ({ value }: { value: string }) => {
          await new Promise((r) => setTimeout(r, 60));
          order.push("slow_tool");
          return { echoed: value };
        },
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
        },
      };

      const fastTool: ToolDefinition = {
        name: "fast_tool",
        description: "Fast.",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        execute: async ({ value }: { value: string }) => {
          await new Promise((r) => setTimeout(r, 10));
          order.push("fast_tool");
          return { echoed: value };
        },
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
        },
      };

      const registry = new ToolRegistry().register(slowTool).register(fastTool);
      await new Agent(registry, { model: MODEL }).run("Run both.");

      expect(order).toEqual(["fast_tool", "slow_tool"]);
    });
  });

  describe("tool error recovery", () => {
    it("surfaces a ToolNotFoundError to the model and continues to a final answer", async () => {
      setResponses([
        toolResponse([{ id: "c_bad", name: "no_such_tool", input: {} }]),
        textResponse("Recovered."),
      ]);

      const result = await new Agent(new ToolRegistry(), { model: MODEL }).run(
        "Use the missing tool.",
      );

      expect(result.status).toBe("success");
      if (result.status !== "success") return;

      const toolResult = result.trace.steps[0]?.toolResults[0];
      expect(toolResult?.status).toBe("error");
      if (toolResult?.status === "error") {
        expect(toolResult.error).toBeInstanceOf(ToolNotFoundError);
      }
    });

    it("delivers partial results when one of two parallel calls fails", async () => {
      setResponses([
        toolResponse([
          { id: "c1", name: "echo", input: { value: "ok" } },
          { id: "c2", name: "no_such_tool", input: {} },
        ]),
        textResponse("Partial results handled."),
      ]);

      const registry = new ToolRegistry().register(echoTool());
      const result = await new Agent(registry, { model: MODEL }).run("Two tools.");

      expect(result.status).toBe("success");
      if (result.status !== "success") return;

      const results = result.trace.steps[0]?.toolResults ?? [];
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.status).sort()).toEqual(["error", "success"]);
    });
  });

  describe("budget enforcement", () => {
    it("aborts before step 2 when token budget was exceeded in step 1", async () => {
      // Step 1 consumes 300 tokens (200 in + 100 out). Budget cap is 250.
      setResponses([
        toolResponse([{ id: "c1", name: "echo", input: { value: "x" } }], {
          input: 200,
          output: 100,
        }),
        textResponse("Should not appear."),
      ]);

      const registry = new ToolRegistry().register(echoTool());
      const result = await new Agent(registry, {
        model: MODEL,
        budget: { maxTotalTokens: 250 },
      }).run("Exceed the budget.");

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error).toBeInstanceOf(BudgetExceededError);
      expect((result.error as BudgetExceededError).budgetType).toBe("tokens");
    });

    it("aborts before the first API call when maxSteps is zero", async () => {
      setResponses([textResponse("Should not appear.")]);

      const result = await new Agent(new ToolRegistry(), {
        model: MODEL,
        budget: { maxSteps: 0 },
      }).run("Do anything.");

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error).toBeInstanceOf(BudgetExceededError);
      expect(callCount()).toBe(0);
    });
  });

  describe("max iterations", () => {
    it("returns MaxIterationsError when the model never produces a final answer", async () => {
      // Provide more responses than maxIterations so the mock never exhausts.
      setResponses(
        Array.from({ length: 10 }, (_, i) =>
          toolResponse([{ id: `c${i}`, name: "echo", input: { value: "x" } }]),
        ),
      );

      const registry = new ToolRegistry().register(echoTool());
      const result = await new Agent(registry, {
        model: MODEL,
        maxIterations: 3,
      }).run("Never finish.");

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error).toBeInstanceOf(MaxIterationsError);
      expect((result.error as MaxIterationsError).iterations).toBe(3);
    });
  });

  describe("execution trace", () => {
    it("accumulates token usage correctly across multiple steps", async () => {
      setResponses([
        toolResponse([{ id: "c1", name: "echo", input: { value: "a" } }], {
          input: 100,
          output: 40,
        }),
        textResponse("Done.", { input: 80, output: 30 }),
      ]);

      const registry = new ToolRegistry().register(echoTool());
      const result = await new Agent(registry, { model: MODEL }).run("Two steps.");

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.usage.inputTokens).toBe(180);
      expect(result.usage.outputTokens).toBe(70);
      expect(result.usage.totalTokens).toBe(250);
      expect(result.trace.totalUsage.totalTokens).toBe(250);
    });

    it("sets completedAt >= startedAt and both within wall-clock bounds", async () => {
      setResponses([textResponse("hi")]);

      const before = new Date();
      const result = await new Agent(new ToolRegistry(), { model: MODEL }).run("hi");
      const after = new Date();

      expect(result.trace.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.trace.completedAt.getTime()).toBeGreaterThanOrEqual(
        result.trace.startedAt.getTime(),
      );
      expect(result.trace.completedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("always includes a trace even when the run fails", async () => {
      setResponses([textResponse("irrelevant")]);

      const result = await new Agent(new ToolRegistry(), {
        model: MODEL,
        budget: { maxSteps: 0 },
      }).run("Fail immediately.");

      expect(result.trace).toBeDefined();
      expect(result.trace.runId).toMatch(/^run_/);
    });
  });

  describe("shared cache", () => {
    it("serves cached results to a second agent sharing the same ResultCache", async () => {
      let executions = 0;

      const cachedEchoTool: ToolDefinition = {
        name: "cached_echo",
        description: "Cached echo.",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        execute: async ({ value }: { value: string }) => {
          executions++;
          return { echoed: value };
        },
        policy: {
          timeoutMs: 1_000,
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
          cache: { strategy: "content-hash", ttlMs: 60_000, vary: [], maxEntries: 100 },
        },
      };

      const cache = new ResultCache();

      setResponses([
        toolResponse([{ id: "c1", name: "cached_echo", input: { value: "hello" } }]),
        textResponse("First done."),
      ]);
      await new Agent(new ToolRegistry().register(cachedEchoTool), { model: MODEL }, { cache }).run(
        "Run 1.",
      );

      setResponses([
        toolResponse([{ id: "c2", name: "cached_echo", input: { value: "hello" } }]),
        textResponse("Second done."),
      ]);
      const result = await new Agent(
        new ToolRegistry().register(cachedEchoTool),
        { model: MODEL },
        { cache },
      ).run("Run 2.");

      expect(result.status).toBe("success");
      expect(executions).toBe(1);
    });
  });

  describe("toolDependencies", () => {
    it("runs independent calls in one level when no dependencies are declared", async () => {
      const order: string[] = [];

      setResponses([
        toolResponse([
          { id: "c1", name: "echo", input: { value: "a" } },
          { id: "c2", name: "echo2", input: { value: "b" } },
        ]),
        textResponse("Done."),
      ]);

      const makeOrderedTool = (name: string, delayMs: number): ToolDefinition => ({
        name,
        description: "Ordered echo.",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        execute: async ({ value }: { value: string }) => {
          await new Promise((r) => setTimeout(r, delayMs));
          order.push(name);
          return { echoed: value };
        },
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
        },
      });

      const registry = new ToolRegistry()
        .register(makeOrderedTool("echo", 50))
        .register(makeOrderedTool("echo2", 10));

      const result = await new Agent(registry, { model: MODEL }).run("Run both.");

      // Without dependencies both are in one level. echo2 finishes first (10ms < 50ms).
      expect(order).toEqual(["echo2", "echo"]);
      if (result.status !== "success") return;
      expect(result.trace.steps[0]?.parallelLevels).toHaveLength(1);
    });

    it("sequences calls according to declared tool dependencies", async () => {
      const order: string[] = [];

      setResponses([
        toolResponse([
          { id: "c1", name: "fetch", input: { value: "url" } },
          { id: "c2", name: "summarise", input: { value: "text" } },
        ]),
        textResponse("Done."),
      ]);

      const makeTool = (name: string, delayMs = 0): ToolDefinition => ({
        name,
        description: `${name} tool.`,
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        execute: async ({ value }: { value: string }) => {
          await new Promise((r) => setTimeout(r, delayMs));
          order.push(name);
          return { echoed: value };
        },
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
        },
      });

      const registry = new ToolRegistry()
        .register(makeTool("fetch", 10))
        .register(makeTool("summarise", 0));

      // summarise runs faster but must wait for fetch.
      const result = await new Agent(registry, {
        model: MODEL,
        toolDependencies: { summarise: ["fetch"] },
      }).run("Fetch then summarise.");

      expect(order).toEqual(["fetch", "summarise"]);
      if (result.status !== "success") return;

      const levels = result.trace.steps[0]?.parallelLevels ?? [];
      expect(levels).toHaveLength(2);
      expect(levels[0]).toEqual(["fetch"]);
      expect(levels[1]).toEqual(["summarise"]);
    });

    it("ignores dependencies on tools not called in the current turn", async () => {
      // Graph declares summarise depends on 'missing_tool', but that tool
      // isn't called this turn - summarise should run immediately.
      setResponses([
        toolResponse([{ id: "c1", name: "echo", input: { value: "x" } }]),
        textResponse("Done."),
      ]);

      const result = await new Agent(new ToolRegistry().register(echoTool()), {
        model: MODEL,
        toolDependencies: { echo: ["missing_tool"] },
      }).run("Echo once.");

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      // echo has no deps present this turn → one level
      expect(result.trace.steps[0]?.parallelLevels).toHaveLength(1);
    });

    it("records parallelLevels on every step, including the final answer step", async () => {
      setResponses([
        toolResponse([{ id: "c1", name: "echo", input: { value: "x" } }]),
        textResponse("Done."),
      ]);

      const result = await new Agent(new ToolRegistry().register(echoTool()), { model: MODEL }).run(
        "Echo.",
      );
      if (result.status !== "success") return;

      // Step 0: tool call step - has levels
      expect(result.trace.steps[0]?.parallelLevels).toBeDefined();
      // Step 1: final answer step - empty levels
      expect(result.trace.steps[1]?.parallelLevels).toEqual([]);
    });

    it("returns CyclicDependencyError as a structured result when toolDependencies creates a cycle", async () => {
      // The model requests both tools. The dependency graph A→B, B→A is a cycle.
      // The scheduler should detect it and the agent should return a structured
      // error rather than rejecting the promise.
      setResponses([
        toolResponse([
          { id: "c1", name: "echo", input: { value: "a" } },
          { id: "c2", name: "echo2", input: { value: "b" } },
        ]),
      ]);

      const registry = new ToolRegistry().register(echoTool("echo")).register(echoTool("echo2"));

      const result = await new Agent(registry, {
        model: MODEL,
        toolDependencies: {
          echo: ["echo2"],
          echo2: ["echo"],
        },
      }).run("This will cycle.");

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error).toBeInstanceOf(CyclicDependencyError);
      // The trace is always populated even on hard errors.
      expect(result.trace).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("returns MaxIterationsError immediately when maxIterations is 0", async () => {
      setResponses([textResponse("never reached")]);

      const result = await new Agent(new ToolRegistry(), {
        model: MODEL,
        maxIterations: 0,
      }).run("anything");

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error).toBeInstanceOf(MaxIterationsError);
      expect(callCount()).toBe(0);
    });

    it("returns PlannerError when the Anthropic API call throws", async () => {
      // Configure zero responses so the mock throws on the first messages.create call.
      // This exercises the try/catch around the API call in the agent loop,
      // which wraps unexpected SDK errors in a PlannerError and returns a
      // structured AgentResult rather than rejecting the run() promise.
      setResponses([]);

      const result = await new Agent(new ToolRegistry(), { model: MODEL }).run("anything");

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error).toBeInstanceOf(PlannerError);
      // trace is always present, even on hard abort
      expect(result.trace).toBeDefined();
      expect(result.trace.runId).toMatch(/^run_/);
    });

    it("succeeds when a tool fails once then recovers on retry", async () => {
      // First model turn requests the tool. The tool fails attempt 1, succeeds attempt 2.
      // Second model turn produces the final answer.
      setResponses([
        toolResponse([{ id: "c1", name: "flaky_echo", input: { value: "hello" } }]),
        textResponse("Tool recovered: hello."),
      ]);

      let attempts = 0;
      const flakyTool: ToolDefinition = {
        name: "flaky_echo",
        description: "Echoes value. Fails on first attempt.",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        execute: async ({ value }: { value: string }) => {
          attempts++;
          if (attempts === 1) throw new Error("transient failure");
          return { echoed: value };
        },
        policy: {
          timeoutMs: 2_000,
          retry: {
            maxAttempts: 2,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => true,
          },
          cache: { strategy: "no-cache" },
        },
      };

      const result = await new Agent(new ToolRegistry().register(flakyTool), { model: MODEL }).run(
        "Echo hello.",
      );

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(attempts).toBe(2);
      expect(result.output).toBe("Tool recovered: hello.");
      // The step should record 2 attempts on the successful result
      const toolResult = result.trace.steps[0]?.toolResults[0];
      expect(toolResult?.status).toBe("success");
      if (toolResult?.status === "success") {
        expect(toolResult.attempts).toBe(2);
      }
    });
  });
});
