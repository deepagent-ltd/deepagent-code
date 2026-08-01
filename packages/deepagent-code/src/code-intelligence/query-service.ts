export * as LiveCodeQuery from "./query-service"

import { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
import { CodeLSPEnrichment } from "@deepagent-code/core/code-intelligence/lsp-enrichment"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { ContextAuthorization } from "@deepagent-code/core/context-federation/authorization"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import type { ContextRef, ProjectionSnapshotRevision } from "@deepagent-code/core/context-federation/reference"
import { EditorBufferSnapshot } from "@deepagent-code/core/code-intelligence/editor-buffer"
import { Hash } from "@deepagent-code/core/util/hash"
import { Context, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { LSP } from "../lsp/lsp"
import { LocationIndexRuntime } from "../location-index/runtime"
import { LocationIndexCoordinator } from "../location-index/coordinator"
import { isSensitivePath } from "../location-index/manifest"
import { query as coldBootstrap } from "./cold-bootstrap"
import { make as makeLSPEnrichment } from "./lsp-enrichment"
import { materialize } from "./live-source"
import { LiveEditorBufferSnapshot } from "./editor-buffer-snapshot"

export function layer(config: { readonly freshTimeoutMs: number; readonly lspTimeoutMs: number }) {
  if (!Number.isSafeInteger(config.freshTimeoutMs) || config.freshTimeoutMs <= 0) throw new Error("invalid fresh timeout")
  return Layer.effect(
    CodeQuery.Service,
    Effect.gen(function* () {
      const runtime = yield* LocationIndexRuntime.Service
      const lsp = yield* LSP.Service
      const buffers = yield* EditorBufferSnapshot.Service

      const query: CodeQuery.Interface["query"] = (request) =>
        Effect.gen(function* () {
          const invalid = validate(request)
          if (invalid) return yield* new CodeQuery.InvalidQueryError({ reason: invalid })
          const handle = yield* runtime.current()
          if (!handle) return unavailable(request)
          const file = request.file ? normalizeFile(request.file) : undefined
          if (request.file && !file) return yield* new CodeQuery.InvalidQueryError({ reason: "file" })
          const gate = ContextAuthorization.authorize({
            ref: contextRef(handle.identity, "code_query_gate", "query:gate"),
            principal: request.principal,
            egress: request.egress,
            sensitivity: "source_code",
          })
          if (!gate.allowed) return denied(request, gate.reason === "provider_egress_denied" ? "provider_egress_denied" : "scope_denied")

          const refreshed = request.consistency === "stale_ok"
            ? true
            : Exit.isSuccess(yield* handle.coordinator
                .requestReconciliation({ reason: "reconcile", source: "fresh_query" })
                .pipe(
                  Effect.andThen(handle.coordinator.drain("code")),
                  Effect.timeout(config.freshTimeoutMs),
                  Effect.exit,
                ))
          const indexExit = yield* handle.coordinator.codeStatus().pipe(Effect.exit)
          const index = Exit.isSuccess(indexExit) ? indexExit.value : coldIndex()
          const queryText = request.query ?? request.symbol ?? file ?? ""
          const graphExit = index.revision
            ? yield* graphQuery(handle.coordinator, request, queryText).pipe(Effect.exit)
            : undefined
          const graph = graphExit && Exit.isSuccess(graphExit) ? graphExit.value : { revision: index.revision, hits: [] }
          const graphHits = graph.hits.flatMap((hit) => graphHit(handle.identity, graph.revision, hit))
          const seed = graph.hits[0]
          const lspIntent = enrichmentIntent(request.intent)
          const lspResult = lspIntent
            ? yield* makeLSPEnrichment({ root: handle.identity.canonicalRoot, lsp, timeoutMs: config.lspTimeoutMs }).enrich({
                intent: lspRequestIntent(lspIntent, seed),
                ...(queryText ? { query: queryText } : {}),
                ...(file ?? seed?.entity.filePath ? { path: file ?? seed?.entity.filePath } : {}),
                ...(seed?.symbol ? { line: seed.symbol.startLine, character: 0 } : {}),
                limit: Math.min(request.limit + 1, 100),
              })
            : undefined
          const lspHits = lspResult?.state === "ready"
            ? lspResult.observations.map((observation) => lspHit(handle.identity, observation))
            : []
          const bootstrap = !index.revision
            ? yield* coldBootstrap({
                root: handle.identity.canonicalRoot,
                identity: handle.identity,
                principal: request.principal,
                egress: request.egress,
                text: queryText,
                limit: Math.min(request.limit + 1, 12),
                timeoutMs: Math.min(config.freshTimeoutMs, 750),
              })
            : undefined
          const bootstrapHits = bootstrap?.materialized.map((hit) => ({
            ref: hit.candidate.ref,
            file: hit.path,
            snippet: hit.candidate.summary,
            sources: ["filesystem" as const],
            score: hit.candidate.features.lexical,
            contentSha: hit.contentSha,
            editorOverlay: "not_applicable" as const,
          })) ?? []
          const selected = merge([...graphHits, ...lspHits, ...bootstrapHits]).slice(0, request.limit + 1)
          const materialized = yield* Effect.forEach(
            selected,
            (hit) => materializeHit({
              hit,
              root: handle.identity.canonicalRoot,
              locationKey: handle.identity.locationKey,
              sessionId: request.sessionId,
              principal: request.principal,
              egress: request.egress,
              buffers,
            }),
            { concurrency: 4 },
          )
          const hits = materialized.filter((hit): hit is CodeQuery.Hit => Boolean(hit)).slice(0, request.limit)
          const stale = materialized.some((hit) => hit?.sources.includes("graph") && hit.contentSha === undefined)
          if (stale) {
            yield* Effect.forEach(
              [...new Set(hits.filter((hit) => hit.sources.includes("graph")).map((hit) => hit.file))],
              (filePath) => handle.coordinator.observe({
                file: path.join(handle.identity.canonicalRoot, filePath),
                event: "change",
                source: "fresh_query",
              }).pipe(Effect.catch(() => Effect.void)),
              { discard: true },
            )
          }
          const revisions = [
            ...(graph.revision ? [{ source: "code_graph", revision: ContextReference.canonicalProjectionRevision(graph.revision), state: "ready" as const }] : []),
            ...(lspResult?.state === "ready"
              ? [{ source: "lsp", revision: Hash.sha256(JSON.stringify(lspResult.observations)), state: "ready" as const }]
              : lspResult
                ? [{ source: "lsp", state: lspResult.state, reasonCode: lspResult.reasonCode } as const]
                : []),
            ...(bootstrap?.status.revisions ?? []),
          ]
          const status = graph.revision
            ? hits.length > 0
              ? ContextFederation.status.matched("code", revisions)
              : ContextFederation.status.empty("code", revisions)
            : hits.length > 0
              ? ContextFederation.status.partial({ graph: "code", state: "cold", reasonCode: "cold_start", revisions })
              : bootstrap?.status ?? ContextFederation.status.blocked({
                  graph: "code",
                  state: "unavailable",
                  reasonCode: "source_error",
                  revisions,
                })
          const overlay = hits.some((hit) => hit.editorOverlay === "ready")
            ? "ready" as const
            : hits.some((hit) => hit.editorOverlay === "unavailable")
              ? "unavailable" as const
              : "not_applicable" as const
          return {
            index: { ...index, stale: stale || index.dirtyPathCount > 0 },
            status,
            consistency: request.consistency,
            freshnessSatisfied: request.consistency === "stale_ok" || (refreshed && !stale && index.dirtyPathCount === 0),
            enrichment: {
              lsp: !lspResult ? "not_applicable" as const : lspResult.state === "ready" ? "ready" as const : lspResult.state === "unavailable" ? "unavailable" as const : "partial" as const,
              editorOverlay: overlay,
              ...(lspResult && lspResult.state !== "ready" ? { reasonCode: lspResult.reasonCode } : {}),
            },
            hits,
            truncated: selected.length > request.limit,
            ...(!graph.revision && lspHits.length > 0 ? { fallback: { from: "graph" as const, reasonCode: "cold_start" as const } } : {}),
            ...(graphHits.length > 0 && lspResult?.state === "unavailable"
              ? { fallback: { from: "lsp" as const, reasonCode: "lsp_unavailable" as const } }
              : {}),
          }
        })

      return CodeQuery.Service.of({ query })
    }),
  )
}

export const defaultLayer = layer({ freshTimeoutMs: 750, lspTimeoutMs: 500 }).pipe(
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(LiveEditorBufferSnapshot.layer()),
)

function graphQuery(
  coordinator: LocationIndexCoordinator.Interface,
  request: CodeQuery.Request,
  queryText: string,
) {
  return Effect.gen(function* () {
    const found = queryText ? yield* coordinator.searchCode({ query: queryText, limit: Math.min(request.limit + 1, 100) }) : { revision: undefined, hits: [] }
    const seed = found.hits[0]
    const relation = relationQuery(request.intent)
    if (!seed || !relation) return found
    const neighbors = yield* graphNeighbors({
      coordinator,
      frontier: [seed.entity.entityId],
      seen: new Set([seed.entity.entityId]),
      direction: relation.direction,
      relations: relation.relations,
      remainingDepth: request.depth ?? 1,
      limit: Math.min(request.limit + 1, 100),
      hits: [],
      revision: found.revision,
    })
    return {
      revision: neighbors.revision ?? found.revision,
      hits: request.intent === "overview" ? [seed, ...neighbors.hits] : neighbors.hits,
    }
  })
}

function graphNeighbors(input: {
  readonly coordinator: LocationIndexCoordinator.Interface
  readonly frontier: readonly string[]
  readonly seen: ReadonlySet<string>
  readonly direction: "incoming" | "outgoing"
  readonly relations: readonly CodeGraph.EdgeRelation[]
  readonly remainingDepth: number
  readonly limit: number
  readonly hits: readonly CodeGraph.Neighbor[]
  readonly revision?: ProjectionSnapshotRevision
}): Effect.Effect<{ readonly revision?: ProjectionSnapshotRevision; readonly hits: readonly CodeGraph.Neighbor[] }, LocationIndexCoordinator.Error> {
  if (input.remainingDepth <= 0 || input.frontier.length === 0 || input.hits.length >= input.limit) {
    return Effect.succeed({ revision: input.revision, hits: input.hits.slice(0, input.limit) })
  }
  return Effect.gen(function* () {
    const level = yield* Effect.forEach(
      input.frontier,
      (entityId) => input.coordinator.codeNeighbors({
        entityId,
        direction: input.direction,
        relations: input.relations,
        limit: input.limit,
      }),
      { concurrency: 4 },
    )
    const next = level.flatMap((result) => result.hits).filter((hit) => !input.seen.has(hit.entity.entityId))
    const unique = [...new Map(next.map((hit) => [hit.entity.entityId, hit])).values()]
    const seen = new Set([...input.seen, ...unique.map((hit) => hit.entity.entityId)])
    return yield* graphNeighbors({
      ...input,
      frontier: unique.map((hit) => hit.entity.entityId),
      seen,
      remainingDepth: input.remainingDepth - 1,
      hits: [...input.hits, ...unique].slice(0, input.limit),
      revision: level.find((result) => result.revision)?.revision ?? input.revision,
    })
  })
}

function relationQuery(intent: CodeQuery.Request["intent"]) {
  if (intent === "references") return { direction: "incoming" as const, relations: ["references", "calls"] as const }
  if (intent === "implementations") return { direction: "incoming" as const, relations: ["implements"] as const }
  if (intent === "calls_in") return { direction: "incoming" as const, relations: ["calls"] as const }
  if (intent === "calls_out") return { direction: "outgoing" as const, relations: ["calls"] as const }
  if (intent === "dependencies") return { direction: "outgoing" as const, relations: ["imports", "depends_on", "references"] as const }
  if (intent === "dependents") return { direction: "incoming" as const, relations: ["imports", "depends_on", "references"] as const }
  if (intent === "overview") return { direction: "outgoing" as const, relations: ["contains", "imports", "calls", "exports"] as const }
}

function graphHit(
  identity: Parameters<typeof contextRef>[0],
  revision: ProjectionSnapshotRevision | undefined,
  hit: CodeGraph.SearchHit | CodeGraph.Neighbor,
): readonly CodeQuery.Hit[] {
  const file = hit.file?.path ?? hit.entity.filePath
  if (!file || isSensitivePath(file) || !revision) return []
  return [{
    ref: contextRef(identity, hit.entity.entityId, ContextReference.canonicalProjectionRevision(revision), file, hit.symbol),
    file,
    ...(hit.symbol ? { startLine: hit.symbol.startLine, endLine: hit.symbol.endLine, symbol: hit.symbol.symbolPath, kind: hit.symbol.kind } : {}),
    ...(hit.degree ? { degree: hit.degree } : {}),
    ...("edge" in hit ? { relation: hit.edge.relation, direction: hit.direction } : {}),
    sources: ["graph"],
    score: hit.score,
    ...(hit.file ? { contentSha: hit.file.contentSha } : {}),
    editorOverlay: "not_applicable",
  }]
}

function lspHit(identity: Parameters<typeof contextRef>[0], observation: CodeLSPEnrichment.Observation): CodeQuery.Hit {
  return {
    ref: contextRef(
      identity,
      `code_lsp_${Hash.sha256(JSON.stringify(observation))}`,
      `lsp:${Hash.sha256(JSON.stringify(observation))}`,
      observation.path,
      observation.symbol ? { symbolPath: observation.symbol, startLine: observation.startLine, endLine: observation.endLine } : undefined,
    ),
    file: observation.path,
    startLine: observation.startLine,
    endLine: observation.endLine,
    ...(observation.symbol ? { symbol: observation.symbol } : {}),
    ...(observation.kind === undefined ? {} : { kind: String(observation.kind) }),
    sources: ["lsp"],
    ...(observation.contentSha ? { contentSha: observation.contentSha } : {}),
    ...(observation.documentVersion === undefined ? {} : { documentVersion: observation.documentVersion }),
    editorOverlay: "not_applicable",
  }
}

function materializeHit(input: {
  readonly hit: CodeQuery.Hit
  readonly root: string
  readonly locationKey: ContextReference.LocationKey
  readonly sessionId: string
  readonly principal: CodeQuery.Request["principal"]
  readonly egress: CodeQuery.Request["egress"]
  readonly buffers: EditorBufferSnapshot.Interface
}): Effect.Effect<CodeQuery.Hit | undefined> {
  if (isSensitivePath(input.hit.file)) return Effect.succeed(undefined)
  if (!ContextAuthorization.authorize({
    ref: input.hit.ref,
    principal: input.principal,
    egress: input.egress,
    sensitivity: "source_code",
  }).allowed) return Effect.succeed(undefined)
  return materialize({
    root: input.root,
    locationKey: input.locationKey,
    path: input.hit.file,
    sessionId: input.sessionId,
    graphContentSha: input.hit.sources.includes("graph") ? input.hit.contentSha : undefined,
    ...(input.hit.sources.includes("lsp") ? { lsp: { documentVersion: input.hit.documentVersion, contentSha: input.hit.contentSha } } : {}),
  }).pipe(
    Effect.provideService(EditorBufferSnapshot.Service, input.buffers),
    Effect.map((source) => {
      const lines = source.content.split(/\r?\n/)
      const start = Math.max(1, input.hit.startLine ?? 1)
      const end = Math.min(lines.length, input.hit.endLine ?? start + 7, start + 7)
      return {
        ...input.hit,
        snippet: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"),
        sources: [...new Set([...input.hit.sources, source.contentSource])],
        contentSha: source.graph === "current" ? source.contentSha : undefined,
        ...(source.documentVersion === undefined ? {} : { documentVersion: source.documentVersion }),
        editorOverlay: source.editorOverlay,
      }
    }),
    Effect.catch(() => Effect.succeed(input.hit)),
  )
}

function merge(hits: readonly CodeQuery.Hit[]) {
  const values = new Map<string, CodeQuery.Hit>()
  hits.forEach((hit) => {
    const key = `${hit.file}:${hit.startLine ?? 0}:${hit.endLine ?? 0}:${hit.symbol ?? ""}`
    const current = values.get(key)
    values.set(key, current ? {
      ...current,
      sources: [...new Set([...current.sources, ...hit.sources])],
      score: Math.max(current.score ?? 0, hit.score ?? 0),
      ...(hit.documentVersion === undefined ? {} : { documentVersion: hit.documentVersion }),
    } : hit)
  })
  return [...values.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.file.localeCompare(b.file))
}

function contextRef(
  identity: { readonly securityNamespaceId: ContextReference.SecurityNamespaceID; readonly locationKey: ContextReference.LocationKey; readonly projectScopeKey: ContextReference.ProjectScopeKey },
  entityId: string,
  revision: string,
  file?: string,
  symbol?: { readonly symbolPath: string; readonly startLine: number; readonly endLine: number },
): ContextRef {
  return {
    graph: "code",
    entityId,
    binding: {
      scope: "location",
      securityNamespaceId: identity.securityNamespaceId,
      locationKey: identity.locationKey,
      projectScopeKey: identity.projectScopeKey,
    },
    ...(file ? { locator: { path: file, ...(symbol ?? {}) } } : {}),
    revision,
  }
}

function enrichmentIntent(intent: CodeQuery.Request["intent"]): CodeLSPEnrichment.Intent | undefined {
  if (intent === "dependencies" || intent === "dependents") return
  if (intent === "overview") return "definition"
  return intent
}

function lspRequestIntent(intent: CodeLSPEnrichment.Intent, seed?: CodeGraph.SearchHit | CodeGraph.Neighbor) {
  if (["search", "outline", "diagnostics"].includes(intent)) return intent
  return seed?.entity.filePath && seed.symbol ? intent : "search" as const
}

function validate(request: CodeQuery.Request) {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) return "limit"
  if (["search"].includes(request.intent) && !request.query?.trim() && !request.symbol?.trim()) return "query_required"
  if (["outline", "diagnostics"].includes(request.intent) && !request.file) return "file_required"
  if (!["search", "outline", "diagnostics"].includes(request.intent) && !request.symbol?.trim() && !request.file) {
    return "symbol_or_file_required"
  }
}

function normalizeFile(file: string) {
  if (!file || path.isAbsolute(file) || file.includes("\\")) return
  const normalized = path.posix.normalize(file)
  if (normalized === "." || normalized.startsWith("../")) return
  return normalized
}

function coldIndex(): CodeGraph.IndexStatus {
  return { state: "cold", generation: 0, dirtyPathCount: 0, semanticCoverage: {} }
}

function unavailable(request: CodeQuery.Request): CodeQuery.Result {
  return {
    index: { ...coldIndex(), state: "unavailable", stale: false },
    status: ContextFederation.status.blocked({
      graph: "code",
      state: "unavailable",
      reasonCode: "source_disabled",
      revisions: [{ source: "code_graph", state: "unavailable", reasonCode: "source_disabled" }],
    }),
    consistency: request.consistency,
    freshnessSatisfied: false,
    enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
    hits: [],
    truncated: false,
  }
}

function denied(request: CodeQuery.Request, reasonCode: "scope_denied" | "provider_egress_denied"): CodeQuery.Result {
  return {
    index: { ...coldIndex(), state: "unavailable", stale: false },
    status: ContextFederation.status.blocked({
      graph: "code",
      state: "denied",
      reasonCode,
      revisions: [{ source: "code_graph", state: "denied", reasonCode }],
    }),
    consistency: request.consistency,
    freshnessSatisfied: false,
    enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable", reasonCode },
    hits: [],
    truncated: false,
  }
}
