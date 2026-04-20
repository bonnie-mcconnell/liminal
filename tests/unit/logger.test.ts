import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../src/observability/logger.js";

function captureOutput(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  fn();
  spy.mockRestore();
  return lines;
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("createLogger", () => {
  beforeEach(() => {
    delete process.env["LOG_LEVEL"];
  });
  afterEach(() => {
    delete process.env["LOG_LEVEL"];
    vi.restoreAllMocks();
  });

  describe("output format", () => {
    it("emits valid JSON", () => {
      const lines = captureOutput(() => createLogger("run_001").info("test.event"));
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
    });

    it("includes ts, level, runId, event, and data", () => {
      const lines = captureOutput(() =>
        createLogger("run_001").info("agent.started", { model: "claude" }),
      );
      const [record] = parseLines(lines);
      expect(record!).toMatchObject({
        level: "info",
        runId: "run_001",
        event: "agent.started",
        data: { model: "claude" },
      });
      expect(() => new Date(record!["ts"] as string)).not.toThrow();
    });

    it("emits one line per call", () => {
      const log = createLogger("run_001");
      const lines = captureOutput(() => {
        log.info("a");
        log.warn("b");
        log.error("c");
      });
      expect(lines).toHaveLength(3);
    });
  });

  describe("level filtering", () => {
    it("suppresses debug at the default info level", () => {
      expect(captureOutput(() => createLogger("r").debug("hidden"))).toHaveLength(0);
    });

    it("emits debug when LOG_LEVEL=debug", () => {
      process.env["LOG_LEVEL"] = "debug";
      expect(captureOutput(() => createLogger("r").debug("visible"))).toHaveLength(1);
    });

    it("suppresses info and warn when LOG_LEVEL=error", () => {
      process.env["LOG_LEVEL"] = "error";
      const log = createLogger("r");
      const lines = captureOutput(() => {
        log.info("hidden");
        log.warn("hidden");
        log.error("visible");
      });
      expect(lines).toHaveLength(1);
      expect(parseLines(lines)[0]!["level"]).toBe("error");
    });

    it("respects LOG_LEVEL changes after logger creation", () => {
      const log = createLogger("r");
      expect(captureOutput(() => log.debug("before"))).toHaveLength(0);
      process.env["LOG_LEVEL"] = "debug";
      expect(captureOutput(() => log.debug("after"))).toHaveLength(1);
    });
  });

  describe("context and data", () => {
    it("emits empty data when none is passed", () => {
      const [record] = parseLines(captureOutput(() => createLogger("r").info("e")));
      expect(record!["data"]).toEqual({});
    });

    it("merges creation-time context into every record", () => {
      const lines = captureOutput(() =>
        createLogger("r", { component: "executor" }).info("e", { toolName: "calc" }),
      );
      const data = parseLines(lines)[0]!["data"] as Record<string, unknown>;
      expect(data["component"]).toBe("executor");
      expect(data["toolName"]).toBe("calc");
    });

    it("call-time data overrides context on collision", () => {
      const lines = captureOutput(() =>
        createLogger("r", { source: "ctx" }).info("e", { source: "call" }),
      );
      expect((parseLines(lines)[0]!["data"] as Record<string, unknown>)["source"]).toBe("call");
    });
  });

  describe("child logger", () => {
    it("inherits the parent runId", () => {
      const lines = captureOutput(() => createLogger("run_parent").child({ step: 1 }).info("e"));
      expect(parseLines(lines)[0]!["runId"]).toBe("run_parent");
    });

    it("merges parent and child context", () => {
      const child = createLogger("r", { component: "agent" }).child({ iteration: 3 });
      const data = parseLines(captureOutput(() => child.info("e")))[0]!["data"] as Record<
        string,
        unknown
      >;
      expect(data["component"]).toBe("agent");
      expect(data["iteration"]).toBe(3);
    });

    it("does not write child context into the parent", () => {
      const parent = createLogger("r");
      parent.child({ childOnly: true });
      const data = parseLines(captureOutput(() => parent.info("e")))[0]!["data"] as Record<
        string,
        unknown
      >;
      expect(data["childOnly"]).toBeUndefined();
    });
  });

  describe("LOG_LEVEL validation", () => {
    it("defaults to info when LOG_LEVEL is not set", () => {
      delete process.env["LOG_LEVEL"];
      const log = createLogger("run_x");
      const debugLines = captureOutput(() => log.debug("debug.event"));
      const infoLines = captureOutput(() => log.info("info.event"));
      expect(debugLines).toHaveLength(0); // debug suppressed at info level
      expect(infoLines).toHaveLength(1); // info passes through
    });

    it("suppresses all levels when LOG_LEVEL=error", () => {
      process.env["LOG_LEVEL"] = "error";
      const log = createLogger("run_x");
      expect(captureOutput(() => log.debug("d"))).toHaveLength(0);
      expect(captureOutput(() => log.info("i"))).toHaveLength(0);
      expect(captureOutput(() => log.warn("w"))).toHaveLength(0);
      expect(captureOutput(() => log.error("e"))).toHaveLength(1);
    });

    it("falls back to info (not all-logging) when LOG_LEVEL is an unknown value", () => {
      // Previously, an unknown level like "verbose" produced LEVELS["verbose"] = undefined,
      // and undefined < N is false in JavaScript, so ALL messages were logged.
      // Now we validate and fall back to "info".
      process.env["LOG_LEVEL"] = "verbose";
      const log = createLogger("run_x");
      const debugLines = captureOutput(() => log.debug("debug.event"));
      const infoLines = captureOutput(() => log.info("info.event"));
      expect(debugLines).toHaveLength(0); // debug suppressed — not all-logging
      expect(infoLines).toHaveLength(1); // info passes through (info fallback)
    });
  });
});
