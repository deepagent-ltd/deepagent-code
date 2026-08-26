import type { Tool as AITool } from "ai"
import type { Tool } from "./tool"

/**
 * M2 (S1-v3.4): explicit tool provenance side-channel.
 *
 * The AI SDK `Tool` objects that reach `request.ts` are plain runtime objects
 * with no slot for "where did this tool come from". The old code reverse-engineered
 * the origin from the tool name (`name.includes(":")`), which contradicted the
 * actual `_`-separated MCP naming and misclassified real MCP tools as builtin.
 *
 * Rather than pollute the AI SDK `Tool` shape (and risk it being serialized to
 * the provider), provenance rides in a `WeakMap` keyed by the tool object. Both
 * tool sources write into it at assembly time (`session/tools.ts` for builtin/custom,
 * `mcp/index.ts` for MCP), and `request.ts` reads it back. References are preserved
 * end-to-end (the tools `Record` is only filtered/re-sorted, never rebuilt), so the
 * WeakMap lookups resolve.
 */
const store = new WeakMap<object, Tool.Provenance>()

export function set(tool: AITool, provenance: Tool.Provenance): void {
  store.set(tool as object, provenance)
}

export function get(tool: AITool): Tool.Provenance | undefined {
  return store.get(tool as object)
}

export * as ToolProvenance from "./provenance"
