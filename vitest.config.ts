import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // forks pool supports top-level await in test files (used in integration
    // tests to import modules after vi.mock is registered).
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        // Barrel/re-export files: no executable branches to cover.
        "src/index.ts",
        "src/types/index.ts",
        "src/observability/index.ts",
        "src/tools/index.ts",
        "src/errors/index.ts",
        // Pure type declarations: zero runtime code.
        "src/types/events.ts",
        "src/types/tool.ts",
        "src/types/agent.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
