# Liminal

![CI](https://github.com/bonnie-mcconnell/liminal/actions/workflows/ci.yml/badge.svg)

A TypeScript library that manages the tool-use loop in LLM agents: runs independent calls in parallel, sequences dependent ones via a DAG, retries failures with backoff, caches results by content hash, and keeps tool errors from crashing the run. 322 tests. Three runtime dependencies.

```
Run run_4a9f2b1c8d3e  ·  2.01s  ·  3,204 tokens
├─ Step 1  201ms  ·  280 tokens  ·  3 calls (1 level)
│  ├─ web_search("typescript strict mode benefits")  →  success  198ms  [parallel]
│  ├─ web_search("typescript adoption statistics")   →  success  201ms  [parallel]
│  └─ calculator("500 * 0.62 * 0.40")               →  cache hit  0ms   [parallel]
├─ Step 2  1,203ms  ·  180 tokens  ·  2 calls (1 level)
│  ├─ file_reader("examples/context.md")             →  success  4ms    [parallel]
│  └─ fetch("GET https://api.github.com/...\")        →  success  891ms  [parallel]
└─ Final answer  (487 tokens out)
```

Both web searches and the calculator ran simultaneously in step 1. The file read and HTTP fetch ran simultaneously in step 2. None of this required extra configuration - it falls out of the scheduler and executor design.

## Why I built this

I was building an agent that made two web searches per turn - independent queries, no reason one had to wait for the other. Every implementation I found ran them sequentially, because the model issues tool calls as a list and the obvious thing is to execute them one by one. On a turn with three independent 200ms calls, that's 600ms. The three calls should take 200ms.

Fixing it properly meant the agent loop needed to know which calls were independent and which had real data dependencies. Once I started thinking about that, the loop was also obviously doing too many other things: calling the model, managing execution order, handling retries, writing to cache. Those are separate problems and they don't belong tangled together.

So I pulled them apart. The scheduler (Kahn's algorithm) groups calls into execution levels. The executor handles timeout, retry, and cache per-call. The loop just calls the model, hands tool calls to the scheduler, runs each level via `Promise.allSettled`, and feeds results back.

The other thing that bothered me: most agent implementations let tool errors throw. One failed tool call crashes the entire run. The right behaviour is to return a typed error result to the model and let it decide - try different parameters, use a different tool, or answer from what it already has. The executor never throws.

## Measured performance

```
$ npm run bench

────────────────────────────────────────────────────────────
  liminal - parallel vs sequential benchmark
────────────────────────────────────────────────────────────
  3 tool calls × 200ms delay each
  5 runs per configuration

  Strategy      Mean        Stddev      Samples
  ────────────────────────────────────────────────────────
  Sequential    602ms       1ms         602ms  604ms  603ms  601ms  602ms
  Parallel      201ms       0ms         201ms  201ms  201ms  202ms  201ms

  Speedup:              2.99×
  Theoretical maximum:  3.00×
  Efficiency:           99.8% of theoretical
```

Scheduling overhead is sub-millisecond.

## How it works

```
Agent
  └─ for each iteration:
       ├─ check abort signal
       ├─ check budget (tokens, steps)
       ├─ call Anthropic API
       ├─ if no tool calls → done
       ├─ resolveScheduledCalls: apply toolDependencies graph → ScheduledCall[]
       ├─ Scheduler (Kahn's): topological sort → execution levels
       ├─ for each level: Promise.allSettled(executor.execute(call, signal))
       └─ feed results back to model

ToolExecutor (per call)
  ├─ check AbortSignal
  ├─ check ResultCache (SHA-256 content-addressable key)
  ├─ validate input (Zod)
  ├─ Promise.race(execute(), timeout, abortSignal)
  ├─ retry with exponential backoff + jitter
  ├─ validate output (Zod)
  └─ write to ResultCache
```

**Scheduler** - Kahn's algorithm groups calls into levels. Everything in a level runs via `Promise.allSettled` - not `Promise.all`, because a failure in one call shouldn't cancel its siblings. Cycles in the dependency graph throw `CyclicDependencyError` at scheduling time rather than producing mysterious ordering at runtime.

**ResultCache** - SHA-256 content-addressable: `{a:1,b:2}` and `{b:2,a:1}` hit the same entry because object keys are canonicalised (sorted recursively) before hashing. Each tool gets its own LRU store so a high-traffic tool can't evict results belonging to others. Inject a shared instance across agents to deduplicate calls across runs.

**ToolExecutor** - never throws. Every failure path - not found, bad input, timeout, execution error, retry exhaustion - returns a typed `ToolResult` with a machine-readable error code. The model sees the error and can reason about it: retry with different parameters, fall back to a different tool, or answer from what it already has.

## Design decisions

**Kahn's over DFS for topological sort.** Both give a valid ordering. Kahn's cycle detection is implicit - any node with nonzero in-degree after the sweep is in a cycle. With DFS you add a separate visited-set check. The cycle detection falling out of the algorithm for free felt cleaner than bolting it on.

**SHA-256 over a faster hash.** Non-cryptographic hashes (djb2, FNV) cluster on structured data like JSON - a one-character difference in a key might produce a very similar digest. SHA-256's avalanche property guarantees a one-bit input difference produces an unrecognisable digest. The 64-bit prefix gives a collision probability of ~2.7×10⁻⁸ for 10⁶ distinct inputs, which is fine for tool-call caching.

**Canonical input serialisation.** `JSON.stringify({a:1,b:2})` and `JSON.stringify({b:2,a:1})` produce different strings. The same logical input would miss the cache. Sorting object keys recursively before hashing fixes this without changing the data.

**Static `toolDependencies` graph.** The Anthropic API has no structured field for the model to express inter-tool dependencies. Parsing them from free text is fragile and I didn't want to commit to a prompt format. Static declaration at the agent level is explicit and testable.

**`CachePolicy` as a discriminated union.** A `"no-cache"` policy has no `ttlMs` to configure. If `CachePolicy` were a flat object with an optional strategy field, accessing `ttlMs` on a no-cache policy would be a silent runtime bug. As a discriminated union, it's a compile error.

**Cache capacity configured at construction, not per write.** Early versions of the cache took `maxEntries` on every `set()` call. That's a leaky interface - any Redis backend would have to accept a parameter it can't use. Moved to `configure()` called once per tool at agent construction, so writes are just writes.

**Jitter on retries.** Without it, clients that all fail at t=0 retry at t+delay, hitting the recovering service with the same burst. Adding `[0, jitterMs]` of randomness breaks the synchrony.

**`toolDependencies` validated at construction time.** A misspelled tool name (`"summerise"` vs `"summarise"`) was previously silently dropped - no error, no sequencing, mysterious ordering at runtime. Validating against the registry at construction time names the offending tool immediately.

## What I'd do differently

The `toolDependencies` graph is declared statically on the agent, not per-call. If you want `summarise_results` to depend on `web_search`, you declare it globally - it applies every turn, even turns where `web_search` isn't called (which the resolver handles by ignoring absent dependencies). The right interface is probably per-invocation dependency hints from the model, but the Anthropic API doesn't expose that in a structured way yet. This isn't just a waiting-for-the-API situation - it reflects a real design constraint: static declaration is explicit and testable, but it prevents context-dependent sequencing that a smarter graph would support.

The cache key uses the first 16 hex chars (64 bits) of the SHA-256 digest. 64 bits gives P(collision) ≈ 2.7×10⁻⁸ at 10⁶ distinct inputs - fine for tool-call caching where a false positive serves stale data rather than causing corruption. But the truncation is a choice with a real tradeoff: the full 64-char digest would eliminate collision risk entirely at the cost of a larger key footprint per entry. For a distributed Redis cache processing millions of calls per day, the full digest is the right call. I'd make this configurable at `ResultCache` construction time.

For tools that implement cooperative cancellation (accepting `signal?: AbortSignal` in their `execute` function), in-flight work stops immediately when a timeout or abort fires - no background resource consumption, no duplicate side effects on retry. The built-in tools all do this: `fetchTool` and `webSearchTool` forward the signal to `fetch()`, and `fileReaderTool` checks it at each I/O boundary. Custom tools that ignore the signal still work correctly via the external `Promise.race`, but their timed-out execution continues in the background until it settles.

## Installation

```bash
npm install @bonnie-mcconnell/liminal
```

Node 20+ required.

**To run the demo:**

```bash
npm run demo:dry    # inspect the task and tools without an API key
npm run demo        # live run - requires ANTHROPIC_API_KEY
npm run bench       # measure parallel vs sequential performance
```

## Quick start

```typescript
import { Agent, ToolRegistry, calculatorTool, webSearchTool, renderTrace } from "@bonnie-mcconnell/liminal";

const registry = new ToolRegistry().register(calculatorTool).register(webSearchTool);

const agent = new Agent(registry, {
  model: "claude-haiku-4-5-20251001", // use opus-4-6 for harder tasks
  budget: { maxTotalTokens: 10_000 },
});

const result = await agent.run(
  "Search for TypeScript adoption trends, then calculate: " +
    "if 40% of 500 engineers use TypeScript, how many is that?",
);

if (result.status === "success") {
  console.log(result.output);
  console.log(renderTrace(result.trace));
}
```

## Built-in tools

| Tool | What it does | Caching |
|---|---|---|
| `calculatorTool` | Evaluates math expressions via a recursive-descent parser - no `eval()` | Content-hash, 24h TTL |
| `webSearchTool` | Web search via the Brave API (labeled mock results when no API key is set) | Content-hash, 10min TTL |
| `fileReaderTool` | Reads files relative to cwd - rejects absolute paths and directory traversal | Content-hash, 30s TTL |
| `fetchTool` | HTTP requests (GET/POST/PUT/PATCH/DELETE/HEAD) with body truncation | No-cache (side effects) |

## Tool dependencies

By default, all tool calls in a single model turn run concurrently. When one tool genuinely needs the output of another, declare it in `toolDependencies`. All names must be registered in the registry - the constructor throws immediately if any are unknown.

```typescript
const agent = new Agent(registry, {
  model: "claude-haiku-4-5-20251001",
  toolDependencies: {
    // summarise_results always runs after web_search completes
    summarise_results: ["web_search"],
    // analyse_data runs after both
    analyse_data: ["web_search", "summarise_results"],
  },
});
```

Dependencies on tools not called in a given turn are silently ignored. Cycles throw `CyclicDependencyError` immediately.

## Cancellation

```typescript
const runPromise = agent.run(longTask);

setTimeout(() => agent.abort(), 10_000);

const result = await runPromise;
if (result.status === "error") {
  console.log(result.error.code);   // "PLANNER_ERROR"
  console.log(result.trace.steps.length); // steps completed before cancel
}
```

`run()` always resolves - it never rejects. Calling `abort()` before `run()` is valid; calling it when no run is active is a no-op.

## Live event stream

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

Complete lifecycle per call:

```
dispatched → succeeded                                            # first attempt success
cache_hit                                                         # no dispatch
dispatched → attempt_failed → retrying → dispatched → succeeded  # retry success
dispatched → attempt_failed → ... → failed                       # exhausted
failed                                                            # pre-dispatch (not found, invalid input)
```

## Custom tools

```typescript
import { z } from "zod";
import { ToolTimeoutError } from "@bonnie-mcconnell/liminal";
import type { ToolDefinition } from "@bonnie-mcconnell/liminal";

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
  execute: async ({ city, units }, signal) => fetchWeather(city, units, signal),
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

## Sharing a cache across runs

```typescript
import { Agent, ToolRegistry, ResultCache, type Cache, calculatorTool } from "@bonnie-mcconnell/liminal";

const cache: Cache = new ResultCache();
const registry = new ToolRegistry().register(calculatorTool);

const agent1 = new Agent(registry, { model: "claude-haiku-4-5-20251001" }, { cache });
const agent2 = new Agent(registry, { model: "claude-haiku-4-5-20251001" }, { cache });

const stats = cache.stats("calculator");
console.log(`Hit rate: ${((stats?.hitRate ?? 0) * 100).toFixed(1)}%`);
```

## Error handling

```typescript
import { BudgetExceededError, MaxIterationsError } from "@bonnie-mcconnell/liminal";

const result = await agent.run(task);

if (result.status === "error") {
  if (result.error instanceof BudgetExceededError) {
    // result.error.budgetType → "tokens" | "steps"
    // result.error.limit, result.error.used
  } else if (result.error instanceof MaxIterationsError) {
    // Model is looping - check tool descriptions and prompt design
  }
  // result.trace is always present, even on failure.
  console.log(`${result.trace.steps.length} steps completed`);
}
```

## Observability

Every significant event is written as newline-delimited JSON:

```
{"ts":"...","level":"info","runId":"run_4a9f2b","event":"agent.started","data":{"model":"claude-haiku-4-5-20251001"}}
{"ts":"...","level":"debug","runId":"run_4a9f2b","event":"tool.dispatched","data":{"callId":"c1","toolName":"web_search","attempt":1}}
{"ts":"...","level":"warn","runId":"run_4a9f2b","event":"tool.retrying","data":{"callId":"c1","attempt":2,"delayMs":623}}
{"ts":"...","level":"info","runId":"run_4a9f2b","event":"tool.succeeded","data":{"durationMs":780,"cacheHit":false}}
{"ts":"...","level":"info","runId":"run_4a9f2b","event":"agent.completed","data":{"totalTokens":2841,"steps":3}}
```

`LOG_LEVEL=debug` shows the execution plan, cache checks, and every dispatch. `LOG_LEVEL=warn` shows only retries and failures. NDJSON is ingested without configuration by Datadog, CloudWatch, and Splunk.

## Tests

322 tests across 15 files.

```bash
npm test               # unit + integration
npm run test:coverage  # with lcov report
```

The integration tests replace the Anthropic SDK with a deterministic mock - no credentials needed, fully reproducible. Covered failure modes: timeouts, input validation errors, retry exhaustion, dependency cycles, budget limits, partial parallel failures, `toolDependencies` sequencing, construction-time validation, and `abort()` pre-run and mid-run cancellation.

Unit coverage: 99% statements, 93% branches.

## Extending it

**Distributed cache.** The `Cache` interface is three methods: `configure`, `get`, `set`. Implement it against Redis and inject at construction. The executor and agent are unchanged - they don't know or care what's behind the interface. The SHA-256 key scheme works across processes because it's deterministic: the same logical input always produces the same 16-char hex key regardless of where it was generated.

**Model-agnostic.** The Anthropic SDK lives in one file (`agent.ts`). The only thing that would change to support OpenAI or Gemini is the API call and response parsing inside `Agent.run()`. Everything downstream - the scheduler, executor, cache, event stream - operates on `ToolCall[]` and `ToolResult[]`, which are your types, not the SDK's.

**Trace persistence.** `ExecutionTrace` is a plain object with no circular references. Store it by `runId` and you get run replay, prompt A/B testing against historical inputs, and per-task cost attribution.

**Streaming tool results.** Currently `execute()` awaits the complete result. Making it return `AsyncIterable<ToolEvent>` - where `succeeded` is the terminal event - would let long-running tools stream partial progress. The scheduler and cache are unaffected; the blast radius is `ToolExecutor` and the agent loop's result-collection logic.

## Demo

```bash
export ANTHROPIC_API_KEY=sk-...
npm run demo        # runs a multi-step research task
npm run demo:dry    # prints the task and tools without calling the API

# Real web search (mock data used otherwise):
export BRAVE_SEARCH_API_KEY=BSA...
npm run demo
```

## Structure

```
src/
├── core/          agent, executor, registry, scheduler, cache, lru, defaults
├── errors/        typed error hierarchy (LiminalError subclasses)
├── tools/         calculator, web_search, file_reader, fetch
├── observability/ logger (NDJSON), trace renderer, EventEmitter
├── types/         ToolDefinition, AgentResult, ExecutionTrace, ToolEvent, policies
└── index.ts       public API - everything not exported here is an internal detail

benchmarks/
└── parallel-vs-sequential.ts   measures scheduler speedup with real wall-clock numbers

tests/
├── unit/          one file per source module (14 suites)
└── integration/   full agent loop with deterministic mock Anthropic client
```
