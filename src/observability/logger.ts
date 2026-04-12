/**
 * Structured logger that writes newline-delimited JSON to stdout.
 *
 * Each line is a self-contained JSON object, which log aggregators
 * (Datadog, CloudWatch, Splunk) ingest without configuration.
 * The logger is scoped to a run ID so every event from a single run
 * can be correlated without threading context through every call.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

interface LogEvent {
  readonly ts: string;
  readonly level: LogLevel;
  readonly runId: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function minLevel(): LogLevel {
  // Read per-emit so callers can change LOG_LEVEL without reloading the module.
  return (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info";
}

function emit(record: LogEvent): void {
  if (LEVELS[record.level] < LEVELS[minLevel()]) return;
  process.stdout.write(JSON.stringify(record) + "\n");
}

/**
 * @example
 * ```ts
 * const log = createLogger("run_abc123");
 * log.info("agent.started", { model: "claude-opus-4-6" });
 * ```
 */
export function createLogger(runId: string, context: Record<string, unknown> = {}): Logger {
  function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    emit({ ts: new Date().toISOString(), level, runId, event, data: { ...context, ...data } });
  }

  return {
    debug: (event, data) => {
      log("debug", event, data);
    },
    info: (event, data) => {
      log("info", event, data);
    },
    warn: (event, data) => {
      log("warn", event, data);
    },
    error: (event, data) => {
      log("error", event, data);
    },
    child: (extra) => createLogger(runId, { ...context, ...extra }),
  };
}
