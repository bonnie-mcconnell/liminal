import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/core/registry.js";
import { DEFAULT_TOOL_POLICY } from "../../src/core/defaults.js";
import type { ToolDefinition } from "../../src/types/index.js";

function simpleTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: z.object({ x: z.string() }),
    outputSchema: z.object({ y: z.string() }),
    execute: async ({ x }: { x: string }) => ({ y: x }),
  };
}

describe("ToolRegistry", () => {
  describe("registration", () => {
    it("registers a tool and makes it retrievable by name", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("alpha"));
      expect(registry.get("alpha")).toBeDefined();
    });

    it("throws when registering a duplicate tool name", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("alpha"));
      expect(() => registry.register(simpleTool("alpha"))).toThrow(/already registered/);
    });

    it("returns `this` for fluent chaining", () => {
      const registry = new ToolRegistry();
      const result = registry.register(simpleTool("a")).register(simpleTool("b"));
      expect(result).toBe(registry);
    });
  });

  describe("deregistration", () => {
    it("removes a registered tool", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("alpha"));
      registry.deregister("alpha");
      expect(registry.get("alpha")).toBeUndefined();
    });

    it("is a no-op for an unknown name", () => {
      const registry = new ToolRegistry();
      expect(() => registry.deregister("nonexistent")).not.toThrow();
    });
  });

  describe("policy merging", () => {
    it("fills in full defaults for a tool with no policy", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("alpha"));
      const policy = registry.getPolicy("alpha");
      expect(policy?.timeoutMs).toBe(DEFAULT_TOOL_POLICY.timeoutMs);
      expect(policy?.retry.maxAttempts).toBe(DEFAULT_TOOL_POLICY.retry.maxAttempts);
      expect(policy?.cache.strategy).toBe("content-hash");
    });

    it("overrides only the specified top-level fields", () => {
      const registry = new ToolRegistry();
      registry.register({ ...simpleTool("alpha"), policy: { timeoutMs: 999 } });
      const policy = registry.getPolicy("alpha");
      expect(policy?.timeoutMs).toBe(999);
      expect(policy?.retry.maxAttempts).toBe(DEFAULT_TOOL_POLICY.retry.maxAttempts);
    });

    it("overrides individual retry fields while keeping the rest as defaults", () => {
      const registry = new ToolRegistry();
      registry.register({
        ...simpleTool("alpha"),
        policy: {
          retry: {
            maxAttempts: 1,
            backoff: "none",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterMs: 0,
            shouldRetry: () => false,
          },
        },
      });
      const policy = registry.getPolicy("alpha");
      expect(policy?.retry.maxAttempts).toBe(1);
      expect(policy?.retry.backoff).toBe("none");
      // timeoutMs is still the default
      expect(policy?.timeoutMs).toBe(DEFAULT_TOOL_POLICY.timeoutMs);
    });

    it("sets strategy: no-cache with only that field - no ttlMs/vary/maxEntries bleed-through", () => {
      // This is the discriminated union test - after our mergePolicy fix, a no-cache
      // policy must not carry ttlMs or other content-hash fields on its type.
      const registry = new ToolRegistry();
      registry.register({
        ...simpleTool("alpha"),
        policy: { cache: { strategy: "no-cache" } },
      });
      const policy = registry.getPolicy("alpha");
      expect(policy?.cache.strategy).toBe("no-cache");
      // The cast to a wider type lets us inspect at runtime that ttlMs is truly absent.
      expect((policy?.cache as { ttlMs?: unknown }).ttlMs).toBeUndefined();
    });

    it("merges individual content-hash cache fields against the defaults", () => {
      const registry = new ToolRegistry();
      registry.register({
        ...simpleTool("alpha"),
        policy: { cache: { strategy: "content-hash", ttlMs: 1_000, vary: [], maxEntries: 512 } },
      });
      const policy = registry.getPolicy("alpha");
      expect(policy?.cache.strategy).toBe("content-hash");
      if (policy?.cache.strategy === "content-hash") {
        expect(policy.cache.ttlMs).toBe(1_000);
        expect(policy.cache.maxEntries).toBe(512);
      }
    });

    it("returns undefined policy for an unregistered tool", () => {
      const registry = new ToolRegistry();
      expect(registry.getPolicy("ghost")).toBeUndefined();
    });
  });

  describe("names()", () => {
    it("returns all registered tool names", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("a")).register(simpleTool("b")).register(simpleTool("c"));
      expect(registry.names().sort()).toEqual(["a", "b", "c"]);
    });

    it("returns an empty array when no tools are registered", () => {
      expect(new ToolRegistry().names()).toEqual([]);
    });
  });

  describe("toAnthropicTools()", () => {
    it("includes name and description for each tool", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("my_tool"));
      const tools = registry.toAnthropicTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("my_tool");
      expect(tools[0]?.description).toContain("my_tool");
    });

    it("returns an empty array when no tools are registered", () => {
      expect(new ToolRegistry().toAnthropicTools()).toEqual([]);
    });

    it("includes input_schema for each tool", () => {
      const registry = new ToolRegistry();
      registry.register(simpleTool("t"));
      const tools = registry.toAnthropicTools();
      expect(tools[0]?.input_schema).toBeDefined();
      expect(tools[0]?.input_schema.type).toBe("object");
    });
  });
});
