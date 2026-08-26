export * as CodeIntelFacade from "./facade"

import type { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextAuthorization } from "@deepagent-code/core/context-federation/authorization"
import { ContextFederationContract } from "@deepagent-code/core/context-federation/contract"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Hash } from "@deepagent-code/core/util/hash"
import { Database } from "@deepagent-code/core/database/database"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { LiveContextArtifactStore } from "../context-federation/artifact-service"
import { LiveContextQueryAuthorization } from "../context-federation/query-authorization"
import { LiveContextTokenCodec } from "../context-federation/token-service"
import { LocationIndexRuntime } from "../location-index/runtime"
import { LiveCodeQuery } from "./query-service"

const TokenLifetimeMs = 15 * 60_000

export type Result = {
  readonly schemaVersion: 2
  readonly summary: string
  readonly index: {
    readonly state: "cold" | "indexing" | "ready" | "degraded" | "unavailable"
    readonly revision?: string
    readonly generation: number
    readonly indexedAt?: number
    readonly dirtyPathCount: number
    readonly semanticCoverage: Readonly<Record<string, "file" | "syntax" | "semantic">>
    readonly stale: boolean
  }
  readonly query: {
    readonly status: CodeQuery.Result["status"]
    readonly consistency: "stale_ok" | "fresh"
    readonly freshnessSatisfied: boolean
  }
  readonly enrichment: CodeQuery.Result["enrichment"]
  readonly hits: readonly {
    readonly ref: string
    readonly file: string
    readonly startLine?: number
    readonly endLine?: number
    readonly symbol?: string
    readonly kind?: string
    readonly relation?: string
    readonly direction?: "incoming" | "outgoing"
    readonly degree?: CodeGraph.Degree
    readonly snippet?: string
    readonly sources: CodeQuery.Hit["sources"]
    readonly score?: number
  }[]
  readonly truncated: boolean
  readonly nextCursor?: string
  readonly artifactRef?: string
  readonly fallback?: CodeQuery.Result["fallback"]
}

export class AuthorizationUnavailableError extends Schema.TaggedErrorClass<AuthorizationUnavailableError>()(
  "CodeIntelFacade.AuthorizationUnavailableError",
  {},
) {}
export class LocationUnavailableError extends Schema.TaggedErrorClass<LocationUnavailableError>()(
  "CodeIntelFacade.LocationUnavailableError",
  {},
) {}
export class CursorError extends Schema.TaggedErrorClass<CursorError>()("CodeIntelFacade.CursorError", {}) {}
export class ArtifactUnavailableError extends Schema.TaggedErrorClass<ArtifactUnavailableError>()(
  "CodeIntelFacade.ArtifactUnavailableError",
  {},
) {}

export type Error = AuthorizationUnavailableError | LocationUnavailableError | CursorError | ArtifactUnavailableError | CodeQuery.InvalidQueryError

export interface Interface {
  readonly execute: (input: {
    readonly request: ContextFederationContract.CodeIntelInput
    readonly sessionId: string
    readonly agent: string
    readonly now?: number
  }) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/CodeIntelFacade") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* CodeQuery.Service
    const authorization = yield* ContextQueryAuthorization.Service
    const codec = yield* ContextTokenCodec.Service
    const runtime = yield* LocationIndexRuntime.Service
    const artifacts = yield* ContextArtifactStore.Service

    const execute: Interface["execute"] = (input) =>
      Effect.gen(function* () {
        const envelope = yield* authorization.resolve({ sessionId: input.sessionId, agent: input.agent })
        if (!envelope) return yield* new AuthorizationUnavailableError()
        const handle = yield* runtime.current()
        if (!handle) return yield* new LocationUnavailableError()
        const now = input.now ?? Date.now()
        const queryFingerprint = fingerprint(input.request)
        const authorizationFingerprint = ContextAuthorization.fingerprint(envelope.principal, envelope.egress)
        const cursor = input.request.cursor
          ? yield* codec.openCursor(input.request.cursor, now).pipe(Effect.mapError(() => new CursorError()))
          : undefined
        if (
          cursor &&
          (cursor.securityNamespaceId !== handle.identity.securityNamespaceId ||
            cursor.locationKey !== handle.identity.locationKey ||
            !("projectionKind" in cursor.snapshotRevision) ||
            cursor.queryFingerprint !== queryFingerprint ||
            cursor.authorizationFingerprint !== authorizationFingerprint)
        ) return yield* new CursorError()
        const offset = cursor?.page.offset ?? 0
        const limit = Math.min(input.request.limit ?? 20, 100)
        if (offset < 0 || offset > 99) return yield* new CursorError()
        const raw = yield* code.query({
          intent: input.request.intent,
          ...(input.request.query === undefined ? {} : { query: input.request.query }),
          ...(input.request.symbol === undefined ? {} : { symbol: input.request.symbol }),
          ...(input.request.file === undefined ? {} : { file: input.request.file }),
          ...(input.request.depth === undefined ? {} : { depth: input.request.depth }),
          limit: Math.min(offset + limit + 1, 100),
          consistency: input.request.consistency ?? "stale_ok",
          principal: envelope.principal,
          egress: envelope.egress,
          sessionId: input.sessionId,
        })
        if (cursor && (!raw.index.revision || !("projectionKind" in cursor.snapshotRevision) || !ContextReference.sameProjectionRevision(cursor.snapshotRevision, raw.index.revision))) {
          return yield* new CursorError()
        }
        const filtered = input.request.kind
          ? raw.hits.filter((hit) => hit.kind === input.request.kind || (input.request.kind === "file" && !hit.symbol))
          : raw.hits
        const hits = filtered.slice(offset, offset + limit)
        const lifetime = { issuedAt: now, expiresAt: now + TokenLifetimeMs }
        const selectionId = `code_tool_${Hash.sha256(JSON.stringify({
          sessionId: input.sessionId,
          queryFingerprint,
          snapshot: raw.index.revision,
          offset,
          refs: hits.map((hit) => ContextReference.canonicalContextRef(hit.ref)),
        }))}`
        const artifact = yield* artifacts.write({
          securityNamespaceId: handle.identity.securityNamespaceId,
          sessionId: input.sessionId,
          selectionId,
          authorizationFingerprint,
          artifact: {
            schemaVersion: 1,
            selectionId,
            queryFingerprint,
            authorizationFingerprint,
            graphStatuses: [raw.status],
            rankingVersion: "code-query-v1",
            selected: hits.map((hit) => ({
              ref: hit.ref,
              sensitivity: "source_code",
              score: hit.score ?? 0,
              reason: hit.sources.join("+"),
              excerpt: (hit.snippet ?? hit.file).slice(0, 1_000),
            })),
            rejected: raw.status.kind === "blocked"
              ? [{ graph: "code", reasonCode: raw.status.reasonCode }]
              : [],
          },
          now,
        }).pipe(Effect.exit)
        if (Exit.isFailure(artifact) && artifacts.policy === "required") {
          return yield* new ArtifactUnavailableError()
        }
        const artifactRef = Exit.isSuccess(artifact) ? artifact.value.ref : undefined
        const sealedHits = hits.map((hit) => ({
          ref: codec.sealContextRef(hit.ref, lifetime),
          file: hit.file,
          ...(hit.startLine === undefined ? {} : { startLine: hit.startLine }),
          ...(hit.endLine === undefined ? {} : { endLine: hit.endLine }),
          ...(hit.symbol === undefined ? {} : { symbol: hit.symbol }),
          ...(hit.kind === undefined ? {} : { kind: hit.kind }),
          ...(hit.relation === undefined ? {} : { relation: hit.relation }),
          ...(hit.direction === undefined ? {} : { direction: hit.direction }),
          ...(hit.degree === undefined ? {} : { degree: hit.degree }),
          ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
          sources: hit.sources,
          ...(hit.score === undefined ? {} : { score: hit.score }),
        }))
        const visibleHits = fit(sealedHits, (hit) => {
          const { snippet: _snippet, ...compact } = hit
          return compact
        })
        const visibleSourceHits = hits.slice(0, visibleHits.length)
        const truncated = raw.truncated || filtered.length > offset + visibleHits.length || visibleHits.length < hits.length
        const nextCursor = truncated && raw.index.revision && offset + visibleHits.length < 100
          ? codec.sealCursor({
              securityNamespaceId: handle.identity.securityNamespaceId,
              locationKey: handle.identity.locationKey,
              snapshotRevision: raw.index.revision,
              queryFingerprint,
              authorizationFingerprint,
              page: {
                offset: offset + visibleHits.length,
                ...(visibleSourceHits.at(-1)?.score === undefined ? {} : { lastScore: visibleSourceHits.at(-1)!.score }),
                ...(visibleSourceHits.at(-1) ? { lastEntityId: visibleSourceHits.at(-1)!.ref.entityId } : {}),
              },
            }, lifetime)
          : undefined
        return {
          schemaVersion: 2 as const,
          summary: summary(raw, visibleHits.length),
          index: {
            state: raw.index.state,
            ...(raw.index.revision ? { revision: ContextReference.canonicalProjectionRevision(raw.index.revision) } : {}),
            generation: raw.index.generation,
            ...(raw.index.indexedAt === undefined ? {} : { indexedAt: raw.index.indexedAt }),
            dirtyPathCount: raw.index.dirtyPathCount,
            semanticCoverage: raw.index.semanticCoverage,
            stale: raw.index.stale,
          },
          query: {
            status: raw.status,
            consistency: raw.consistency,
            freshnessSatisfied: raw.freshnessSatisfied,
          },
          enrichment: raw.enrichment,
          hits: visibleHits,
          truncated,
          ...(nextCursor ? { nextCursor } : {}),
          ...(artifactRef ? { artifactRef } : {}),
          ...(raw.fallback ? { fallback: raw.fallback } : {}),
        }
      })

    return Service.of({ execute })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(LiveCodeQuery.defaultLayer),
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(LiveContextQueryAuthorization.defaultLayer),
  Layer.provide(LiveContextTokenCodec.defaultLayer),
  Layer.provide(LiveContextArtifactStore.defaultLayer.pipe(
    Layer.provide(LiveContextTokenCodec.defaultLayer),
    Layer.provide(Database.defaultLayer),
  )),
)

function fingerprint(input: ContextFederationContract.CodeIntelInput) {
  return Hash.sha256(JSON.stringify({
    intent: input.intent,
    query: input.query,
    symbol: input.symbol,
    file: input.file,
    kind: input.kind,
    depth: input.depth,
    limit: input.limit,
    consistency: input.consistency,
  }))
}

function summary(result: CodeQuery.Result, count: number) {
  if (result.status.kind === "blocked") return `Code query unavailable: ${result.status.reasonCode}.`
  if (count === 0) return `No authorized code results. Index ${result.index.state}.`
  return `Found ${count} authorized code result${count === 1 ? "" : "s"}. Index ${result.index.state}; LSP ${result.enrichment.lsp}.`
}

function fit<A>(items: readonly A[], compact: (item: A) => A) {
  const selected = items.reduce<{ readonly items: readonly A[]; readonly stopped: boolean }>((state, item) => {
    if (state.stopped) return state
    const next = [...state.items, item]
    return JSON.stringify(next).length <= 6_000 ? { items: next, stopped: false } : { ...state, stopped: true }
  }, { items: [], stopped: false }).items
  if (selected.length > 0 || items.length === 0) return selected
  return [compact(items[0]!)]
}
