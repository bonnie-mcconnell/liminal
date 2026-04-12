import { LiminalError } from "./base.js";

/**
 * Thrown before an API call when the run has already exceeded a configured limit.
 *
 * Checked proactively so a call that would push past the limit never gets made.
 */
export class BudgetExceededError extends LiminalError {
  readonly code = "BUDGET_EXCEEDED" as const;
  constructor(
    public readonly budgetType: "tokens" | "steps",
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`${budgetType} budget exceeded: limit ${String(limit)}, used ${String(used)}`);
  }
}

/**
 * Thrown by the scheduler when a cycle exists in the tool call dependency graph.
 *
 * `cycle` lists the tool names involved, in the order Kahn's algorithm found them.
 */
export class CyclicDependencyError extends LiminalError {
  readonly code = "CYCLIC_DEPENDENCY" as const;
  constructor(public readonly cycle: string[]) {
    super(`Cyclic dependency among tool calls: ${cycle.join(" → ")}`);
  }
}

/**
 * Thrown when the agent loop exhausts its iteration ceiling without the model
 * producing a final text response.
 *
 * Usually indicates the model is looping on tool calls - check tool descriptions
 * and prompt design before raising the limit.
 */
export class MaxIterationsError extends LiminalError {
  readonly code = "MAX_ITERATIONS" as const;
  constructor(public readonly iterations: number) {
    super(`Agent reached the maximum of ${String(iterations)} iterations without a final response`);
  }
}

/** Wraps unexpected failures from the Anthropic API or the planner loop itself. */
export class PlannerError extends LiminalError {
  readonly code = "PLANNER_ERROR" as const;
}

export type AnyAgentError =
  | BudgetExceededError
  | CyclicDependencyError
  | MaxIterationsError
  | PlannerError;
