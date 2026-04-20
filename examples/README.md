# Examples

## research-agent.ts

Runs a multi-step research task against four tools: `web_search`, `calculator`, `file_reader`, and `fetch`.

- Step 1: two web searches and a calculator call run in parallel (3 independent calls, 1 level).
- Step 2: file read and HTTP fetch run in parallel (2 independent calls, 1 level).
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
