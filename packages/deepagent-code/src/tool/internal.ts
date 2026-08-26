import type { Tool } from "ai"

const tools = new WeakSet<object>()

export function set(tool: Tool): void {
  tools.add(tool)
}

export function has(tool: Tool): boolean {
  return tools.has(tool)
}

export * as ToolInternal from "./internal"
