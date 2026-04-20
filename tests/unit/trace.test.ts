import { describe, it, expect } from "vitest";
import { z } from "zod";
import { renderTrace } from "../../src/observability/trace.js";
import { ToolRegistry } from "../../src/core/registry.js";
import type { ExecutionTrace, AgentStep, ToolResult } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeUsage(total = 100) {
  return {
    inputTokens: Math.floor(total * 0.7),
    outputTokens: Math.floor(total * 0.3),
    totalTokens: total,
  };
}

function successResult(
  toolName: string,
  callId = "call_1",
  overrides: Partial<Extract<ToolResult, { status: "success" }>> = {},
): ToolResult {
  return {
    status: "success",
    callId,
    toolName,
    output: {},
    durationMs: 120,
    attempts: 1,
    cacheHit: false,
    ...overrides,
  };
}

function errorResult(toolName: string, callId = "call_2"): ToolResult {
  return {
    status: "error",
    callId,
    toolName,
    error: Object.assign(new Error("timed out"), { code: "TOOL_TIMEOUT" }) as never,
    attempts: 2,
  };
}

function makeStep(
  iteration: number,
  toolResults: ToolResult[] = [],
  overrides: Partial<AgentStep> = {},
): AgentStep {
  return {
    stepId: `step_${iteration}`,
    iteration,
    modelResponse: "",
    toolCalls: toolResults.map((r) => ({
      id: r.callId,
      toolName: r.toolName,
      rawInput: { query: `input for ${r.toolName}` },
    })),
    toolResults,
    usage: makeUsage(200),
    durationMs: 400,
    parallelLevels: [],
    ...overrides,
  };
}

function finalStep(iteration: number): AgentStep {
  return {
    stepId: `step_${iteration}`,
    iteration,
    modelResponse: "The answer.",
    toolCalls: [],
    toolResults: [],
    usage: makeUsage(80),
    durationMs: 150,
    parallelLevels: [],
  };
}

function makeTrace(steps: AgentStep[], durationMs = 1500): ExecutionTrace {
  const now = new Date();
  return {
    runId: "run_test123",
    startedAt: now,
    completedAt: new Date(now.getTime() + durationMs),
    steps,
    totalUsage: makeUsage(steps.reduce((sum, s) => sum + s.usage.totalTokens, 0)),
    totalDurationMs: durationMs,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderTrace", () => {
  describe("header", () => {
    it("includes runId, duration, and token count", () => {
      const header = renderTrace(makeTrace([finalStep(0)], 2340)).split("\n")[0]!;
      expect(header).toContain("run_test123");
      expect(header).toContain("2.34s");
      expect(header).toContain("tokens");
    });

    it("formats large token counts with locale separators", () => {
      const trace = { ...makeTrace([finalStep(0)]), totalUsage: makeUsage(12_500) };
      expect(renderTrace(trace).split("\n")[0]!).toMatch(/12[,\s]?500/);
    });
  });

  describe("step connectors", () => {
    it("uses ├─ for a tool step when a final-answer line follows it", () => {
      const lines = renderTrace(makeTrace([makeStep(0, [successResult("a")]), finalStep(1)])).split(
        "\n",
      );
      expect(lines.some((l) => l.startsWith("├─ Step 1"))).toBe(true);
      expect(lines.some((l) => l.startsWith("└─ Final answer"))).toBe(true);
    });

    it("uses └─ when no lines follow the last tool step", () => {
      expect(renderTrace(makeTrace([makeStep(0, [successResult("a")])]))).toContain("└─ Step 1");
    });

    it("displays 1-indexed step numbers", () => {
      const output = renderTrace(makeTrace([makeStep(0, [successResult("a")]), finalStep(1)]));
      expect(output).toContain("Step 1");
      expect(output).not.toContain("Step 0");
    });

    it("step header includes call count", () => {
      const trace = makeTrace([
        makeStep(0, [successResult("a", "c1"), successResult("b", "c2")]),
        finalStep(1),
      ]);
      const stepLine = renderTrace(trace)
        .split("\n")
        .find((l) => l.includes("Step 1"))!;
      expect(stepLine).toContain("2 calls");
    });

    it("step header uses singular 'call' for a single tool call", () => {
      const stepLine = renderTrace(makeTrace([makeStep(0, [successResult("a")]), finalStep(1)]))
        .split("\n")
        .find((l) => l.includes("Step 1"))!;
      expect(stepLine).toContain("1 call");
      expect(stepLine).not.toContain("1 calls");
    });
  });

  describe("result lines", () => {
    it("shows tool name with input arg, success, and duration", () => {
      const trace = makeTrace([
        makeStep(0, [successResult("calculator", "c1", { durationMs: 42 })]),
        finalStep(1),
      ]);
      const output = renderTrace(trace);
      expect(output).toContain("calculator(");
      expect(output).toContain("success");
      expect(output).toContain("42ms");
    });

    it("includes the primary string input arg in parentheses (fallback heuristic)", () => {
      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [{ id: "c1", toolName: "web_search", rawInput: { query: "typescript" } }],
        toolResults: [successResult("web_search", "c1")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };
      expect(renderTrace(makeTrace([step, finalStep(1)]))).toContain('web_search("typescript")');
    });

    it("prefers well-known field names over arbitrary first-key order", () => {
      // Object with 'url' before 'query' - heuristic should pick 'query'.
      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [{ id: "c1", toolName: "t", rawInput: { url: "http://x.com", query: "hello" } }],
        toolResults: [successResult("t", "c1")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };
      expect(renderTrace(makeTrace([step, finalStep(1)]))).toContain('"hello"');
    });

    it("shows 'cache hit' for cached results", () => {
      const trace = makeTrace([
        makeStep(0, [successResult("calc", "c1", { cacheHit: true, durationMs: 0 })]),
        finalStep(1),
      ]);
      expect(renderTrace(trace)).toContain("cache hit");
    });

    it("shows retry count when attempts > 1", () => {
      const trace = makeTrace([
        makeStep(0, [successResult("search", "c1", { attempts: 3 })]),
        finalStep(1),
      ]);
      expect(renderTrace(trace)).toContain("retry ×2");
    });

    it("shows error code for failed results", () => {
      const trace = makeTrace([makeStep(0, [errorResult("slow_tool")]), finalStep(1)]);
      expect(renderTrace(trace)).toContain("error: TOOL_TIMEOUT");
    });

    it("uses ├─ / └─ correctly within a step", () => {
      const trace = makeTrace([
        makeStep(0, [successResult("a", "c1"), successResult("b", "c2"), successResult("c", "c3")]),
        finalStep(1),
      ]);
      const resultLines = renderTrace(trace)
        .split("\n")
        .filter((l) => l.includes("→"));
      expect(resultLines).toHaveLength(3);
      expect(resultLines[0]).toContain("├─");
      expect(resultLines[1]).toContain("├─");
      expect(resultLines[2]).toContain("└─");
    });
  });

  describe("parallelLevels annotation", () => {
    it("annotates calls that ran in a level with siblings as [parallel]", () => {
      // Two calls in a single level - both are parallel.
      const step = makeStep(
        0,
        [successResult("web_search", "c1"), successResult("calculator", "c2")],
        {
          parallelLevels: [["web_search", "calculator"]],
        },
      );
      const output = renderTrace(makeTrace([step, finalStep(1)]));
      const resultLines = output.split("\n").filter((l) => l.includes("→"));
      expect(resultLines).toHaveLength(2);
      expect(resultLines[0]).toContain("[parallel]");
      expect(resultLines[1]).toContain("[parallel]");
    });

    it("does not annotate calls that ran alone in their level", () => {
      const step = makeStep(0, [successResult("fetch", "c1"), successResult("summarise", "c2")], {
        // fetch alone in level 0, summarise alone in level 1
        parallelLevels: [["fetch"], ["summarise"]],
      });
      const output = renderTrace(makeTrace([step, finalStep(1)]));
      expect(output).not.toContain("[parallel]");
    });

    it("includes level count in step header when levels > 1", () => {
      const step = makeStep(0, [successResult("a", "c1"), successResult("b", "c2")], {
        parallelLevels: [["a"], ["b"]],
      });
      const stepLine = renderTrace(makeTrace([step, finalStep(1)]))
        .split("\n")
        .find((l) => l.includes("Step 1"))!;
      expect(stepLine).toContain("2 levels");
    });

    it("omits level count when all calls are in one level", () => {
      const step = makeStep(0, [successResult("a", "c1"), successResult("b", "c2")], {
        parallelLevels: [["a", "b"]],
      });
      const stepLine = renderTrace(makeTrace([step, finalStep(1)]))
        .split("\n")
        .find((l) => l.includes("Step 1"))!;
      expect(stepLine).not.toContain("levels");
    });

    it("does not mark a sequential call [parallel] when the same tool name appears in a later parallel level", () => {
      // Scenario: web_search alone in level 0 (sequential),
      // then web_search + calculator together in level 1 (parallel).
      // Exactly 2 of the 3 calls should be marked [parallel].
      // Before the fix, all 3 were marked [parallel] because the renderer
      // scanned all calls with the name "web_search" without tracking which
      // level each call actually belongs to.
      const step = makeStep(
        0,
        [
          successResult("web_search", "c1"), // level 0 - alone, not parallel
          successResult("web_search", "c2"), // level 1 - parallel with calculator
          successResult("calculator", "c3"), // level 1 - parallel with web_search
        ],
        { parallelLevels: [["web_search"], ["web_search", "calculator"]] },
      );
      const output = renderTrace(makeTrace([step, finalStep(1)]));
      const toolLines = output.split("\n").filter((l) => l.includes("→"));
      // Exactly 2 of the 3 tool lines must carry [parallel] - not all 3.
      const parallelCount = toolLines.filter((l) => l.includes("[parallel]")).length;
      expect(parallelCount).toBe(2);
      // And at least one tool line must NOT have [parallel] (the sequential web_search).
      expect(toolLines.some((l) => !l.includes("[parallel]"))).toBe(true);
    });
  });

  describe("input summarization - fallback heuristic", () => {
    it("truncates long input args at 40 characters", () => {
      const long = "a".repeat(50);
      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [{ id: "c1", toolName: "t", rawInput: { query: long } }],
        toolResults: [successResult("t", "c1")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };
      const line = renderTrace(makeTrace([step, finalStep(1)]))
        .split("\n")
        .find((l) => l.includes("→"))!;
      expect(line).toContain("…");
    });

    it("renders without args when no toolCall matches the result callId", () => {
      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [],
        toolResults: [successResult("orphan", "unmatched_id")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };
      const output = renderTrace(makeTrace([step, finalStep(1)]));
      expect(output).toContain("orphan  →");
      expect(output).not.toContain("orphan(");
    });
  });

  describe("edge cases", () => {
    it("direct answer with no tool steps produces two lines", () => {
      const lines = renderTrace(makeTrace([finalStep(0)])).split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("Final answer");
    });

    it("omits 'Final answer' when the last step has tool calls", () => {
      expect(renderTrace(makeTrace([makeStep(0, [successResult("a")])]))).not.toContain(
        "Final answer",
      );
    });

    it("returns a non-empty string for an empty steps array", () => {
      const output = renderTrace(makeTrace([]));
      expect(output.trim()).toBeTruthy();
      expect(output).toContain("run_test123");
    });
  });

  describe("summarize hook and fallback", () => {
    it("falls back to heuristic when the registry's summarize hook throws", () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "bad_summarize",
        description: "test",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        execute: async () => ({ result: "" }),
        summarize: () => {
          throw new Error("summarize exploded");
        },
      });

      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [{ id: "c1", toolName: "bad_summarize", rawInput: { query: "hello" } }],
        toolResults: [successResult("bad_summarize", "c1")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };

      // Should not throw - the renderer catches and falls back to heuristic.
      // The heuristic finds "query" and uses "hello" as the label.
      const output = renderTrace(makeTrace([step, finalStep(1)]), registry);
      expect(output).toContain("bad_summarize");
      expect(output).toContain("hello");
    });

    it("falls back to first string field when input has no well-known key", () => {
      // Input has only an unknown field - heuristic should pick the first string value.
      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [{ id: "c1", toolName: "t", rawInput: { obscureField: "myvalue" } }],
        toolResults: [successResult("t", "c1")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };

      const output = renderTrace(makeTrace([step, finalStep(1)]));
      expect(output).toContain("myvalue");
    });

    it("falls back to JSON snippet when input has no string fields", () => {
      // Input is all-numeric - heuristic falls through to JSON stringify.
      const step: AgentStep = {
        stepId: "s0",
        iteration: 0,
        modelResponse: "",
        toolCalls: [{ id: "c1", toolName: "t", rawInput: { count: 42 } }],
        toolResults: [successResult("t", "c1")],
        usage: makeUsage(),
        durationMs: 100,
        parallelLevels: [],
      };

      const output = renderTrace(makeTrace([step, finalStep(1)]));
      expect(output).toContain("t(");
    });
  });
});
