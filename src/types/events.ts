import type { AnyToolError } from "../errors/index.js";

/**
 * Typed events emitted by `ToolExecutor` during the lifecycle of a single
 * tool call. Consumers subscribe via `AgentOptions.onEvent`.
 *
 * Every event carries `callId`, `toolName`, and `ts` (ISO timestamp) so
 * individual events are self-describing and can be correlated without
 * maintaining external state.
 *
 * **Lifecycle for a successful cached call:**
 * ```
 * cache_hit
 * ```
 *
 * **Lifecycle for a successful call on the first attempt:**
 * ```
 * dispatched → succeeded
 * ```
 *
 * **Lifecycle for a call that succeeds after retries:**
 * ```
 * dispatched → attempt_failed → retrying → dispatched → succeeded
 * ```
 *
 * **Lifecycle for a call that ultimately fails:**
 * ```
 * dispatched → attempt_failed → retrying → dispatched → attempt_failed → failed
 * ```
 *
 * **Lifecycle for a call rejected before dispatch (validation / not found):**
 * ```
 * failed
 * ```
 */
export type ToolEvent =
  | {
      /**
       * The tool call was found in the cache. No dispatch will occur.
       * `output` is the cached value.
       */
      readonly type: "cache_hit";
      readonly callId: string;
      readonly toolName: string;
      readonly ts: string;
      readonly output: unknown;
    }
  | {
      /**
       * The tool function has been invoked. This fires immediately before
       * the `execute` promise is awaited - `attempt` is 1-indexed.
       */
      readonly type: "dispatched";
      readonly callId: string;
      readonly toolName: string;
      readonly ts: string;
      readonly attempt: number;
    }
  | {
      /**
       * One attempt failed but the retry policy permits another attempt.
       * The next event will be `retrying`, then `dispatched`.
       */
      readonly type: "attempt_failed";
      readonly callId: string;
      readonly toolName: string;
      readonly ts: string;
      readonly attempt: number;
      readonly error: unknown;
    }
  | {
      /**
       * The executor is waiting before the next attempt.
       * `delayMs` is the computed delay (backoff + jitter).
       */
      readonly type: "retrying";
      readonly callId: string;
      readonly toolName: string;
      readonly ts: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | {
      /**
       * The tool call completed successfully. `durationMs` measures only
       * the winning attempt, not the total time including retries.
       * `attempts` is the total number of calls made (1 on first success).
       */
      readonly type: "succeeded";
      readonly callId: string;
      readonly toolName: string;
      readonly ts: string;
      readonly output: unknown;
      readonly durationMs: number;
      readonly attempts: number;
    }
  | {
      /**
       * The tool call failed permanently. This fires exactly once per call,
       * whether the failure was immediate (validation, not found) or after
       * all retry attempts were exhausted.
       *
       * `attempts` is 0 for pre-dispatch failures (not found, invalid input)
       * and ≥ 1 for execution failures.
       */
      readonly type: "failed";
      readonly callId: string;
      readonly toolName: string;
      readonly ts: string;
      readonly error: AnyToolError;
      readonly attempts: number;
    };

/** Narrows a `ToolEvent` to a specific type. */
export type ToolEventOfType<T extends ToolEvent["type"]> = Extract<ToolEvent, { type: T }>;
