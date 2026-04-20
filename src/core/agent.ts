import { randomBytes } from "node:crypto";
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
   * Cache backend. Defaults to a private `ResultCache`. Pass a shared instance
   * to deduplicate calls across agents or successive `run()` calls.
   * Any value satisfying the `Cache` interface works - including Redis.
   */
  cache?: Cache;
  /** Falls back to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string;
  /**
   * Called synchronously for every `ToolEvent` during a run. Narrow on
   * `event.type` to handle specific transitions. Must not throw - exceptions
   * are caught and logged. Not awaited - use `queueMicrotask` for async work.
   */
  onEvent?: (event: ToolEvent) => void;
}

/**
 * Drives the agent loop: calls the model, executes tool requests in dependency
 * order, feeds results back, repeats until the model produces a final response
 * or a configured limit is reached.
 *
 * Tool errors are returned to the model as structured `tool_result` messages
 * rather than aborting the run - the model sees the error code and can adjust
 * its plan. Only budget violations and the iteration ceiling cause a hard stop.
 */
export class Agent {
  private readonly client: Anthropic;
  private readonly config: AgentConfig;
  private readonly cache: Cache;
  private readonly events: EventEmitter<ToolEvent>;
  private runController: AbortController | undefined;

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

    // Pre-configure LRU capacity per tool so Cache.set() doesn't carry maxEntries on every write.
    for (const tool of this.registry) {
      const policy = this.registry.getPolicy(tool.name);
      if (policy?.cache.strategy === "content-hash") {
        this.cache.configure(tool.name, policy.cache.maxEntries);
      }
    }

    // maxConcurrency: 0 would create zero workers and hang - catch it early.
    if (this.config.maxConcurrency !== undefined && this.config.maxConcurrency < 1) {
      throw new RangeError(
        `maxConcurrency must be at least 1 (got ${String(this.config.maxConcurrency)})`,
      );
    }

    // Catch misspelled tool names in the dependency graph at construction time.
    // A typo ("summerise" vs "summarise") was previously silently dropped - no
    // error, no sequencing, mysterious runtime behaviour.
    if (this.config.toolDependencies !== undefined) {
      const registeredNames = new Set(this.registry.names());
      const unknown: string[] = [];
      for (const [toolName, deps] of Object.entries(this.config.toolDependencies)) {
        if (!registeredNames.has(toolName)) unknown.push(toolName);
        for (const dep of deps) {
          if (!registeredNames.has(dep)) unknown.push(dep);
        }
      }
      if (unknown.length > 0) {
        throw new Error(
          `toolDependencies references tool names not in the registry: ${[...new Set(unknown)].join(", ")}. ` +
            `Register all tools before constructing the Agent.`,
        );
      }
    }
  }

  /**
   * Stops the current run after the in-flight model call or tool turn settles.
   * The `run()` promise always resolves - never rejects.
   * Calling before `run()` pre-aborts the next run (returns immediately, no API calls).
   * Calling when idle is a no-op.
   */
  abort(): void {
    if (this.runController === undefined) {
      // Pre-abort: next run() will see the signal already fired and return immediately.
      this.runController = new AbortController();
    }
    this.runController.abort();
  }

  async run(task: string): Promise<AgentResult> {
    // Use any pre-aborted controller from abort()-before-run(), otherwise make a fresh one.
    if (this.runController === undefined || !this.runController.signal.aborted) {
      this.runController = new AbortController();
    }
    // Capture signal now - this run owns this reference even if runController is replaced later.
    const signal = this.runController.signal;

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
      // Check abort between iterations - after a tool turn settles, before the next API call.
      if (signal.aborted) {
        log.warn("agent.aborted", { iteration });
        hardError = new PlannerError("Run was aborted by caller");
        break;
      }

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

      // Map static dependency graph to the call IDs present this turn.
      const scheduled = resolveScheduledCalls(toolCalls, this.config.toolDependencies);

      let levels: readonly (readonly ScheduledCall[])[];
      try {
        levels = schedule(scheduled);
      } catch (err) {
        // CyclicDependencyError is a config bug - return a structured result
        // rather than letting it reject the run() promise.
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
          level.map((call) => () => executor.execute(call, signal)),
          this.config.maxConcurrency,
        );
        for (const result of settled) {
          if (result.status === "fulfilled") {
            toolResults.push(result.value);
          } else {
            // execute() never rejects by contract - this branch guards that invariant.
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

    // Clear the controller so future runs get a fresh signal.
    this.runController = undefined;

    if (finalOutput !== undefined) {
      return { status: "success", output: finalOutput, trace, usage: { ...totalUsage } };
    }

    // Loop exited via break - hardError is always set at that point.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { status: "error", error: hardError!, trace, usage: { ...totalUsage } };
  }
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Maps tool names in the static dependency graph to concrete call IDs for
 * this turn. Dependencies on tools not called this turn are silently dropped.
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

  // name → [id, ...] index; a tool may appear multiple times in one turn.
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

    // Map each declared dep tool name → its call IDs this turn. Absent tools skipped;
    // if a tool appears multiple times, all its calls must complete (conservative).
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

/** Promise.allSettled with an optional concurrency cap. Never rejects. */
async function allSettledConcurrent<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number | undefined,
): Promise<PromiseSettledResult<T>[]> {
  // limit < 1 is rejected at Agent construction; this guard is defence-in-depth.
  if (limit === undefined || limit < 1 || limit >= tasks.length) {
    return Promise.allSettled(tasks.map((t) => t()));
  }

  // Sentinel so TypeScript knows the element type. Any slot not overwritten
  // by runNext() produces a descriptive error rather than a silent undefined.
  const NEVER_WRITTEN: PromiseSettledResult<T> = {
    status: "rejected",
    reason: new Error("allSettledConcurrent: slot never written - bug in pool implementation"),
  };
  const results: PromiseSettledResult<T>[] = Array.from(
    { length: tasks.length },
    () => NEVER_WRITTEN,
  );
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      const task = tasks[index];
      if (task === undefined) break;
      try {
        results[index] = { status: "fulfilled", value: await task() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  // Cap workers at tasks.length - creating more would spin-exit immediately.
  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

/**
 * Generates a unique run identifier from the OS CSPRNG.
 * 8 random bytes → 16 hex chars. Birthday bound for N=10⁶ events in a 2⁶⁴
 * space: P ≈ N²/(2×2⁶⁴) ≈ 2.7×10⁻⁸ - negligible for any practical deployment.
 * (10⁻¹⁸ would require ~99 bits; 64 bits gives ~10⁻⁸.)
 */
function generateRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
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
