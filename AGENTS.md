# Liminal - Agent Guide

This document describes the project for AI coding assistants and developers
working with the codebase for the first time.

## What this project is

Liminal is a TypeScript library that makes AI assistants use external tools
reliably. It handles the reliability layer that most agent implementations get
wrong: timeouts, retries with jitter, content-hash caching, DAG-based parallel
scheduling, partial failure handling, and typed observability.

## Project structure

```
src/
├── core/
│   ├── agent.ts          - outer loop, budget, dependency resolution
│   ├── executor.ts       - timeout, retry, cache, event emission
│   ├── registry.ts       - tool storage, policy merging
│   ├── scheduler.ts      - Kahn's algorithm, DAG levels
│   ├── result-cache.ts   - Cache interface, SHA-256 keying, LRU
│   ├── lru-cache.ts      - doubly-linked list + Map, O(1) get/set
│   └── defaults.ts       - DEFAULT_SHOULD_RETRY, DEFAULT_TOOL_POLICY
├── errors/
│   ├── base.ts           - LiminalError (fixes instanceof for subclasses)
│   ├── tool-errors.ts    - ToolNotFoundError, ToolTimeoutError, etc.
│   └── agent-errors.ts   - BudgetExceededError, CyclicDependencyError, etc.
├── observability/
│   ├── logger.ts         - NDJSON structured logger
│   ├── trace.ts          - renderTrace() tree renderer
│   └── event-emitter.ts  - EventEmitter<T>, synchronous, ~40 lines
├── tools/
│   ├── calculator.ts     - recursive-descent parser, no eval()
│   ├── web-search.ts     - Brave API + [Mock] fallback
│   └── file-reader.ts    - path sandboxing, traversal rejection
├── types/
│   ├── tool.ts           - ToolDefinition, CachePolicy (discriminated union)
│   ├── agent.ts          - AgentConfig, AgentStep, AgentResult
│   └── events.ts         - ToolEvent discriminated union (6 types)
└── index.ts              - public API surface

tests/
├── unit/                 - one file per source module (13 suites, 14 total with integration)
└── integration/          - full agent loop with deterministic mock SDK
```

## Key invariants

- **ToolExecutor.execute() never throws.** Every outcome is a typed ToolResult.
- **CachePolicy is a discriminated union.** Accessing ttlMs on a "no-cache" policy
  is a compile error, not a runtime surprise.
- **The Cache interface, not ResultCache, is what the executor depends on.** Swap
  in any backend without touching orchestration code.
- **Tool dependencies are declared statically** on AgentConfig.toolDependencies,
  not parsed from model output. The scheduler (Kahn's algorithm) resolves them
  per-turn.
- **Events are a synchronous side-channel.** onEvent does not affect the return
  value, timing, or error handling of the executor.

## Development commands

```bash
npm install          # install dependencies
npm test             # run all 256 tests
npm run typecheck    # tsc --noEmit (includes tests and examples)
npm run lint         # ESLint strict-type-checked
npm run format       # Prettier (write)
npm run format:check # Prettier (check only - used in CI)
npm run demo:dry     # inspect the research agent without API calls
npm run demo         # live run (requires ANTHROPIC_API_KEY)
npm run build        # compile to dist/
```

## Adding a tool

Implement `ToolDefinition`, register with `ToolRegistry`, export from
`src/tools/index.ts` and `src/index.ts`. Every tool must:

- Define `inputSchema` and `outputSchema` as Zod schemas
- Return a Promise from `execute` - never throw from it
- Provide `summarize` to control how it appears in `renderTrace` output
- Emit appropriate `ToolEvent`s if extending the executor directly

See `src/tools/calculator.ts` for a complete example with a no-retry, short-TTL
cache policy.

## What not to change

- The `Cache` interface contract: `ToolExecutor` depends on it, not `ResultCache`.
- The executor's never-throws guarantee: every new path must return `ToolResult`.
- The `CachePolicy` discriminated union: mergePolicy() handles each branch
  explicitly for a reason - don't collapse it into a flat interface.
- SHA-256 for cache key derivation: non-cryptographic hashes cluster on
  structured JSON inputs. See result-cache.ts for the collision probability note.
