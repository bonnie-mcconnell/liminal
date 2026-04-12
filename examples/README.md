# Examples

## research-agent.ts

Runs a multi-step research task against three tools: `web_search`, `calculator`, and `file_reader`.

- The two web searches in step 1 run in parallel (no declared dependencies between them).
- The calculator result is served from cache on repeat runs within the same session.
- Live progress is printed to stderr via `AgentOptions.onEvent` - dispatches and retries appear as they happen, before the final trace is rendered.

```bash
export ANTHROPIC_API_KEY=sk-...
npm run demo

# Inspect the task and registered tools without making any API calls
npm run demo:dry

# Real web results instead of labeled mock data
export BRAVE_SEARCH_API_KEY=BSA...
npm run demo
```

Set `LOG_LEVEL=debug` to see every cache check, tool dispatch, and execution plan in the structured JSON log stream.
