#!/usr/bin/env node
/**
 * Multi-step research agent that exercises every subsystem.
 *
 * Step 1: two web_search calls + calculator run in parallel.
 * Step 2: file_reader (depends on nothing, but the model typically calls it
 *         after seeing the search results).
 * Final:  the model synthesises everything into a summary.
 *
 * Usage:
 *   npx tsx examples/research-agent.ts
 *   npx tsx examples/research-agent.ts --dry-run   (no API key needed)
 *
 * ANTHROPIC_API_KEY  Required for live runs.
 * BRAVE_SEARCH_API_KEY  Optional - mock results used when absent.
 * LOG_LEVEL  debug | info (default) | warn | error
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
// Local development import - published consumers use: import { ... } from "liminal"
import {
  Agent,
  ToolRegistry,
  ResultCache,
  calculatorTool,
  webSearchTool,
  fileReaderTool,
  fetchTool,
  renderTrace,
} from "../src/index.js";

const TASK = `
You are a research assistant. Complete all of the following:

1. Search the web for "TypeScript strict mode benefits for large codebases".
2. Search the web for "TypeScript adoption statistics 2024".
3. Calculate: a 500-person engineering company has 62% developers, and 40%
   of those use TypeScript. How many TypeScript developers is that?
4. Read the file "examples/context.md" for additional background.
5. Fetch https://api.github.com/repos/microsoft/TypeScript and report the
   current star count.

Write a concise 3-paragraph summary covering:
  - What TypeScript strict mode is and its main benefits
  - Adoption trends from your search results and the GitHub star count
  - The calculated headcount, with working shown
`.trim();

const CONTEXT_FILE = join(process.cwd(), "examples", "context.md");

const CONTEXT_CONTENT = `
# Background

- TypeScript was released in 2012 by Microsoft.
- Strict mode arrived in TypeScript 2.3 (2017) via --strict.
- --strict enables: strictNullChecks, noImplicitAny, strictFunctionTypes,
  strictBindCallApply, strictPropertyInitialization, noImplicitThis, alwaysStrict.
- Large adopters include Google, Microsoft, Airbnb, and Slack.
`.trim();

const HR = "─".repeat(64);

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");

  const registry = new ToolRegistry()
    .register(webSearchTool)
    .register(calculatorTool)
    .register(fileReaderTool)
    .register(fetchTool);

  // --dry-run: print the task and registered tools without calling the API.
  // Works without any credentials - useful for inspecting the agent setup.
  if (isDryRun) {
    console.log("Dry run - no API calls.\n");
    console.log("Task:\n");
    console.log(
      TASK.split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );
    console.log("\nRegistered tools:");
    for (const name of registry.names()) {
      const tool = registry.get(name);
      const policy = registry.getPolicy(name);
      if (tool === undefined || policy === undefined) continue;
      const cacheStr =
        policy.cache.strategy === "content-hash"
          ? `content-hash TTL=${String(policy.cache.ttlMs / 1000)}s`
          : "no-cache";
      const retryStr =
        policy.retry.maxAttempts > 1
          ? `retry×${String(policy.retry.maxAttempts)} ${policy.retry.backoff}`
          : "no-retry";
      console.log(
        `  ${name}  (timeout=${String(policy.timeoutMs / 1000)}s  ${retryStr}  ${cacheStr})`,
      );
      console.log(`    ${tool.description.split(".")[0] ?? ""}.`);
    }
    return;
  }

  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error("ANTHROPIC_API_KEY is required. Set it in your environment or a .env file.");
    console.error("To explore without an API key, run: npm run demo:dry");
    process.exit(1);
  }

  await mkdir(join(process.cwd(), "examples"), { recursive: true });
  await writeFile(CONTEXT_FILE, CONTEXT_CONTENT, "utf-8");

  // A shared cache means repeated runs within the same session reuse results.
  const cache = new ResultCache();

  const agent = new Agent(
    registry,
    {
      model: "claude-opus-4-6",
      maxIterations: 10,
      systemPrompt:
        "You are a precise research assistant. Use tools before answering. " +
        "Prefer specific search queries. Always show calculations.",
      budget: { maxTotalTokens: 20_000, maxSteps: 8 },
    },
    {
      cache,
      onEvent(event) {
        // Emit a live progress line for dispatches and retries so the terminal
        // shows activity during long tool calls, without duplicating the final
        // trace output that renderTrace already provides.
        if (event.type === "dispatched" && event.attempt === 1) {
          process.stderr.write(`  → ${event.toolName}\n`);
        }
        if (event.type === "retrying") {
          process.stderr.write(
            `  ↻ ${event.toolName} retry ${String(event.attempt)} in ${String(event.delayMs)}ms\n`,
          );
        }
      },
    },
  );

  console.log(HR);
  console.log(
    TASK.split("\n")
      .map((l) => "  " + l)
      .join("\n"),
  );
  console.log(HR + "\n");

  const start = Date.now();
  const result = await agent.run(TASK);

  console.log("\n" + HR);
  console.log(renderTrace(result.trace));

  console.log("\n" + HR + "\n");

  if (result.status === "success") {
    console.log(result.output);
    console.log(
      `\n${((Date.now() - start) / 1000).toFixed(2)}s  ·  ` +
        `${result.usage.totalTokens.toLocaleString()} tokens  ·  ` +
        `${String(result.trace.steps.length)} steps`,
    );
  } else {
    console.error(`Error [${result.error.code}]: ${result.error.message}`);
    if (result.error.cause instanceof Error) {
      console.error(`  ${result.error.cause.message}`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
