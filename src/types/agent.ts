import type { AnyAgentError, AnyToolError } from "../errors/index.js";
import type { ToolCall, ToolResult } from "./tool.js";

export interface BudgetConfig {
  /**
   * Per-response cap passed to the Anthropic API as `max_tokens`.
   * Limits each individual response, not the cumulative total.
   * Use `maxTotalTokens` to limit overall spend. Default: 4096.
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
   * Static tool dependency graph. Maps a tool name to the names of tools
   * whose results it requires. Within a single turn, declared dependencies
   * are resolved to call IDs and handed to the scheduler (Kahn's algorithm),
   * which groups calls into execution levels. Dependencies on tools not called
   * that turn are silently dropped - declare the full graph once.
   *
   * All names must be registered in the `ToolRegistry`; the constructor
   * throws immediately if any are unrecognised.
   *
   * @example
   * ```ts
   * toolDependencies: { summarise_page: ["fetch_url"] }
   * ```
   */
  readonly toolDependencies?: Readonly<Record<string, readonly string[]>>;
  /**
   * Maximum simultaneous tool calls within a single scheduler level.
   * Defaults to unlimited. Use when tools hit rate-limited APIs.
   */
  readonly maxConcurrency?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** One iteration of the agent loop: one model call and all resulting tool executions. */
export interface AgentStep {
  readonly stepId: string;
  readonly iteration: number;
  readonly modelResponse: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ToolResult[];
  readonly usage: TokenUsage;
  readonly durationMs: number;
  /**
   * Execution levels produced by the scheduler for this step.
   * Each element is the set of tool names that ran concurrently in that level.
   * @example `[["web_search", "calculator"], ["summarise"]]`
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
