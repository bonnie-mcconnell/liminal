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

  it("names the duplicate ID in the error message", () => {
    expect(() => schedule([call("dup_id", "tool_a"), call("dup_id", "tool_b")])).toThrow(/dup_id/);
  });
});

// ---------------------------------------------------------------------------
// Invariant tests — properties that must hold for any valid acyclic input
// ---------------------------------------------------------------------------

/** Builds a deterministic acyclic graph via a simple LCG so tests are reproducible. */
function randomAcyclicCalls(count: number, seed: number): ScheduledCall[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
  return Array.from({ length: count }, (_, i) => {
    const id = `c${String(i)}`;
    const toolName = `tool_${String(i)}`;
    // Deps always point at earlier indices — guaranteed acyclic.
    const depCount = i === 0 ? 0 : Math.floor(rand() * Math.min(3, i));
    const depIds: string[] = [];
    for (let d = 0; d < depCount; d++) {
      const dep = `c${String(Math.floor(rand() * i))}`;
      if (!depIds.includes(dep)) depIds.push(dep);
    }
    return { id, toolName, rawInput: {}, dependsOn: depIds };
  });
}

describe("schedule invariants (20 random acyclic graphs)", () => {
  it("every call appears exactly once across all levels", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const calls = randomAcyclicCalls(15, seed);
      const levels = schedule(calls);
      const allScheduled = levels.flat().map((c) => c.id);
      expect(allScheduled.sort()).toEqual(calls.map((c) => c.id).sort());
    }
  });

  it("no call is placed in a level before all its dependencies have completed", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const calls = randomAcyclicCalls(15, seed);
      const levels = schedule(calls);
      const done = new Set<string>();
      for (const level of levels) {
        for (const c of level) {
          for (const dep of c.dependsOn) {
            expect(
              done.has(dep),
              `${c.id} scheduled before dep ${dep} (seed ${String(seed)})`,
            ).toBe(true);
          }
        }
        for (const c of level) done.add(c.id);
      }
    }
  });
});
