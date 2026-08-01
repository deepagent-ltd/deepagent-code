export * as ContextProjection from "./projection"

import { Schema } from "effect"
import { Hash } from "../util/hash"
import { Token } from "../util/token"
import type { GraphKind } from "./contract"

export const SerializerVersion = 1
export const TokenizerVersion = "chars-per-token-v1"

export type Evidence = {
  readonly graph: GraphKind
  readonly ref: string
  readonly revision: string
  readonly freshness: "current" | "stale" | "historical" | "unknown"
  readonly trust: "governed_guidance" | "repository_evidence" | "historical_evidence" | "runtime_evidence"
  readonly title: string
  readonly evidence: string
  readonly score: number
}

export const Status = Schema.Struct({
  graph: Schema.Literals(["code", "knowledge", "memory", "documents"]),
  state: Schema.Literals([
    "ready_empty",
    "cold",
    "indexing",
    "stale",
    "degraded",
    "unavailable",
    "denied",
    "partial",
    "conflict",
    "broken",
  ]),
  reasonCode: Schema.String,
})
export type Status = typeof Status.Type

export type Rendered = {
  readonly serializerVersion: 1
  readonly tokenizerVersion: typeof TokenizerVersion
  readonly body: string
  readonly projection: string
  readonly projectionHash: string
  readonly bytes: number
  readonly tokenCount: number
  readonly offsets: Readonly<Record<string, { readonly start: number; readonly end: number }>>
}

export class InvalidProjectionError extends Schema.TaggedErrorClass<InvalidProjectionError>()(
  "ContextProjection.InvalidProjectionError",
  { reason: Schema.String },
) {}

const GraphOrder = ["code", "documents", "knowledge", "memory"] as const

export function render(input: {
  readonly evidence: readonly Evidence[]
  readonly statuses: readonly Status[]
}): Rendered {
  if (input.evidence.some((item) => !Number.isFinite(item.score))) {
    throw new InvalidProjectionError({ reason: "evidence scores must be finite" })
  }
  if (new Set(input.evidence.map((item) => item.ref)).size !== input.evidence.length) {
    throw new InvalidProjectionError({ reason: "evidence refs must be unique" })
  }
  const payload: Record<string, unknown> = {}
  for (const graph of GraphOrder) {
    const items = input.evidence
      .filter((item) => item.graph === graph)
      .toSorted((a, b) => a.ref.localeCompare(b.ref) || a.title.localeCompare(b.title))
      .map((item) => ({
        ref: item.ref,
        revision: item.revision,
        freshness: item.freshness,
        trust: item.trust,
        title: item.title,
        evidence: item.evidence,
        score: normalizeNumber(item.score),
      }))
    if (items.length > 0) payload[graph] = items
  }
  const statuses = input.statuses
    .filter((status) => status.state !== "ready_empty")
    .toSorted(
      (a, b) => GraphOrder.indexOf(a.graph) - GraphOrder.indexOf(b.graph) || a.reasonCode.localeCompare(b.reasonCode),
    )
    .map((status) => ({ graph: status.graph, state: status.state, reasonCode: status.reasonCode }))
  if (statuses.length > 0) payload.statuses = statuses

  const body = escapeUnsafeJson(JSON.stringify(payload))
  const bytes = Buffer.byteLength(body)
  const projection = `project-context-json-v${SerializerVersion} bytes=${bytes}\n${body}`
  const bodyStart = projection.length - body.length
  return {
    serializerVersion: SerializerVersion,
    tokenizerVersion: TokenizerVersion,
    body,
    projection,
    projectionHash: Hash.sha256(projection),
    bytes,
    tokenCount: Token.estimate(projection),
    offsets: Object.fromEntries(
      input.evidence.map((item) => {
        const field = `"ref":${escapeUnsafeJson(JSON.stringify(item.ref))}`
        const fieldStart = body.indexOf(field)
        const start = fieldStart < 0 ? -1 : bodyStart + fieldStart + `"ref":"`.length
        return [item.ref, { start, end: start < 0 ? -1 : start + item.ref.length }]
      }),
    ),
  }
}

function normalizeNumber(value: number) {
  if (Object.is(value, -0)) return 0
  return Number(value.toPrecision(12))
}

function escapeUnsafeJson(value: string) {
  return value
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}
