#!/usr/bin/env node
/**
 * Benchmarks parallel tool execution against sequential execution.
 *
 * This measures the core claim of the library: independent tool calls that
 * would normally execute sequentially can be parallelised within a single
 * model turn because they share no data dependencies.
 *
 * Uses controlled artificial delay tools so results are deterministic and
 * the numbers reflect scheduling overhead, not network jitter. Real-world
 * tools (web search, fetch) produce larger absolute gains.
 *
 * Usage:
 *   npm run bench
 *   npx tsx benchmarks/parallel-vs-sequential.ts --calls 4 --delay 300
 *
 * Options:
 *   --calls N    Number of independent tool calls to simulate (default: 3)
 *   --delay N    Artificial delay per tool call in ms (default: 200)
 *   --runs  N    Number of timing samples per configuration (default: 5)
 */

import { z } from "zod";
import { ToolRegistry, ResultCache } from "../src/index.js";
import { ToolExecutor } from "../src/core/executor.js";
import { schedule } from "../src/core/scheduler.js";
import { createLogger } from "../src/observability/logger.js";
import type { ToolDefinition, ScheduledCall } from "../src/types/index.js";

function parseArg(flag: string, defaultVal: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return defaultVal;
  const raw = process.argv[idx + 1];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return isNaN(parsed) ? defaultVal : parsed;
}

const CALL_COUNT = parseArg("--calls", 3);
const DELAY_MS = parseArg("--delay", 200);
const RUNS = parseArg("--runs", 5);

function makeDelayTool(name: string, delayMs: number): ToolDefinition {
  return {
    name,
    description: `Simulates ${String(delayMs)}ms of work. Benchmark only.`,
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ id: z.string(), durationMs: z.number() }),
    execute: async ({ id }: { id: string }) => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { id, durationMs: Date.now() - start };
    },
    summarize: ({ id }: { id: string }) => id,
    policy: {
      timeoutMs: delayMs * 10,
      retry: {
        maxAttempts: 1,
        backoff: "none",
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        shouldRetry: () => false,
      },
      cache: { strategy: "no-cache" },
    },
  };
}

async function runSequential(executor: ToolExecutor, calls: ScheduledCall[]): Promise<number> {
  const start = Date.now();
  for (const call of calls) await executor.execute(call);
  return Date.now() - start;
}

async function runParallel(executor: ToolExecutor, calls: ScheduledCall[]): Promise<number> {
  const start = Date.now();
  const levels = schedule(calls);
  for (const level of levels) {
    await Promise.allSettled(level.map((call) => executor.execute(call)));
  }
  return Date.now() - start;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length);
}
function fmt(n: number): string {
  return `${n.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const HR = "─".repeat(60);
  console.log("\n" + HR);
  console.log("  liminal - parallel vs sequential benchmark");
  console.log(HR);
  console.log(`  ${String(CALL_COUNT)} tool calls × ${String(DELAY_MS)}ms delay each`);
  console.log(`  ${String(RUNS)} runs per configuration\n`);

  const registry = new ToolRegistry();
  const tools: ToolDefinition[] = [];
  for (let i = 0; i < CALL_COUNT; i++) {
    const tool = makeDelayTool(`delay_tool_${String(i)}`, DELAY_MS);
    registry.register(tool);
    tools.push(tool);
  }

  // Suppress NDJSON logs during timing - logger reads LOG_LEVEL on every emit
  const savedLogLevel = process.env["LOG_LEVEL"];
  process.env["LOG_LEVEL"] = "error";

  const executor = new ToolExecutor(registry, new ResultCache(), createLogger("bench"));

  const calls: ScheduledCall[] = tools.map((tool, i) => ({
    id: `call_${String(i)}`,
    toolName: tool.name,
    rawInput: { id: `call_${String(i)}` },
    dependsOn: [],
  }));

  // Warm-up round - excluded from timing to avoid JIT noise
  await runSequential(executor, calls);
  await runParallel(executor, calls);

  const seqSamples: number[] = [];
  for (let r = 0; r < RUNS; r++) seqSamples.push(await runSequential(executor, calls));

  const parSamples: number[] = [];
  for (let r = 0; r < RUNS; r++) parSamples.push(await runParallel(executor, calls));

  // Restore log level
  if (savedLogLevel !== undefined) process.env["LOG_LEVEL"] = savedLogLevel;
  else delete process.env["LOG_LEVEL"];

  const seqMean = mean(seqSamples);
  const parMean = mean(parSamples);
  const speedup = seqMean / parMean;
  const theoreticalSpeedup = CALL_COUNT;

  console.log("  Strategy      Mean        Stddev      Samples");
  console.log("  " + "─".repeat(56));
  console.log(
    `  Sequential    ${fmt(seqMean).padEnd(12)}${fmt(stddev(seqSamples)).padEnd(12)}${seqSamples.map(fmt).join("  ")}`,
  );
  console.log(
    `  Parallel      ${fmt(parMean).padEnd(12)}${fmt(stddev(parSamples)).padEnd(12)}${parSamples.map(fmt).join("  ")}`,
  );

  console.log("\n  Results");
  console.log("  " + "─".repeat(56));
  console.log(`  Speedup:              ${speedup.toFixed(2)}×`);
  console.log(`  Theoretical maximum:  ${theoreticalSpeedup.toFixed(2)}×`);
  console.log(
    `  Efficiency:           ${((speedup / theoreticalSpeedup) * 100).toFixed(1)}% of theoretical`,
  );
  console.log(
    `  Time saved per turn:  ~${fmt(seqMean - parMean)} on a ${String(CALL_COUNT)}-call turn`,
  );

  console.log("\n  Interpretation");
  console.log("  " + "─".repeat(56));
  if (speedup >= theoreticalSpeedup * 0.9) {
    console.log(`  Near-perfect parallelism. Scheduling overhead < ${fmt(parMean - DELAY_MS)}.`);
  } else if (speedup >= theoreticalSpeedup * 0.7) {
    console.log(`  Good parallelism. Overhead ≈ ${fmt(parMean - DELAY_MS)} per turn.`);
  } else {
    console.log(
      `  Overhead visible at this delay. Try --delay ${String(DELAY_MS * 5)} for cleaner signal.`,
    );
  }

  const agentTurns = 5;
  console.log(
    `  Over a ${String(agentTurns)}-turn agent run: ~${fmt((seqMean - parMean) * agentTurns)} saved vs sequential.`,
  );
  console.log("\n" + HR + "\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
