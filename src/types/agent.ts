import type { AnyAgentError, AnyToolError } from "../errors/index.js";
import type { ToolCall, ToolResult } from "./tool.js";

export interface BudgetConfig {
  /**
   * Per-response cap passed to the Anthropic API as max_tokens.
   * Limits each individual response, not the cumulative total.
   * Use maxTotalTokens to limit overall spend. Default: 4096.
   */
  readonly maxOutputTokens?: number;
  /** Abort before a call when cumulative tokens across all steps would exceed this. */
  readonly maxTotalTokens?: number;
  /** Abort before a call when the iteration count reaches this. */
  readonly maxSteps?: number;
}

export interface AgentConfig {
  readonly model: string;
  readonly systemPrompt?: string;
  /** Default: 20. */
  readonly maxIterations: number;
  readonly budget: BudgetConfig;
  /**
   * Static tool dependency graph.
   *
   * Maps a tool name to the names of tools whose results it requires.
   * Within a single model turn, if both `A` and `B` are called and `B`
   * depends on `A`, the agent will run `A` first, then `B` - even though
   * the model requested them in the same response.
   *
   * Dependencies that reference tools not called in a given turn are silently
   * ignored, so you can declare the full graph once and let it apply
   * selectively across turns.
   *
   * @example
   * ```ts
   * // summarise_page always needs fetch_url to have run first
   * toolDependencies: {
   *   summarise_page: ["fetch_url"],
   * }
   * ```
   *
   * Under the hood, the scheduler (Kahn's algorithm) converts this into
   * execution levels: everything in a level has no unresolved dependencies
   * and runs concurrently via `Promise.allSettled`. Cycles throw
   * `CyclicDependencyError` immediately.
   */
  readonly toolDependencies?: Readonly<Record<string, readonly string[]>>;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * One iteration of the agent loop: one model call, all resulting tool
 * executions, and the usage for that call.
 */
export interface AgentStep {
  readonly stepId: string;
  readonly iteration: number;
  readonly modelResponse: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ToolResult[];
  readonly usage: TokenUsage;
  readonly durationMs: number;
  /**
   * The execution levels produced by the scheduler for this step.
   *
   * Each element is the set of tool names that ran concurrently in that
   * level. Level 0 is always the first to run. A step with no tool calls
   * has an empty array.
   *
   * Useful for confirming that independent tools ran in parallel and that
   * declared dependencies produced the expected sequencing.
   *
   * @example `[["web_search", "calculator"], ["summarise"]]`
   * - two tools ran first in parallel, then one that depended on them.
   */
  readonly parallelLevels: readonly (readonly string[])[];
}

/** Complete record of a single agent run. Always present, even on failure. */
export interface ExecutionTrace {
  readonly runId: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly steps: readonly AgentStep[];
  readonly totalUsage: TokenUsage;
  readonly totalDurationMs: number;
}

export type AgentResult =
  | {
      readonly status: "success";
      readonly output: string;
      readonly trace: ExecutionTrace;
      readonly usage: TokenUsage;
    }
  | {
      readonly status: "error";
      readonly error: AnyAgentError | AnyToolError;
      readonly trace: ExecutionTrace;
      readonly usage: TokenUsage;
    };
