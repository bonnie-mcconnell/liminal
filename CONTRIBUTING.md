# Contributing

```bash
git clone https://github.com/bonnie-mcconnell/liminal.git
cd liminal
npm install
npm test
```

Node 20+ required.

## Before you change anything

Run `npm run typecheck`. The tsconfig uses `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so code that passes default-strictness TypeScript sometimes fails here. That's intentional - the stricter flags have caught real bugs.

## The one rule that matters most

**`ToolExecutor.execute()` must never throw.** Every failure path returns a typed `ToolResult`. If you add a new execution path and it throws instead of returning an error result, the agent loop crashes and the model never gets a chance to recover. Check the executor tests - they cover every failure mode for a reason.

## Other things that matter

**Write tests for failure paths.** The interesting behaviour is what happens when tools time out, inputs are invalid, retries exhaust, or the dependency graph has a cycle. Happy-path tests are fine but they're not the ones that catch bugs.

**Named errors, not `new Error("...")`**. Every failure mode has a class in `src/errors/` so callers can use `instanceof` without string-matching messages. Add a class for any new failure mode.

**Emit a `ToolEvent` for every new lifecycle transition.** If you add a path in `executor.ts`, it needs an event. The contract is in `src/types/events.ts`.

**No `any` without a comment** explaining why the type system can't express what you need.

## Adding a tool

Implement `ToolDefinition`, register with `ToolRegistry`, export from `src/tools/index.ts` and `src/index.ts`. See `src/tools/calculator.ts` for a complete example.

Provide `summarize` - it controls how the tool call appears in `renderTrace` output. Without it the renderer falls back to a heuristic that checks `query`, `expression`, `path`, `url`, `id`, `name` in order.

Implement cooperative cancellation if your tool does I/O. The `execute` function optionally accepts a second `signal?: AbortSignal` argument. Forward it to `fetch()`, pass it to fs operations, or check `signal.throwIfAborted()` at natural boundaries. Tools that ignore the signal still work correctly via the executor's external `Promise.race` - they just continue running in the background after a timeout fires.

## Code style

Prettier for formatting, ESLint `strict-type-checked` for linting. Comments explain *why*, not *what*.
