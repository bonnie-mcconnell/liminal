# Liminal

![CI](https://github.com/bonnie-mcconnell/liminal/actions/workflows/ci.yml/badge.svg)

Tool-use orchestration for the Anthropic API. 256 tests. Three runtime dependencies: the Anthropic SDK, Zod, and zod-to-json-schema.

```
Run run_4a9f2b1c8d3e  ·  3.42s  ·  2,841 tokens
├─ Step 1  381ms  ·  280 tokens  ·  3 calls (2 levels)
│  ├─ web_search("typescript strict mode benefits")  →  success  312ms  [parallel]
│  ├─ web_search("typescript adoption statistics")  →  success  298ms  [parallel]
│  └─ calculator("500 * 0.62 * 0.40")  →  cache hit  0ms
├─ Step 2  1,203ms  ·  180 tokens  ·  1 call
│  └─ file_reader("examples/context.md")  →  success  4ms
└─ Final answer  (487 tokens out)
```

The two web searches ran in parallel. The calculator hit the cache from an earlier call. Step 2 waited for step 1. None of this required configuration - it falls out of the scheduler and executor design.

## Why I built this

I was building an agent that made two web searches per turn - independent queries, no reason one had to wait for the other. But every implementation I looked at ran them sequentially, because the model issues tool calls in a list and the obvious thing to do is execute them one by one. On a task with three or four tool calls that were all independent, I was leaving two or three seconds of parallelism on the floor every single turn.

Fixing it properly meant the agent loop needed to know which calls were independent and which had data dependencies. Once I started thinking about that, I realised the loop was doing too many things: calling the model, managing execution order, handling retries, writing to cache. Those are separate problems and they don't belong tangled together.

So I separated them. The loop is now thin: call the model, hand tool calls to the scheduler, execute each level in parallel, feed results back. The scheduler (Kahn's algorithm), executor (timeout/retry/cache), and cache (SHA-256 content-addressed LRU) are separate components with their own interfaces and test suites.

The other thing that bothered me: most agent implementations let tool errors throw. One failed tool call crashes the whole run. The right behaviour is to return a typed error result to the model and let it decide what to do - try different parameters, use a different tool, or answer from what it already has. That's what `ToolExecutor` does. It never throws.

## How it works

```
Agent
  └─ for each iteration:
       ├─ check budget
       ├─ call Anthropic API
       ├─ if no tool calls → done
       ├─ resolveScheduledCalls: apply toolDependencies graph → ScheduledCall[]
       ├─ Scheduler (Kahn's): topological sort → execution levels
       ├─ for each level: Promise.allSettled(executor.execute(...))
       └─ feed results back to model

ToolExecutor (per call)
  ├─ check ResultCache (SHA-256 content-addressable key)
  ├─ validate input (Zod)
  ├─ Promise.race(execute(), timeout)
  ├─ retry with exponential backoff + jitter if shouldRetry(err)
  ├─ validate output (Zod)
  └─ write to ResultCache
```

**Scheduler** - Kahn's algorithm groups tool calls into execution levels. Everything in a level is independent and runs concurrently via `Promise.allSettled`. A failure in one call does not cancel the others. Cycles throw `CyclicDependencyError` immediately.

**ResultCache** - SHA-256 content-addressable: the cache key is a 64-bit digest of the canonicalised input, so `{a:1,b:2}` and `{b:2,a:1}` hit the same entry. Each tool gets its own LRU store so a busy tool can't evict another's results. The `Cache` interface lets you substitute a Redis backend for cross-process sharing.

**ToolExecutor** - the only place where timeouts, retries, and cache writes happen. Never throws. Every failure path returns a typed `ToolResult` with an error code the model can reason about.

## Design decisions worth explaining

**Why Kahn's over DFS topological sort?** Both work. I chose Kahn's because cycle detection falls out of it for free - any node with nonzero in-degree after the sweep is part of a cycle, so you don't need a separate visited-set check. With DFS you have to track that separately. For a tool with LLM-scale dependency graphs (realistically 2-10 nodes per turn) the difference doesn't matter for performance, but the cycle detection being implicit rather than bolted on felt cleaner.

**Why `Promise.allSettled` over `Promise.all`?** `Promise.all` short-circuits on the first rejection. A failure in one parallel tool call should not cancel the others - the model receives all results, including errors, and decides what to do next.

**Why SHA-256 over a faster hash?** Non-cryptographic hashes (djb2, FNV) can cluster on structured data like JSON. SHA-256's avalanche property guarantees a one-bit input difference produces an unrecognisably different digest. The 64-bit prefix gives a collision probability of ~2.7×10⁻⁸ for 10⁶ distinct inputs.

**Why canonical hashing?** `JSON.stringify({a:1,b:2})` and `JSON.stringify({b:2,a:1})` produce different strings. The same logical input would miss the cache. Sorting object keys recursively before hashing fixes this.

**Why a static `toolDependencies` graph rather than model-annotated dependencies?** The Anthropic API has no structured field for the model to express inter-tool dependencies. Parsing them from free text is fragile. Static declaration at the agent level is explicit, testable, and requires no prompt engineering.

**Why jitter on retries?** Without it, clients that all fail at the same moment retry at the same moment, hitting the recovering service with the same burst that caused the failure. Adding a random value in `[0, jitterMs]` breaks the synchrony.

**Why the `CachePolicy` discriminated union?** A `"no-cache"` policy has no `ttlMs` to configure. If `CachePolicy` were a flat object with an optional `strategy` field, accessing `ttlMs` on a no-cache policy would be a silent runtime surprise. As a discriminated union, it's a compile error. I reached for this specifically because I'd hit the flat-object version of this bug in an earlier project.

**Why TypeScript?** The Anthropic SDK types are generated from the API schema. When the schema changes, the compiler tells you exactly which call sites break before any code runs. The strict config - specifically `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` - also catches a class of indexing and optional-field bugs that default-strictness TypeScript quietly allows. The `CachePolicy` discriminated union is the clearest example of where that strictness paid off directly.

## What I'd do differently

The `toolDependencies` graph is declared statically on the agent, not per-call. That means if you want `summarise_results` to depend on `web_search`, you declare it globally and it applies every turn - even turns where `web_search` isn't called (which the resolver handles by ignoring absent dependencies). It works, but the right interface is probably per-invocation dependency hints from the model, which the Anthropic API doesn't yet expose in a structured way.

The `Cache` interface's `set()` takes `maxEntries` on every write, but the capacity is only applied on the first write per tool - subsequent writes with different values are silently ignored. This is documented in the interface but it's a footgun. A cleaner design would lock capacity at tool registration time through the registry.

I also didn't implement streaming. `ToolExecutor.execute` awaits the complete result before returning. The `ToolEvent` stream already delivers per-attempt progress; true streaming would require `execute` to return an `AsyncIterable<ToolEvent>` where `succeeded` is the terminal event.

## Installation

```bash
git clone https://github.com/bonnie-mcconnell/liminal.git
cd liminal
npm install
```

Node 20+ required.

**To run the demo** - no build step needed, `tsx` compiles on the fly:

```bash
npm run demo:dry    # inspect the task and tools - no API key required
npm run demo        # live run - requires ANTHROPIC_API_KEY
```

**To build the distributable:**

```bash
npm run build
```

## Quick start

```typescript
import { Agent, ToolRegistry, calculatorTool, webSearchTool } from "liminal";

const registry = new ToolRegistry().register(calculatorTool).register(webSearchTool);

const agent = new Agent(registry, {
  model: "claude-opus-4-6", // or "claude-sonnet-4-6" for lower cost
  budget: { maxTotalTokens: 10_000 },
});

const result = await agent.run(
  "Search for TypeScript adoption trends, then calculate: " +
    "if 40% of 500 engineers use TypeScript, how many is that?",
);

if (result.status === "success") {
  console.log(result.output);
}
```

> **Local development (before publishing):** import from `"./src/index.js"` instead.

## Tool dependencies

By default, all tool calls in a single model turn run concurrently. When one tool genuinely needs the output of another, declare it in `toolDependencies`:

```typescript
const agent = new Agent(registry, {
  model: "claude-opus-4-6",
  toolDependencies: {
    // summarise_results always runs after web_search completes
    summarise_results: ["web_search"],
    // analyse_data runs after both
    analyse_data: ["web_search", "summarise_results"],
  },
});
```

Dependencies on tools not called in a given turn are silently ignored - declare the full graph once and let it apply selectively. Cycles throw `CyclicDependencyError` immediately.

The execution plan is recorded on every `AgentStep` as `parallelLevels`:

```typescript
// result.trace.steps[0].parallelLevels
// → [["web_search"], ["summarise_results"], ["analyse_data"]]
```

## Live event stream

Every lifecycle transition emits a typed `ToolEvent`. Subscribe via `AgentOptions.onEvent`:

```typescript
const agent = new Agent(registry, config, {
  onEvent(event) {
    switch (event.type) {
      case "dispatched":
        console.log(`→ ${event.toolName} (attempt ${event.attempt})`);
        break;
      case "retrying":
        console.warn(`  ↻ retrying in ${event.delayMs}ms`);
        break;
      case "succeeded":
        metrics.histogram("tool.duration_ms", event.durationMs, { tool: event.toolName });
        break;
      case "failed":
        logger.error("tool failed", { tool: event.toolName, code: event.error.code });
        break;
    }
  },
});
```

The complete lifecycle per call:

```
dispatched → succeeded                                           # first attempt success
cache_hit                                                        # no dispatch
dispatched → attempt_failed → retrying → dispatched → succeeded # retry success
dispatched → attempt_failed → retrying → dispatched → attempt_failed → failed  # exhausted
failed                                                           # pre-dispatch (not found, invalid input)
```

## Custom tools

```typescript
import { z } from "zod";
import { ToolTimeoutError } from "liminal";
import type { ToolDefinition } from "liminal";

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description:
    "Returns current weather for a city. " +
    "Use when the task requires weather or temperature data.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Auckland' or 'London, UK'"),
    units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ city, units }) => fetchWeather(city, units),
  summarize: ({ city, units }) => `${city} (${units})`,
  policy: {
    timeoutMs: 10_000,
    retry: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      jitterMs: 200,
      shouldRetry: (err) => err instanceof ToolTimeoutError,
    },
    cache: { strategy: "content-hash", ttlMs: 5 * 60_000, vary: [], maxEntries: 256 },
  },
};
```

The `description` field is the model's only documentation for your tool. Be specific about what it does and when _not_ to use it.

## Sharing a cache across runs

```typescript
import { Agent, ToolRegistry, ResultCache, type Cache, calculatorTool } from "liminal";

const cache: Cache = new ResultCache();
const registry = new ToolRegistry().register(calculatorTool);

// Both agents deduplicate identical tool calls.
const agent1 = new Agent(registry, { model: "claude-opus-4-6" }, { cache });
const agent2 = new Agent(registry, { model: "claude-opus-4-6" }, { cache });

const stats = cache.stats("calculator");
console.log(`Hit rate: ${((stats?.hitRate ?? 0) * 100).toFixed(1)}%`);
```

## Error handling

```typescript
import { BudgetExceededError, MaxIterationsError } from "liminal";

const result = await agent.run(task);

if (result.status === "error") {
  if (result.error instanceof BudgetExceededError) {
    // result.error.budgetType → "tokens" | "steps"
    // result.error.limit, result.error.used
  } else if (result.error instanceof MaxIterationsError) {
    // Model is looping - check tool descriptions and prompt design
    // before raising the limit.
  }
  // result.trace is always present, even on failure.
  console.log(`${result.trace.steps.length} steps completed`);
}
```

## Observability

Every significant event is written as newline-delimited JSON:

```
{"ts":"...","level":"info","runId":"run_4a9f2b","event":"agent.started","data":{"model":"claude-opus-4-6"}}
{"ts":"...","level":"debug","runId":"run_4a9f2b","event":"tool.dispatched","data":{"callId":"c1","toolName":"web_search","attempt":1}}
{"ts":"...","level":"warn","runId":"run_4a9f2b","event":"tool.retrying","data":{"callId":"c1","attempt":2,"delayMs":623}}
{"ts":"...","level":"info","runId":"run_4a9f2b","event":"tool.succeeded","data":{"durationMs":780,"cacheHit":false}}
{"ts":"...","level":"info","runId":"run_4a9f2b","event":"agent.completed","data":{"totalTokens":2841,"steps":3}}
```

`LOG_LEVEL=debug` shows the execution plan, cache checks, and every dispatch. `LOG_LEVEL=warn` shows only retries and failures.

## Tests

256 tests across 14 files.

```bash
npm test               # unit + integration
npm run test:coverage  # with lcov report
```

The integration tests replace the Anthropic SDK with a deterministic mock - no credentials needed, fully reproducible. Covered failure modes: timeouts, input validation errors, retry exhaustion, dependency cycles, budget limits, partial parallel failures, `toolDependencies` sequencing.

## Production extension points

These are intentionally out of scope, with the extension point for each:

- **Distributed cache** - implement `Cache` against Redis using the same SHA-256 key scheme; inject via `AgentOptions.cache`. No changes to executor or agent.
- **Streaming** - `ToolExecutor.execute` currently awaits the complete result. True streaming would require `execute` to return `AsyncIterable<ToolEvent>` where `succeeded` is the terminal event.
- **Trace persistence** - `ExecutionTrace` is a plain serialisable object. Store by `runId` for run replay, A/B testing, and cost attribution.
- **Model-agnostic** - the Anthropic SDK is isolated in `Agent`. Replacing it requires changes in one file and one type import.

## Demo

```bash
export ANTHROPIC_API_KEY=sk-...
npm run demo        # runs a multi-step research task
npm run demo:dry    # prints the task and tools without calling the API

# Real web search (mock data used otherwise)
export BRAVE_SEARCH_API_KEY=BSA...
npm run demo
```

## Structure

```
src/
├── core/          agent, executor, registry, scheduler, cache, lru, defaults
├── errors/        typed error hierarchy (LiminalError subclasses)
├── tools/         calculator, web_search, file_reader
├── observability/ logger (NDJSON), trace renderer, EventEmitter
├── types/         ToolDefinition, AgentResult, ExecutionTrace, ToolEvent, policies
└── index.ts       public API - everything not exported here is an internal detail

tests/
├── unit/          one file per source module (13 suites)
└── integration/   full agent loop with deterministic mock Anthropic client
```
