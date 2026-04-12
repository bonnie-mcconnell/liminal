import { CyclicDependencyError } from "../errors/index.js";
import type { ScheduledCall } from "../types/index.js";

/**
 * Groups tool calls into topologically-ordered execution levels.
 *
 * Calls within a level have no inter-dependencies and can run concurrently.
 * Calls in level N wait for level N−1 to complete before starting.
 *
 * Uses Kahn's algorithm (iterative, so no recursion-depth risk). Any calls
 * left with a nonzero in-degree after the sweep are part of a cycle.
 *
 * @example
 * ```ts
 * schedule([
 *   { id: "A", dependsOn: [] },
 *   { id: "B", dependsOn: ["A"] },
 *   { id: "C", dependsOn: ["A"] },
 *   { id: "D", dependsOn: ["B", "C"] },
 * ]);
 * // → [[A], [B, C], [D]]
 * ```
 */
export function schedule(calls: readonly ScheduledCall[]): readonly (readonly ScheduledCall[])[] {
  if (calls.length === 0) return [];

  const byId = new Map(calls.map((c) => [c.id, c]));

  if (byId.size !== calls.length) {
    throw new Error("Duplicate call IDs in the same scheduling batch");
  }

  for (const call of calls) {
    for (const dep of call.dependsOn) {
      if (!byId.has(dep)) {
        throw new Error(
          `Call "${call.id}" depends on "${dep}" which does not exist in this call set`,
        );
      }
    }
  }

  const inDegree = new Map(calls.map((c) => [c.id, c.dependsOn.length]));

  const dependents = new Map<string, string[]>();
  for (const call of calls) {
    for (const dep of call.dependsOn) {
      let list = dependents.get(dep);
      if (list === undefined) {
        list = [];
        dependents.set(dep, list);
      }
      list.push(call.id);
    }
  }

  const levels: ScheduledCall[][] = [];
  let current = calls.filter((c) => inDegree.get(c.id) === 0);

  while (current.length > 0) {
    levels.push(current);
    const next: ScheduledCall[] = [];
    for (const done of current) {
      for (const dependentId of dependents.get(done.id) ?? []) {
        const remaining = (inDegree.get(dependentId) ?? 0) - 1;
        inDegree.set(dependentId, remaining);
        if (remaining === 0) {
          const dep = byId.get(dependentId);
          if (dep !== undefined) next.push(dep);
        }
      }
    }
    current = next;
  }

  const stuck = calls.filter((c) => (inDegree.get(c.id) ?? 0) > 0);
  if (stuck.length > 0) {
    throw new CyclicDependencyError(stuck.map((c) => c.toolName));
  }

  return levels;
}
