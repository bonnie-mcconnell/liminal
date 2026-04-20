import type { ExecutionTrace, AgentStep, ToolCall, ToolResult } from "../types/index.js";
import type { ToolRegistry } from "../core/registry.js";

/**
 * Renders an `ExecutionTrace` as a human-readable tree string.
 *
 * Pass a `ToolRegistry` to use each tool's `summarize` hook for input labels.
 * Without one, the renderer checks `query`, `expression`, `path`, `url`, `id`,
 * `name` then falls back to the first string field.
 *
 * @example
 * ```
 * Run run_4a9f2b1c8d3e  ·  3.42s  ·  2,841 tokens
 * ├─ Step 1  381ms  ·  280 tokens  ·  3 calls (2 levels)
 * │  ├─ web_search("typescript strict mode")  →  success  312ms
 * │  ├─ web_search("typescript adoption 2024")  →  success  298ms  [parallel]
 * │  └─ calculator("500 * 0.62 * 0.40")  →  cache hit  0ms
 * └─ Final answer  (487 tokens out)
 * ```
 */
export function renderTrace(trace: ExecutionTrace, registry?: ToolRegistry): string {
  const lines: string[] = [];

  lines.push(
    `Run ${trace.runId}  ·  ${(trace.totalDurationMs / 1000).toFixed(2)}s  ·  ${trace.totalUsage.totalTokens.toLocaleString()} tokens`,
  );

  // A step is renderable if it has tool calls OR orphaned tool results (a
  // ToolResult whose callId has no matching ToolCall - possible when the
  // agent builds the trace incrementally or a call is injected externally).
  // The final-answer step has neither and is rendered separately below.
  const stepsWithTools = trace.steps.filter(
    (s) => s.toolCalls.length > 0 || s.toolResults.length > 0,
  );
  const finalStep = trace.steps.at(-1);
  const hasFinalAnswer =
    finalStep !== undefined &&
    finalStep.toolCalls.length === 0 &&
    finalStep.toolResults.length === 0;

  stepsWithTools.forEach((step, i) => {
    const isLast = i === stepsWithTools.length - 1 && !hasFinalAnswer;
    lines.push(renderStep(step, isLast, registry));
  });

  if (hasFinalAnswer) {
    lines.push(`└─ Final answer  (${String(finalStep.usage.outputTokens)} tokens out)`);
  }

  return lines.join("\n");
}

function renderStep(step: AgentStep, isLast: boolean, registry: ToolRegistry | undefined): string {
  const lines: string[] = [];
  const connector = isLast ? "└─" : "├─";
  const childIndent = isLast ? "   " : "│  ";

  const callCount = step.toolCalls.length > 0 ? step.toolCalls.length : step.toolResults.length;
  const levelCount = step.parallelLevels.length;
  const parallelNote = levelCount > 1 ? `  ·  ${String(levelCount)} levels` : "";

  lines.push(
    `${connector} Step ${String(step.iteration + 1)}  ${String(step.durationMs)}ms  ·  ${String(step.usage.totalTokens)} tokens  ·  ${String(callCount)} ${callCount === 1 ? "call" : "calls"}${parallelNote}`,
  );

  const callById = new Map<string, ToolCall>(step.toolCalls.map((c) => [c.id, c]));

  // Collect IDs of calls that ran alongside siblings in a level (for [parallel] tag).
  // Consume each match once per level so the same tool name in two levels doesn't
  // bleed - a sequential call shouldn't be tagged [parallel] because its tool
  // also appeared in a different parallel level.
  const parallelCallIds = new Set<string>();
  for (const level of step.parallelLevels) {
    if (level.length > 1) {
      const remaining = [...step.toolCalls];
      for (const toolName of level) {
        const idx = remaining.findIndex((c) => c.toolName === toolName);
        if (idx !== -1) {
          const matched = remaining[idx];
          if (matched !== undefined) parallelCallIds.add(matched.id);
          remaining.splice(idx, 1);
        }
      }
    }
  }

  step.toolResults.forEach((result, i) => {
    const last = i === step.toolResults.length - 1;
    const call = callById.get(result.callId);
    const isParallel = parallelCallIds.has(result.callId);
    lines.push(
      `${childIndent}${last ? "└─" : "├─"} ${renderResult(result, call, registry, isParallel)}`,
    );
  });

  return lines.join("\n");
}

function renderResult(
  result: ToolResult,
  call: ToolCall | undefined,
  registry: ToolRegistry | undefined,
  isParallel: boolean,
): string {
  const inputLabel = call !== undefined ? summarize(call, registry) : undefined;
  const label = inputLabel !== undefined ? `${result.toolName}(${inputLabel})` : result.toolName;

  const parallelTag = isParallel ? "  [parallel]" : "";

  if (result.status === "success") {
    const cacheTag = result.cacheHit ? "  cache hit" : "";
    const retryTag = result.attempts > 1 ? `  [retry ×${String(result.attempts - 1)}]` : "";
    return `${label}  →  success  ${String(result.durationMs)}ms${cacheTag}${retryTag}${parallelTag}`;
  }

  const retryTag = result.attempts > 1 ? `  [after ${String(result.attempts)} attempts]` : "";
  return `${label}  →  error: ${result.error.code}${retryTag}${parallelTag}`;
}

/**
 * Short human-readable label for a tool call's input.
 * Tries tool.summarize() first, then falls back to summarizeFallback().
 * Receives rawInput because the validated input isn't available at render time.
 */
function summarize(call: ToolCall, registry: ToolRegistry | undefined): string {
  if (registry !== undefined) {
    const tool = registry.get(call.toolName);
    if (tool?.summarize !== undefined) {
      try {
        // Registry erases the concrete input type to ToolDefinition<ZodTypeAny>.
        // Cast is safe: rawInput matches the schema for any call that reached the trace.
        return truncate(tool.summarize(call.rawInput as never), 40);
      } catch {
        // buggy summarize hook - fall through to heuristic
      }
    }
  }

  return summarizeFallback(call.rawInput);
}

/**
 * Heuristic fallback when no summarize hook is available.
 * Checks well-known field names (query, expression, path, url, id, name),
 * then first string field, then compact JSON.
 */
function summarizeFallback(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(JSON.stringify(input), 40);

  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["query", "expression", "path", "url", "id", "name"]) {
      const val = record[key];
      if (typeof val === "string") return truncate(JSON.stringify(val), 40);
    }
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (typeof val === "string") return truncate(JSON.stringify(val), 40);
    }
  }

  return truncate(JSON.stringify(input), 40);
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}
