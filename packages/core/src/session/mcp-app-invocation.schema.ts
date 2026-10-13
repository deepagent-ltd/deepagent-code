export * as McpAppInvocationSchema from "./mcp-app-invocation.schema"

import { Schema } from "effect"
import { EventV2 } from "../event/define"
import { SessionSchema } from "./schema"

export const LIMITS = Object.freeze({
  argumentsBytes: 32768, argumentNodes: 128, argumentDepth: 8,
  pendingGlobal: 64, pendingSession: 8, boundaryBatch: 4,
  resultBytes: 8 * 1024 * 1024, retainedBytes: 64 * 1024 * 1024,
  textBytes: 256 * 1024, metadataBytes: 64 * 1024,
  invocationMs: 60000, resultLifetimeMs: 86400000, receiptsGlobal: 100000,
})
export const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ViewID = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
export const ID = Schema.String.check(Schema.isPattern(/^mcpapp_[a-f0-9]{64}$/))
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const RpcID = Schema.Union([Schema.String.check(Schema.isMaxLength(128)), Schema.Int.check(Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }))])
export const Arguments = Schema.Record(Schema.String, Schema.Json).check(Schema.makeFilter((value) => bounded(value, LIMITS.argumentsBytes, LIMITS.argumentNodes, LIMITS.argumentDepth)))
export const InvokeInput = Schema.Struct({ sessionID: SessionSchema.ID, viewID: ViewID, rpcID: RpcID, name: Label, arguments: Arguments })
export type InvokeInput = typeof InvokeInput.Type
export const State = Schema.Literals(["queued", "awaiting_permission", "dispatching", "settled", "failed", "cancelled_before_dispatch", "unknown"])
export type State = typeof State.Type
export const ErrorCode = Schema.Literals(["invalid", "unavailable", "changed", "expired", "conflict", "capacity", "permission_denied", "not_dispatched", "unknown", "result_retired", "not_found", "restricted", "interrupted"])
export class Error extends Schema.TaggedErrorClass<Error>()("McpAppInvocation.Error", { code: ErrorCode, message: Schema.String }) {}
export const Status = Schema.Struct({
  version: Schema.Literal(1), invocationID: ID, sessionID: SessionSchema.ID, viewID: ViewID, rpcID: RpcID,
  admittedSeq: Count, state: State, expiresAt: Count,
  errorCode: Schema.optional(ErrorCode), resultHash: Schema.optional(Digest), resultAvailable: Schema.Boolean,
}).annotate({ identifier: "McpAppInvocationStatus" })
export type Status = typeof Status.Type
export const Result = Schema.Struct({ ...Status.fields, result: Schema.Record(Schema.String, Schema.Json) }).annotate({ identifier: "McpAppInvocationResult" })
export type Result = typeof Result.Type
export const InvokeResult = Result
export type InvokeResult = Result
export const StatusInput = Schema.Struct({ sessionID: SessionSchema.ID, invocationID: ID })
export const ResultInput = Schema.Struct({ ...StatusInput.fields, viewID: ViewID })
export const ListInput = Schema.Struct({ sessionID: SessionSchema.ID, after: Schema.optional(Count), limit: Schema.optional(Count.check(Schema.isBetween({ minimum: 1, maximum: 64 }))) })
export const Source = Schema.Struct({
  kind: Schema.Literal("mcp_app"), sessionID: SessionSchema.ID, viewID: ViewID, generation: ViewID,
  server: Label, tool: Label, registryID: Label, definitionHash: Digest, configurationHash: Digest,
  agentID: Label, agentSelector: Schema.NullOr(Label), mutationEpoch: Count, expiresAt: Count,
  placement: Schema.Struct({ directory: Schema.String, workspaceID: Schema.NullOr(Schema.String), projectID: Schema.String,
    securityNamespaceID: Schema.String, namespaceBindingHash: Digest, locationKey: Schema.String, projectScopeKey: Schema.String }),
})
export type Source = typeof Source.Type
export const PermissionSource = Schema.Struct({ type: Schema.Literal("mcp_app"), invocationID: ID, viewID: ViewID, server: Label, tool: Label, generation: ViewID })
export const PermissionReceipt = Schema.Struct({ version: Schema.Literal(1), source: PermissionSource,
  sessionPermissionHash: Digest, agentPermissionsHash: Digest, agentInstanceID: Label, agentGeneration: Count, savedEpoch: Count })
export const Admitted = EventV2.define({ type: "session.mcp-app.admitted", sync: { aggregate: "sessionID", version: 1 },
  schema: { sessionID: SessionSchema.ID, invocationID: ID, sourceHash: Digest, inputHash: Digest, timestamp: Count } })
export const Changed = EventV2.define({ type: "session.mcp-app.changed", sync: { aggregate: "sessionID", version: 1 },
  schema: { sessionID: SessionSchema.ID, invocationID: ID, status: Status, timestamp: Count } })

/** Check hostile RPC objects before stringify/schema recursion. No inherited properties or cycles. */
export function bounded(value: unknown, bytes: number, nodes = 100000, depth = 32) {
  const pending = [{ value, depth: 0 }]
  const seen = new Set<object>()
  const budget = { bytes: 0, nodes: 0 }
  while (pending.length) {
    const item = pending.pop()!
    if (++budget.nodes > nodes || item.depth > depth) return false
    if (item.value === null || typeof item.value === "boolean") { budget.bytes += 5; continue }
    if (typeof item.value === "number") { if (!Number.isFinite(item.value)) return false; budget.bytes += 24; continue }
    if (typeof item.value === "string") { budget.bytes += new TextEncoder().encode(item.value).length + 2; if (budget.bytes > bytes) return false; continue }
    if (!item.value || typeof item.value !== "object" || seen.has(item.value)) return false
    if (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype && Object.getPrototypeOf(item.value) !== null) return false
    seen.add(item.value)
    const entries = Object.getOwnPropertyDescriptors(item.value)
    for (const [key, descriptor] of Object.entries(entries)) {
      if (Array.isArray(item.value) && key === "length") continue
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return false
      budget.bytes += new TextEncoder().encode(key).length + 4
      if (budget.bytes > bytes) return false
      pending.push({ value: descriptor.value, depth: item.depth + 1 })
    }
    budget.bytes += 2
  }
  if (budget.bytes > bytes) return false
  const encoded = JSON.stringify(value)
  return typeof encoded === "string" && new TextEncoder().encode(encoded).length <= bytes
}
