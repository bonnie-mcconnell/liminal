import { describe, it, expect } from "vitest";
import { schedule } from "../../src/core/scheduler.js";
import { CyclicDependencyError } from "../../src/errors/index.js";
import type { ScheduledCall } from "../../src/types/index.js";

function call(id: string, toolName: string, dependsOn: string[] = []): ScheduledCall {
  return { id, toolName, rawInput: {}, dependsOn };
}

describe("schedule", () => {
  it("returns empty for zero calls", () => {
    expect(schedule([])).toEqual([]);
  });

  it("puts a single independent call in level 0", () => {
    const levels = schedule([call("a", "tool_a")]);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.[0]?.id).toBe("a");
  });

  it("puts all independent calls in a single level", () => {
    const levels = schedule([call("a", "tool_a"), call("b", "tool_b"), call("c", "tool_c")]);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(3);
  });

  it("produces a linear chain for A → B → C", () => {
    const levels = schedule([
      call("a", "tool_a"),
      call("b", "tool_b", ["a"]),
      call("c", "tool_c", ["b"]),
    ]);
    expect(levels).toHaveLength(3);
    expect(levels[0]?.[0]?.id).toBe("a");
    expect(levels[1]?.[0]?.id).toBe("b");
    expect(levels[2]?.[0]?.id).toBe("c");
  });

  it("produces three levels for a diamond: A → {B,C} → D", () => {
    const levels = schedule([
      call("a", "tool_a"),
      call("b", "tool_b", ["a"]),
      call("c", "tool_c", ["a"]),
      call("d", "tool_d", ["b", "c"]),
    ]);
    expect(levels).toHaveLength(3);
    expect(levels[0]?.map((c) => c.id)).toEqual(["a"]);
    expect(levels[1]?.map((c) => c.id).sort()).toEqual(["b", "c"]);
    expect(levels[2]?.map((c) => c.id)).toEqual(["d"]);
  });

  it("handles two independent chains in parallel", () => {
    const levels = schedule([
      call("a", "tool_a"),
      call("b", "tool_b", ["a"]),
      call("c", "tool_c"),
      call("d", "tool_d", ["c"]),
    ]);
    expect(levels[0]?.map((c) => c.id).sort()).toEqual(["a", "c"]);
    expect(levels[1]?.map((c) => c.id).sort()).toEqual(["b", "d"]);
  });

  it("throws CyclicDependencyError for A → B → A", () => {
    expect(() => schedule([call("a", "tool_a", ["b"]), call("b", "tool_b", ["a"])])).toThrow(
      CyclicDependencyError,
    );
  });

  it("throws CyclicDependencyError for a self-loop", () => {
    expect(() => schedule([call("a", "tool_a", ["a"])])).toThrow(CyclicDependencyError);
  });

  it("throws when a dependency ID does not exist in the call set", () => {
    expect(() => schedule([call("a", "tool_a", ["nonexistent"])])).toThrow(/does not exist/);
  });

  it("throws when two calls share the same ID", () => {
    expect(() => schedule([call("a", "tool_a"), call("a", "tool_b")])).toThrow(/Duplicate/);
  });
});
