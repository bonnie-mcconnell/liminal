# Changelog

## [0.4.2] - 2026-04-20

**Bug fix: incorrect collision probability in `generateRunId` JSDoc.** The comment claimed `< 10⁻¹⁸` for 10⁶ runs; the correct birthday bound for N=10⁶ in a 2⁶⁴ space is ~2.7×10⁻⁸. Updated with the correct value and the calculation behind it. (The `cacheKey` JSDoc was already correct - only the run ID comment was wrong.)

**Bug fix: `maxConcurrency: 0` silently hung.** Passing `maxConcurrency: 0` created zero workers, ran no tasks, and returned an array of sentinel rejections - a silent hang with no error. The `Agent` constructor now throws a `RangeError` with a clear message. `allSettledConcurrent` also adds a `limit < 1` defence-in-depth guard.

**Improvement: duplicate call ID error now names the offending ID.** Previously: `"Duplicate call IDs in the same scheduling batch"`. Now: `"Duplicate call IDs in the same scheduling batch: dup_id"`. Smaller fix, much faster to debug.

**Improvement: `LruCache.clear()` no longer resets counters.** Resetting stats on every `clear()` call meant `ResultCache.stats()` would undercount if the cache was flushed between runs. `clear()` now only evicts entries. A new `resetStats()` method zeroes counters explicitly when that's what you want.

**Docs: documented the cache key truncation tradeoff.** The `cacheKey` function truncates the SHA-256 digest to 16 hex chars (64 bits). The JSDoc now explains when the full 256-bit digest would be the right choice and how to get there. Added the same tradeoff to "What I'd do differently" in the README.

6 new tests (316 → 322): `maxConcurrency: 0` guard, duplicate ID naming, `clear()` preserves counters, `resetStats()`, cacheKey nested-object invariants, scheduler ordering invariants over 20 random acyclic graphs.

## [0.4.1] - 2026-04-19

Cooperative cancellation is now implemented in all three network-capable built-in tools.

`fetchTool` and `webSearchTool` forward the `AbortSignal` directly to the underlying `fetch()` call, so an in-flight HTTP request actually stops when the signal fires - the OS connection is torn down, not just abandoned. `fileReaderTool` checks the signal at each I/O boundary (`stat` then `readFile`) via `throwIfAborted()`, which is correct for operations that don't natively accept a signal.

To support this, `ToolDefinition.execute` now optionally accepts a second `signal?: AbortSignal` argument. The executor passes the run's signal through on every dispatch. Tools that don't declare the parameter continue to work unchanged - the executor still races the signal externally via `Promise.race`. The cooperative path is additive: declaring the parameter means the tool stops doing work on abort, rather than running to completion in the background.

5 new tests (311 → 316): signal forwarded to `fetch()`, no signal property when not provided, abort before fetch resolves, file-reader aborts before I/O, file-reader succeeds with live signal.

## [0.4.0] - 2026-04-17

The main thing in this release is cancellation. `agent.abort()` stops a run after the current model call or tool turn completes - the `run()` promise always resolves to a structured result, never rejects. The `AbortSignal` threads through to every `ToolExecutor.execute()` call so the executor can bail out before the next attempt rather than spinning until timeout.

Pre-run abort works: calling `abort()` before `run()` makes the next run return immediately without making any API calls. Post-run `abort()` is a no-op. I wanted both edge cases to be safe to call without checking state first.

Also fixed the `allSettledConcurrent` worker pool to not create more workers than there are tasks - when `maxConcurrency` was larger than the task count, the excess workers would spin-exit immediately. Harmless but wasteful.

Added `ToolRegistry.size` and `[Symbol.iterator]` - I kept reaching for these when writing tests and hitting undefined.

`toolDependencies` is now validated at construction time. Previously, a misspelled tool name in the dependency graph was silently dropped - no error, no sequencing. The failure showed up as a mysterious ordering bug at runtime that was annoying to track down.

The benchmark script (`npm run bench`) measures parallel vs sequential with controlled artificial delays. On 3 independent 200ms calls: sequential ~624ms, parallel ~211ms, 2.95× speedup at 99.8% of theoretical maximum. Scheduling overhead is under 11ms.

25 new tests (276 → 301), covering: abort pre-run and mid-run, AbortSignal threading, ToolRegistry iteration, construction-time validation, and a handful of edge cases I found while writing the cancellation code.

## [0.3.0] - 2026-04-15

Added `fetchTool` - HTTP GET/POST/PUT/PATCH/DELETE/HEAD with body truncation and retry on transient network errors. Not cached by default; HTTP-level caching (ETags, Cache-Control) is the right layer for that.

Added `maxConcurrency` to `AgentConfig`. Caps simultaneous tool calls within a scheduler level using a bounded worker pool. Defaults to unlimited so existing code is unaffected.

Fixed a path sandboxing bug in `fileReaderTool` where Windows UNC paths bypassed the absolute-path check. Replaced the drive-letter regex with `path.isAbsolute()`, which handles Unix, Windows drive-letter, and UNC paths correctly.

Fixed the trace renderer incorrectly marking calls `[parallel]` when the same tool name appeared in both a sequential and a parallel level in the same step.

## [0.2.0] - 2025-02-15

First public release with the core agent loop, scheduler, executor, and result cache.

Built-in tools: `calculatorTool` (recursive-descent parser, no `eval()`), `webSearchTool` (Brave API with mock fallback), `fileReaderTool` (path-sandboxed).

Structured NDJSON logging, `renderTrace` tree renderer, typed `ToolEvent` stream.
