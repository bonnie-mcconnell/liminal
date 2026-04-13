import type { ExecutionTrace, AgentStep, ToolCall, ToolResult } from "../types/index.js";
import type { ToolRegistry } from "../core/registry.js";

/**
 * Renders an `ExecutionTrace` as a human-readable tree string.
 *
 * Pure function - takes a trace and an optional registry, returns a string.
 * No side effects, no I/O.
 *
 * When a `ToolRegistry` is provided, the renderer calls each tool's
 * `summarize` hook (if defined) to produce the input label in parentheses.
 * Without a registry the renderer falls back to a priority-ordered heuristic:
 * it checks `query`, `expression`, `path`, `url`, `id`, `name` before
 * falling back to the first string field of the input object.
 *
 * @example
 * ```
 * Run run_4a9f2b1c8d3e  ·  3.42s  ·  2,841 tokens
 * ├─ Step 1  381ms  ·  280 tokens  ·  3 calls (2 levels)
 * │  ├─ web_search("typescript strict mode")  →  success  312ms
 * │  ├─ web_search("typescript adoption 2024")  →  success  298ms  [parallel]
 * │  └─ calculator("500 * 0.62 * 0.40")  →  cache hit  0ms
 * ├─ Step 2  1,203ms  ·  180 tokens  ·  1 call
 * │  └─ file_reader("examples/context.md")  →  success  4ms
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

  // Build a set of call IDs that ran in a level with siblings, for the
  // [parallel] annotation. A call is parallel if its level has >1 member.
  //
  // We resolve tool names → call IDs level by level, consuming each matched
  // call exactly once (via a remaining-calls list per level). This prevents
  // a tool called in multiple levels from having its sequential calls
  // incorrectly marked [parallel] because the same name appears in a
  // parallel level elsewhere in the same step.
  const parallelCallIds = new Set<string>();
  for (const level of step.parallelLevels) {
    if (level.length > 1) {
      // Track which calls have already been assigned to an earlier level
      // so duplicate tool names across levels don't bleed into each other.
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
 * Produces a short human-readable label for a tool call's input.
 *
 * Resolution order:
 * 1. `tool.summarize(validatedInput)` - authoritative, per-tool hook.
 * 2. First field whose value is a string - covers the common single-query
 *    pattern (`web_search.query`, `calculator.expression`, `file_reader.path`).
 * 3. Compact JSON snippet capped at 40 characters - universal fallback.
 *
 * The registry is optional; without it, only steps 2 and 3 are available.
 * The hook receives `rawInput` (the model's unvalidated output) because
 * `summarize` is called during rendering, not during execution - the
 * validated input is no longer available at this point. Well-typed tools
 * validate their own input in `execute`, so `rawInput` matches the schema
 * for any call that succeeded.
 */
function summarize(call: ToolCall, registry: ToolRegistry | undefined): string {
  if (registry !== undefined) {
    const tool = registry.get(call.toolName);
    if (tool?.summarize !== undefined) {
      try {
        // The registry stores tools as ToolDefinition<ZodTypeAny, ZodTypeAny>,
        // erasing the concrete input type. At this point summarize is typed as
        // (input: ZodInfer<ZodTypeAny>) => string, which TypeScript cannot verify
        // rawInput satisfies - hence 'as never' to satisfy the call. The cast is
        // safe in practice: summarize is only called here, and rawInput matches
        // the schema for any call that reached the trace (validated before execute).
        return truncate(tool.summarize(call.rawInput as never), 40);
      } catch {
        // A buggy summarize hook must not crash the renderer.
      }
    }
  }

  return summarizeFallback(call.rawInput);
}

/**
 * Best-effort input summarization without a tool registry.
 *
 * Resolution order:
 * 1. Well-known primary-field names in priority order: query, expression,
 *    path, url, id, name. These cover the built-in tools and the common
 *    single-identifier patterns in custom tools.
 * 2. First field whose value is a string - covers tools whose primary
 *    field doesn't match the well-known list.
 * 3. Compact JSON snippet capped at 40 characters - universal fallback
 *    for numeric, boolean, or array-primary inputs.
 */
function summarizeFallback(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(JSON.stringify(input), 40);

  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    // Prefer well-known primary-field names over arbitrary first-key order.
    for (const key of ["query", "expression", "path", "url", "id", "name"]) {
      const val = record[key];
      if (typeof val === "string") return truncate(JSON.stringify(val), 40);
    }
    // Fall through to first string field of whatever order the object has.
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
