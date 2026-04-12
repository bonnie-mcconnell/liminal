import type { ZodTypeAny, ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition, ToolPolicy, CachePolicy } from "../types/index.js";
import { DEFAULT_TOOL_POLICY } from "./defaults.js";

/**
 * Holds registered tools and their fully-resolved policies.
 *
 * This is the single source of truth for what tools exist. The executor,
 * agent, and cache all go through the registry rather than holding their
 * own tool references. Duplicate names throw at registration time rather
 * than silently overwriting an existing tool.
 *
 * Policy resolution happens once at `register()` - not per-call - so
 * execution paths pay no merging cost at runtime.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly resolvedPolicies = new Map<string, ToolPolicy>();

  register<I extends ZodTypeAny, O extends ZodTypeAny>(tool: ToolDefinition<I, O>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
    this.resolvedPolicies.set(tool.name, mergePolicy(tool.policy));
    return this;
  }

  deregister(name: string): this {
    this.tools.delete(name);
    this.resolvedPolicies.delete(name);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getPolicy(name: string): ToolPolicy | undefined {
    return this.resolvedPolicies.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  toAnthropicTools(): Anthropic.Tool[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.inputSchema as ZodType<unknown>, {
        target: "openApi3",
        $refStrategy: "none",
      }) as Anthropic.Tool["input_schema"],
    }));
  }
}

/**
 * Resolves a tool's partial policy override into a complete `ToolPolicy`.
 *
 * `retry` is merged field-by-field from the defaults, so a tool that only
 * overrides `maxAttempts` still gets the default `backoff`, `baseDelayMs`, etc.
 *
 * `cache` cannot be merged field-by-field because `CachePolicy` is a
 * discriminated union: a tool that specifies `strategy: "no-cache"` should
 * have no `ttlMs`, `vary`, or `maxEntries` fields at all. Spreading the
 * default cache policy on top would silently reintroduce those fields with
 * misleading values. Instead, the cache policy is replaced in full when the
 * tool overrides `strategy`, and individual fields are merged only within
 * the same strategy.
 */
function mergePolicy(partial: Partial<ToolPolicy> | undefined): ToolPolicy {
  if (partial === undefined) return DEFAULT_TOOL_POLICY;

  return {
    timeoutMs: partial.timeoutMs ?? DEFAULT_TOOL_POLICY.timeoutMs,
    retry: { ...DEFAULT_TOOL_POLICY.retry, ...partial.retry },
    cache: mergeCachePolicy(partial.cache),
  };
}

function mergeCachePolicy(override: Partial<CachePolicy> | undefined): CachePolicy {
  if (override === undefined) return DEFAULT_TOOL_POLICY.cache;

  // If the override changes the strategy, it must supply a complete policy
  // for that strategy - we cannot safely fill in fields from a policy with
  // a different strategy. Treat the override as the full cache policy.
  if (override.strategy === "no-cache") {
    return { strategy: "no-cache" };
  }

  if (override.strategy === "content-hash") {
    const defaults =
      DEFAULT_TOOL_POLICY.cache.strategy === "content-hash" ? DEFAULT_TOOL_POLICY.cache : null;
    return {
      strategy: "content-hash",
      ttlMs: override.ttlMs ?? defaults?.ttlMs ?? 5 * 60 * 1000,
      vary: override.vary ?? defaults?.vary ?? [],
      maxEntries: override.maxEntries ?? defaults?.maxEntries ?? 512,
    };
  }

  // No strategy override - merge individual fields into the default, which
  // must be "content-hash" (the only cacheable strategy in DEFAULT_TOOL_POLICY).
  if (DEFAULT_TOOL_POLICY.cache.strategy === "content-hash") {
    const defaults = DEFAULT_TOOL_POLICY.cache;
    // Cast once: override has no `strategy` field here, so we treat it as a
    // partial content-hash policy. The cast is safe because this branch is
    // only reached when the caller did not specify a strategy at all.
    type ContentHashPartial = Partial<Extract<CachePolicy, { strategy: "content-hash" }>>;
    const ch = override as ContentHashPartial;
    return {
      strategy: "content-hash",
      ttlMs: ch.ttlMs ?? defaults.ttlMs,
      vary: ch.vary ?? defaults.vary,
      maxEntries: ch.maxEntries ?? defaults.maxEntries,
    };
  }

  return DEFAULT_TOOL_POLICY.cache;
}
