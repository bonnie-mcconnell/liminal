import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  AgentResult,
  AgentStep,
  ExecutionTrace,
  ToolCall,
  ToolResult,
  TokenUsage,
  ScheduledCall,
} from "../types/index.js";
import type { ToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import { ResultCache, type Cache } from "./result-cache.js";
import { schedule } from "./scheduler.js";
import { createLogger } from "../observability/logger.js";
import { EventEmitter } from "../observability/event-emitter.js";
import type { ToolEvent } from "../types/events.js";
import {
  BudgetExceededError,
  CyclicDependencyError,
  MaxIterationsError,
  PlannerError,
  type AnyAgentError,
  type AnyToolError,
} from "../errors/index.js";

const DEFAULT_CONFIG: Omit<AgentConfig, "model"> = {
  maxIterations: 20,
  budget: {},
  // maxConcurrency defaults to undefined (unlimited)
};

/**
 * Options passed to the `Agent` constructor that are not part of the
 * per-run configuration.
 */
export interface AgentOptions {
  /**
   * Cache backend. When omitted, the agent creates a private `ResultCache`.
   * Pass a shared instance to deduplicate tool calls across multiple agents
   * or across successive calls to `run()`:
   *
   * ```ts
   * const cache = new ResultCache();
   * const agent = new Agent(registry, config, { cache });
   * ```
   *
   * Any value satisfying the `Cache` interface works here - including a
   * Redis-backed implementation for cross-process sharing.
   */
  cache?: Cache;
  /** Falls back to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string;
  /**
   * Called synchronously for every `ToolEvent` emitted during a run.
   *
   * Use this for progress indicators, dashboards, metrics collection, or
   * detailed test assertions. The callback receives a fully typed event -
   * narrow on `event.type` to handle specific transitions:
   *
   * ```ts
   * const agent = new Agent(registry, config, {
   *   onEvent(event) {
   *     if (event.type === "dispatched") {
   *       console.log(`→ ${event.toolName} (attempt ${event.attempt})`);
   *     }
   *     if (event.type === "retrying") {
   *       console.warn(`  retrying in ${event.delayMs}ms…`);
   *     }
   *     if (event.type === "succeeded") {
   *       metrics.record("tool.duration", event.durationMs, { tool: event.toolName });
   *     }
   *   },
   * });
   * ```
   *
   * The callback must not throw - exceptions are caught and logged.
   * For async work, use `queueMicrotask` or `setTimeout` inside the handler;
   * the agent loop does not await event callbacks.
   */
  onEvent?: (event: ToolEvent) => void;
}

/**
 * Drives the agent loop: calls the model, executes tool requests in
 * dependency order, feeds results back, and repeats until the model
 * produces a final text response or a configured limit is reached.
 *
 * **Error handling** - tool errors are returned to the model as structured
 * `tool_result` messages rather than aborting the run. The model receives
 * the error code and message and can adjust its plan (different parameters,
 * a different tool, or a direct answer). Only budget violations and the
 * iteration ceiling cause a hard abort.
 *
 * **Parallelism** - independent tool calls in a single turn run
 * concurrently via `Promise.allSettled`. A failure in one call does not
 * cancel the others. Tool dependencies declared in `AgentConfig.toolDependencies`
 * impose sequencing where needed.
 */
export class Agent {
  private readonly client: Anthropic;
  private readonly config: AgentConfig;
  private readonly cache: Cache;
  private readonly events: EventEmitter<ToolEvent>;

  constructor(
    private readonly registry: ToolRegistry,
    config: Partial<AgentConfig> & Pick<AgentConfig, "model">,
    { cache, apiKey, onEvent }: AgentOptions = {},
  ) {
    this.client = new Anthropic({ apiKey });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = cache ?? new ResultCache();
    this.events = new EventEmitter<ToolEvent>();
    if (onEvent !== undefined) this.events.on(onEvent);
  }

  async run(task: string): Promise<AgentResult> {
    const runId = generateRunId();
    const log = createLogger(runId);
    const executor = new ToolExecutor(this.registry, this.cache, log, this.events);
    const startedAt = new Date();
    const steps: AgentStep[] = [];
    const totalUsage: Mutable<TokenUsage> = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    log.info("agent.started", {
      model: this.config.model,
      task: task.slice(0, 120),
      maxIterations: this.config.maxIterations,
    });

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
    const tools = this.registry.toAnthropicTools();

    let finalOutput: string | undefined;
    let hardError: AnyAgentError | AnyToolError | undefined;

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      const budgetError = checkBudget(this.config.budget, totalUsage, iteration);
      if (budgetError !== undefined) {
        log.warn("agent.budget_exceeded", { budgetType: budgetError.budgetType });
        hardError = budgetError;
        break;
      }

      const stepStart = Date.now();
      let response: Anthropic.Message;

      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: this.config.model,
          max_tokens: this.config.budget.maxOutputTokens ?? 4096,
          messages,
        };
        if (this.config.systemPrompt !== undefined) params.system = this.config.systemPrompt;
        if (tools.length > 0) params.tools = tools;
        response = await this.client.messages.create(params);
      } catch (err) {
        log.error("agent.api_error", { iteration, error: String(err) });
        hardError = new PlannerError(
          `API call failed: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
        break;
      }

      accumulateUsage(totalUsage, response.usage);

      const textContent = extractText(response.content);
      const toolUseBlocks = extractToolUse(response.content);

      if (toolUseBlocks.length === 0) {
        finalOutput = textContent;
        steps.push({
          stepId: `step_${String(iteration)}`,
          iteration,
          modelResponse: textContent,
          toolCalls: [],
          toolResults: [],
          usage: snapshotUsage(response.usage),
          durationMs: Date.now() - stepStart,
          parallelLevels: [],
        });
        log.info("agent.completed", {
          totalTokens: totalUsage.totalTokens,
          steps: steps.length,
          durationMs: Date.now() - startedAt.getTime(),
        });
        break;
      }

      const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id,
        toolName: b.name,
        rawInput: b.input,
      }));

      // Resolve declared tool dependencies into the call IDs present in this
      // turn. Dependencies referencing tools not called this turn are ignored
      // - the graph is declared statically but applied selectively per turn.
      const scheduled = resolveScheduledCalls(toolCalls, this.config.toolDependencies);

      let levels: readonly (readonly ScheduledCall[])[];
      try {
        levels = schedule(scheduled);
      } catch (err) {
        // CyclicDependencyError is a configuration mistake - a declared
        // dependency graph that creates a loop. Return a structured error
        // rather than letting the exception reject the run() promise.
        log.error("agent.cyclic_dependency", { error: String(err) });
        hardError =
          err instanceof CyclicDependencyError
            ? err
            : new PlannerError(`Scheduler failed: ${String(err)}`, err);
        break;
      }

      const parallelLevels = levels.map((level) => level.map((c) => c.toolName));

      if (parallelLevels.length > 0) {
        log.debug("agent.scheduled", {
          levels: parallelLevels.length,
          plan: parallelLevels.map((l) => l.join("+")).join(" → "),
        });
      }

      const toolResults: ToolResult[] = [];

      for (const level of levels) {
        const settled = await allSettledConcurrent(
          level.map((call) => () => executor.execute(call)),
          this.config.maxConcurrency,
        );
        for (const result of settled) {
          if (result.status === "fulfilled") {
            toolResults.push(result.value);
          } else {
            // executor.execute() is documented to never reject. This branch
            // guards the invariant and will surface immediately in tests if
            // that contract is ever accidentally broken.
            log.error("agent.executor_threw", { reason: String(result.reason) });
          }
        }
      }

      messages.push(
        buildAssistantMessage(textContent, toolUseBlocks),
        buildToolResultMessage(toolResults),
      );

      steps.push({
        stepId: `step_${String(iteration)}`,
        iteration,
        modelResponse: textContent,
        toolCalls,
        toolResults,
        usage: snapshotUsage(response.usage),
        durationMs: Date.now() - stepStart,
        parallelLevels,
      });
    }

    if (finalOutput === undefined && hardError === undefined) {
      hardError = new MaxIterationsError(this.config.maxIterations);
      log.error("agent.max_iterations", { iterations: this.config.maxIterations });
    }

    const completedAt = new Date();
    const trace: ExecutionTrace = {
      runId,
      startedAt,
      completedAt,
      steps,
      totalUsage: { ...totalUsage },
      totalDurationMs: completedAt.getTime() - startedAt.getTime(),
    };

    if (finalOutput !== undefined) {
      return { status: "success", output: finalOutput, trace, usage: { ...totalUsage } };
    }

    // At this point finalOutput is undefined, which means the loop exited via
    // break (budget, API error, or max-iterations guard above) - so hardError
    // is always defined. The non-null assertion makes that invariant explicit
    // rather than hiding it behind a ?? fallback that can never fire.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { status: "error", error: hardError!, trace, usage: { ...totalUsage } };
  }
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Converts a flat list of tool calls into `ScheduledCall` objects with
 * resolved `dependsOn` arrays.
 *
 * The static dependency graph in `AgentConfig.toolDependencies` is keyed by
 * tool name. Each turn, we have a concrete set of call IDs. This function
 * bridges the two: for each call, it finds any declared dependencies whose
 * tools are also being called this turn, then maps those tool names to their
 * actual call IDs.
 *
 * Dependencies on tools not present in this turn are silently dropped - the
 * graph is declared globally but only the edges that matter right now apply.
 *
 * When no dependency graph is configured, every call gets `dependsOn: []`
 * and the scheduler puts them all in one level, running fully in parallel.
 *
 * @example
 * Graph: `{ summarise: ["fetch"] }`
 * Calls: `[{ id: "c1", toolName: "fetch" }, { id: "c2", toolName: "summarise" }]`
 * Result: `[{ ...c1, dependsOn: [] }, { ...c2, dependsOn: ["c1"] }]`
 */
function resolveScheduledCalls(
  calls: readonly ToolCall[],
  graph: AgentConfig["toolDependencies"],
): ScheduledCall[] {
  if (graph === undefined || Object.keys(graph).length === 0) {
    return calls.map((c) => ({ ...c, dependsOn: [] }));
  }

  // Index calls by tool name so we can resolve name → id in O(1).
  // If the same tool appears multiple times in one turn, we map each call
  // to all calls of each of its declared dependency tools.
  const callsByToolName = new Map<string, string[]>();
  for (const call of calls) {
    const ids = callsByToolName.get(call.toolName) ?? [];
    ids.push(call.id);
    callsByToolName.set(call.toolName, ids);
  }

  return calls.map((call) => {
    const declaredDeps = graph[call.toolName];
    if (declaredDeps === undefined || declaredDeps.length === 0) {
      return { ...call, dependsOn: [] };
    }

    // Resolve each declared dependency tool name to its call ID(s) in this
    // turn. Deps on absent tools are dropped. Deps on multi-call tools
    // require all of them to complete (conservative - correct for all cases).
    const dependsOn: string[] = [];
    for (const depToolName of declaredDeps) {
      const depIds = callsByToolName.get(depToolName);
      if (depIds !== undefined) {
        dependsOn.push(...depIds);
      }
    }

    return { ...call, dependsOn };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Executes `tasks` with at most `limit` running concurrently.
 *
 * When `limit` is undefined or >= tasks.length, all tasks run simultaneously
 * (same behaviour as Promise.allSettled). When `limit` < tasks.length, tasks
 * are dispatched in order; a new task starts as soon as a running slot opens.
 *
 * Like Promise.allSettled, this never rejects - individual task rejections
 * are captured in the returned PromiseSettledResult array.
 */
async function allSettledConcurrent<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number | undefined,
): Promise<PromiseSettledResult<T>[]> {
  if (limit === undefined || limit >= tasks.length) {
    return Promise.allSettled(tasks.map((t) => t()));
  }

  // Pre-fill with a typed placeholder so the array element type is known.
  const results: PromiseSettledResult<T>[] = Array.from(
    { length: tasks.length },
    (): PromiseSettledResult<T> => ({ status: "rejected", reason: undefined }),
  );
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      // tasks[index] is always defined here: the while guard ensures
      // index < tasks.length, but noUncheckedIndexedAccess requires explicit
      // handling. We use a local variable and check for undefined defensively.
      const task = tasks[index];
      if (task === undefined) break;
      try {
        results[index] = { status: "fulfilled", value: await task() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  // Start `limit` concurrent workers; each drains from the shared nextIndex.
  await Promise.all(Array.from({ length: limit }, runNext));
  return results;
}

/**
 * Generates a unique run identifier backed by the OS CSPRNG.
 *
 * `randomUUID()` produces a v4 UUID with 122 bits of randomness - appropriate
 * for a correlation key that appears in logs and distributed traces.
 * The hyphens are stripped and the result is prefixed with `run_` for
 * readability in log output.
 */
function generateRunId(): string {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function accumulateUsage(acc: Mutable<TokenUsage>, usage: Anthropic.Usage): void {
  acc.inputTokens += usage.input_tokens;
  acc.outputTokens += usage.output_tokens;
  acc.totalTokens += usage.input_tokens + usage.output_tokens;
}

function snapshotUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function checkBudget(
  budget: AgentConfig["budget"],
  used: TokenUsage,
  iteration: number,
): BudgetExceededError | undefined {
  if (budget.maxTotalTokens !== undefined && used.totalTokens >= budget.maxTotalTokens) {
    return new BudgetExceededError("tokens", budget.maxTotalTokens, used.totalTokens);
  }
  if (budget.maxSteps !== undefined && iteration >= budget.maxSteps) {
    return new BudgetExceededError("steps", budget.maxSteps, iteration);
  }
  return undefined;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractToolUse(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
}

function buildAssistantMessage(
  text: string,
  toolUseBlocks: Anthropic.ToolUseBlock[],
): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const block of toolUseBlocks) content.push(block);
  return { role: "assistant", content };
}

function buildToolResultMessage(results: ToolResult[]): Anthropic.MessageParam {
  const content: Anthropic.ToolResultBlockParam[] = results.map((result) => {
    if (result.status === "success") {
      return {
        type: "tool_result",
        tool_use_id: result.callId,
        content: JSON.stringify(result.output),
      };
    }
    return {
      type: "tool_result",
      tool_use_id: result.callId,
      is_error: true,
      content: `Error [${result.error.code}]: ${result.error.message}`,
    };
  });

  return { role: "user", content };
}
