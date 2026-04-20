/**
 * Liminal - a reliable LLM tool-use orchestration engine.
 *
 * Public API. Everything not exported here is an internal detail.
 *
 * ```ts
 * import { Agent, ToolRegistry, calculatorTool } from "@bonnie-mcconnell/liminal";
 *
 * const agent = new Agent(
 *   new ToolRegistry().register(calculatorTool),
 *   { model: "claude-haiku-4-5-20251001" },
 * );
 *
 * const result = await agent.run("What is sqrt(1764)?");
 * if (result.status === "success") console.log(result.output);
 * ```
 */

// Core orchestration
export { Agent, type AgentOptions } from "./core/agent.js";
export { ToolRegistry } from "./core/registry.js";
export { ResultCache, type Cache } from "./core/result-cache.js";
export {
  DEFAULT_SHOULD_RETRY,
  DEFAULT_RETRY_POLICY,
  DEFAULT_CACHE_POLICY,
  DEFAULT_TOOL_POLICY,
} from "./core/defaults.js";

// Built-in tools
export { calculatorTool } from "./tools/calculator.js";
export { webSearchTool } from "./tools/web-search.js";
export { fileReaderTool } from "./tools/file-reader.js";
export { fetchTool } from "./tools/fetch.js";

// Observability
export { createLogger, type Logger } from "./observability/logger.js";
export { renderTrace } from "./observability/trace.js";
export { EventEmitter } from "./observability/event-emitter.js";

export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolPolicy,
  RetryPolicy,
  CachePolicy,
  ScheduledCall,
  AgentConfig,
  AgentResult,
  AgentStep,
  ExecutionTrace,
  TokenUsage,
  BudgetConfig,
  ToolEvent,
  ToolEventOfType,
} from "./types/index.js";

// Errors - exported as values (not just types) so callers can use
// instanceof checks in their own error handling.
export {
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
} from "./errors/index.js";
