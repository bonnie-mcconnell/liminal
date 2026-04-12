import { describe, it, expect } from "vitest";
import {
  LiminalError,
  ToolNotFoundError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolExecutionError,
  ToolTimeoutError,
  MaxRetriesExceededError,
  BudgetExceededError,
  CyclicDependencyError,
  MaxIterationsError,
  PlannerError,
} from "../../src/errors/index.js";

const ALL_ERRORS = [
  new ToolNotFoundError("t"),
  new ToolInputValidationError("t", []),
  new ToolOutputValidationError("t", []),
  new ToolExecutionError("t", new Error("cause")),
  new ToolTimeoutError("t", 5000),
  new MaxRetriesExceededError("t", 3, new Error()),
  new BudgetExceededError("tokens", 100, 150),
  new CyclicDependencyError(["a", "b"]),
  new MaxIterationsError(20),
  new PlannerError("oops"),
];

describe("Error hierarchy", () => {
  it("all error classes extend LiminalError and Error", () => {
    for (const e of ALL_ERRORS) {
      expect(e).toBeInstanceOf(LiminalError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("name matches constructor name on every error class", () => {
    for (const e of ALL_ERRORS) {
      expect(e.name).toBe(e.constructor.name);
    }
  });

  it("ToolNotFoundError has code TOOL_NOT_FOUND and includes the tool name", () => {
    const e = new ToolNotFoundError("my_tool");
    expect(e.code).toBe("TOOL_NOT_FOUND");
    expect(e.message).toContain("my_tool");
  });

  it("ToolInputValidationError formats Zod issue paths into the message", () => {
    const issues = [
      {
        path: ["query"],
        message: "Required",
        code: "invalid_type" as const,
        expected: "string" as const,
        received: "undefined" as const,
      },
    ];
    const e = new ToolInputValidationError("search", issues);
    expect(e.message).toContain("query");
    expect(e.message).toContain("Required");
  });

  it("ToolTimeoutError has code TOOL_TIMEOUT and stores timeoutMs", () => {
    const e = new ToolTimeoutError("slow_tool", 30_000);
    expect(e.code).toBe("TOOL_TIMEOUT");
    expect(e.timeoutMs).toBe(30_000);
    expect(e.message).toContain("30000ms");
  });

  it("MaxRetriesExceededError stores attempts and wraps the cause", () => {
    const cause = new Error("original");
    const e = new MaxRetriesExceededError("flaky", 3, cause);
    expect(e.attempts).toBe(3);
    expect(e.cause).toBe(cause);
    expect(e.message).toContain("3");
  });

  it("BudgetExceededError stores budgetType, limit, and used", () => {
    const e = new BudgetExceededError("tokens", 1000, 1250);
    expect(e.budgetType).toBe("tokens");
    expect(e.limit).toBe(1000);
    expect(e.used).toBe(1250);
  });

  it("CyclicDependencyError includes cycle members in the message", () => {
    const e = new CyclicDependencyError(["tool_a", "tool_b", "tool_a"]);
    expect(e.message).toContain("tool_a");
    expect(e.message).toContain("tool_b");
  });

  it("ToolExecutionError preserves cause and extracts its message", () => {
    const original = new Error("network failure");
    const e = new ToolExecutionError("fetch_tool", original);
    expect(e.cause).toBe(original);
    expect(e.message).toContain("network failure");
  });
});
