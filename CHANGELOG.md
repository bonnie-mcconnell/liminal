# Changelog

All notable changes to this project are documented here.

## [0.2.0] - 2025-02-15

### Added
- **Tool dependency scheduling** - declare `toolDependencies` on `AgentConfig` to impose execution order within a turn. Independent calls still run concurrently; declared dependencies are resolved per-turn by Kahn's algorithm and recorded as `parallelLevels` on `AgentStep`.
- **Typed event stream** - `AgentOptions.onEvent` delivers a `ToolEvent` at every lifecycle transition (cache hit, dispatched, attempt failed, retrying, succeeded, failed). Zero overhead when no listener is registered.
- **`EventEmitter<T>`** - exported for wiring multiple listeners without coupling to the agent loop.
- **`ToolDefinition.summarize`** - per-tool hook controlling how the call appears in `renderTrace` output. Falls back to a priority-ordered heuristic when absent.
- **`Cache` interface** - `ToolExecutor` and `Agent` now depend on the interface, not the concrete `ResultCache` class. Swap in any backend (Redis, test double) without touching orchestration code.

### Changed
- Cache key derivation switched from djb2 to SHA-256 (64-bit prefix). SHA-256's avalanche property prevents clustering on structured JSON inputs; collision probability ≈ 2.7×10⁻⁸ for 10⁶ distinct inputs.
- `CachePolicy` is now a discriminated union. Accessing `ttlMs` on a `"no-cache"` policy is a compile error, not a runtime surprise.
- Run IDs now use `crypto.randomUUID()` (122-bit CSPRNG) instead of `Math.random()`.

### Fixed
- `CyclicDependencyError` thrown by the scheduler is now caught and returned as a structured `AgentResult` rather than rejecting the `run()` promise.

## [0.1.0] - 2025-01-20

Initial release.

- Agent loop with budget enforcement (token and step limits)
- `ToolExecutor`: cache → input validation → timeout → retry → output validation → cache write. Never throws.
- `ResultCache`: djb2 content-addressable, per-tool LRU, TTL expiry
- `LruCache`: O(1) get/set via doubly-linked list + Map
- DAG scheduler (Kahn's algorithm) for parallel tool execution
- `ToolRegistry` with policy merging and JSON Schema conversion
- Built-in tools: `calculator` (recursive-descent parser, no eval), `web_search` (Brave API + mock), `file_reader` (path sandboxing)
- Structured NDJSON logger with runtime `LOG_LEVEL` switching
- `renderTrace` execution tree renderer
- 161 unit tests across 13 modules + integration tests with deterministic mock SDK
