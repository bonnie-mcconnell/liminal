import type { ZodTypeAny, infer as ZodInfer } from "zod";
import type { AnyToolError } from "../errors/index.js";

export interface RetryPolicy {
  /** Total attempts including the first. Default: 3. */
  readonly maxAttempts: number;
  readonly backoff: "exponential" | "linear" | "none";
  /**
   * Base delay in ms.
   * Exponential: baseDelayMs × 2^(attempt−1), capped at maxDelayMs, plus jitter.
   * Linear:      baseDelayMs × attempt, same cap and jitter.
   */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Random value in [0, jitterMs] added to each delay to desynchronise retries. */
  readonly jitterMs: number;
  /** Return true if this error warrants another attempt. See defaults.ts for the default. */
  readonly shouldRetry: (error: unknown, attempt: number) => boolean;
}

/**
 * Discriminated union - the `strategy` field determines which other fields
 * are meaningful. This is intentional: accessing `ttlMs` on a `"no-cache"`
 * policy is a type error, not a runtime surprise.
 *
 * `"content-hash"` - results are keyed by a SHA-256 digest of the
 * canonicalised input, so `{a:1,b:2}` and `{b:2,a:1}` share an entry.
 * Use `vary` to partition the keyspace by external context (e.g. user ID).
 *
 * `"no-cache"` - every call dispatches. Use for tools with side effects or
 * inputs that carry ambient state not visible in their arguments.
 */
export type CachePolicy =
  | {
      readonly strategy: "content-hash";
      /** Entry lifetime. After this duration the entry is lazily expired on next access. */
      readonly ttlMs: number;
      /**
       * Extra strings mixed into the cache key. Use to partition the cache by
       * context - e.g. `vary: ["userId:42"]` gives each user their own entries.
       * Values are sorted before hashing so order doesn't matter.
       */
      readonly vary: readonly string[];
      /**
       * Maximum number of entries in the per-tool LRU store before the least
       * recently used entry is evicted. Capacity is fixed at the first write;
       * register tools before the first agent run.
       */
      readonly maxEntries: number;
    }
  | {
      readonly strategy: "no-cache";
    };

export interface ToolPolicy {
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly cache: CachePolicy;
}

/**
 * Everything the engine needs to call a tool and validate its inputs and outputs.
 *
 * @example
 * ```ts
 * const calculatorTool: ToolDefinition = {
 *   name: "calculator",
 *   description: "Evaluates a math expression. Use for arithmetic, not string ops.",
 *   inputSchema: z.object({ expression: z.string() }),
 *   outputSchema: z.object({ result: z.number() }),
 *   execute: async ({ expression }) => ({ result: evaluate(expression) }),
 *   summarize: ({ expression }) => expression,
 * };
 * ```
 */
export interface ToolDefinition<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  /**
   * Runs the tool and returns its output.
   *
   * The optional `signal` supports cooperative cancellation. When provided,
   * tools should forward it to any underlying async operations (fetch, fs
   * calls, etc.) so the work actually stops rather than running to completion
   * in the background after a timeout or abort fires. Tools that ignore the
   * signal still work correctly - the executor races it externally via
   * `Promise.race` - but they continue consuming resources until they settle.
   */
  readonly execute: (input: ZodInfer<TInput>, signal?: AbortSignal) => Promise<ZodInfer<TOutput>>;
  /**
   * Returns a short, human-readable label for a validated input value.
   * Used by `renderTrace` to annotate tool calls in the execution tree.
   *
   * If omitted, the renderer falls back to a priority-ordered heuristic:
   * it tries the fields `query`, `expression`, `path`, `url`, `id`, `name`
   * before falling back to the first string field in the object. Provide
   * `summarize` explicitly when your tool's primary identifier doesn't
   * appear under one of those names, or when combining multiple fields
   * produces a more useful label.
   */
  readonly summarize?: (input: ZodInfer<TInput>) => string;
  /** Partial overrides merged with the registry defaults at registration time. */
  readonly policy?: Partial<ToolPolicy>;
}

export interface ToolCall {
  /** Opaque ID assigned by the model, used to correlate results. */
  readonly id: string;
  readonly toolName: string;
  readonly rawInput: unknown;
}

export interface ScheduledCall extends ToolCall {
  /**
   * IDs of other calls in the same scheduling batch that must complete before
   * this one starts.
   *
   * The agent populates this from `AgentConfig.toolDependencies` by resolving
   * tool names to the call IDs present in the current turn. The scheduler
   * (Kahn's algorithm) then groups calls into execution levels: everything in
   * a level is independent and runs concurrently; a level only starts after
   * every call in the previous level has settled.
   *
   * An empty array means the call can start immediately.
   */
  readonly dependsOn: readonly string[];
}

export type ToolResult =
  | {
      readonly status: "success";
      readonly callId: string;
      readonly toolName: string;
      readonly output: unknown;
      readonly durationMs: number;
      readonly attempts: number;
      readonly cacheHit: boolean;
    }
  | {
      readonly status: "error";
      readonly callId: string;
      readonly toolName: string;
      readonly error: AnyToolError;
      readonly attempts: number;
    };
