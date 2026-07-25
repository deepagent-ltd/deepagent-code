import type { Tool } from "ai"

export type Resolver = (input: unknown) => unknown

const resolvers = new WeakMap<object, Resolver>()
const resultResolvers = new WeakMap<object, Resolver>()

export function set(tool: Tool, resolver: Resolver) {
  resolvers.set(tool, resolver)
}

export function resolve(tool: Tool | undefined, input: unknown) {
  const resolver = tool && resolvers.get(tool)
  return resolver ? resolver(input) : input
}

export function setResult<Result>(tool: Tool, resolver: (result: Result) => unknown) {
  resultResolvers.set(tool, (result) => resolver(result as Result))
}

export function resolveResult(tool: Tool | undefined, result: unknown) {
  const resolver = tool && resultResolvers.get(tool)
  return resolver?.(result)
}

export * as ToolSemanticFingerprint from "./semantic-fingerprint"
