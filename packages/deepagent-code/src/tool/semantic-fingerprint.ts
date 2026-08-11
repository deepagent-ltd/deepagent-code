import type { Tool } from "ai"
import { Hash } from "@deepagent-code/core/util/hash"
import { ToolProvenance } from "./provenance"

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

const readOnlyTools = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "code_intel",
  "context_query",
  "lsp",
  "git_read",
  "query_log",
  "task_read",
  "task_status",
])

export function resolveResult(tool: Tool | undefined, result: unknown, toolName?: string) {
  const resolver = tool && resultResolvers.get(tool)
  if (resolver) return resolver(result)
  if (!tool || (!readOnlyTools.has(toolName ?? "") && ToolProvenance.get(tool)?.riskTier !== "read_only")) return
  const encoded = canonicalResult(result)
  if (encoded === undefined) return
  return {
    kind: "read_only_result",
    fingerprint: Hash.sha256(encoded),
    bytes: new TextEncoder().encode(encoded).byteLength,
  }
}

function canonicalResult(value: unknown, ancestors = new Set<object>()): string | undefined {
  if (value === null || value === undefined) return "null"
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString())}}`
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (ancestors.has(value)) return
  ancestors.add(value)
  const values = Array.isArray(value)
    ? Array.from(value, (item) => canonicalResult(item, ancestors))
    : Object.keys(value)
        .sort()
        .map((key) => {
          const encoded = canonicalResult((value as Record<string, unknown>)[key], ancestors)
          return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`
        })
  ancestors.delete(value)
  if (values.some((item) => item === undefined)) return
  return Array.isArray(value) ? `[${values.join(",")}]` : `{${values.join(",")}}`
}

export * as ToolSemanticFingerprint from "./semantic-fingerprint"
