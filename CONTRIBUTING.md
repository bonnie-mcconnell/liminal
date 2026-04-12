# Contributing

## Setup

```bash
git clone https://github.com/bonnie-mcconnell/liminal.git
cd liminal
npm install
npm test
```

Node 20+ required. If a `package-lock.json` is present, use `npm ci` instead of `npm install` for a reproducible install.

## Rules

**Write the test alongside the change.** Every module has a counterpart test file. Failure paths matter more than happy paths - the interesting behaviour is what happens when tools time out, inputs are invalid, retries are exhausted, or the dependency graph has a cycle.

**`npm run typecheck` before committing.** The tsconfig uses `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride`, so code that compiles at default strictness sometimes fails here. That is deliberate.

**No `any` without a comment.** If you need an escape hatch, add an inline note explaining what the type system cannot express and why the cast is safe.

**`ToolExecutor.execute` never throws.** It returns a `ToolResult` with `status: "error"` for every failure. A thrown error would bypass the structured error feedback that lets the model self-correct.

**Emit a `ToolEvent` for every lifecycle transition.** If you add a new execution path in `executor.ts`, it must emit the appropriate event. Pre-dispatch failures emit `failed` with `attempts: 0`. Post-dispatch failures emit `attempt_failed` then either `retrying` or `failed`. Success emits `succeeded`. Cache hits emit `cache_hit`. The complete contract is documented in `src/types/events.ts` and verified in `tests/unit/executor.test.ts` under "event emission".

**Named errors, not `new Error("...")`.** Add a class to `src/errors/` for any new failure mode so callers can use `instanceof` checks.

**Provide `summarize` on new tools.** The `summarize` hook on `ToolDefinition` controls how the tool call appears in `renderTrace` output. It receives the validated input and should return the primary identifier as a string - the query, expression, path, city, or whatever field a human would use to describe the call. When `summarize` is absent, the renderer falls back to a priority-ordered heuristic (tries `query`, `expression`, `path`, `url`, `id`, `name` before falling back to the first string field). Provide `summarize` explicitly whenever the primary field doesn't match that list or when the label should combine multiple fields.

## Code style

Formatter: Prettier (`.prettierrc`). Linter: ESLint (`strict-type-checked`). Comments explain *why*, not *what* - if a comment restates what the code does, delete it.

## Adding a tool

```typescript
import { z } from "zod";
import { DEFAULT_SHOULD_RETRY } from "../core/defaults.js";
import type { ToolDefinition } from "../types/index.js";

export const myTool: ToolDefinition = {
  name: "my_tool",
  description: "What it does. When to use it. When NOT to use it.",
  inputSchema: z.object({ /* ... */ }),
  outputSchema: z.object({ /* ... */ }),
  execute: async (input) => { /* ... */ },
  summarize: ({ query }) => query, // replace 'query' with your tool's primary identifier field
  policy: {
    timeoutMs: 10_000,
    retry: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      jitterMs: 200,
      // Use DEFAULT_SHOULD_RETRY or extend it:
      // shouldRetry: (err, attempt) => myCheck(err) || DEFAULT_SHOULD_RETRY(err, attempt)
      shouldRetry: DEFAULT_SHOULD_RETRY,
    },
    cache: { strategy: "content-hash", ttlMs: 5 * 60_000, vary: [], maxEntries: 256 },
  },
};
```

Never use `eval()` or `new Function()`. Validate filesystem paths (see `file-reader.ts`). Export from `src/tools/index.ts` and `src/index.ts`.

## Demo

```bash
export ANTHROPIC_API_KEY=your_key
npm run demo
npm run demo:dry
```

Set `BRAVE_SEARCH_API_KEY` for real web results. Set `LOG_LEVEL=debug` to see every dispatch and cache check.
