export * as FederatedContextResolver from "./resolver"

import { Context, Effect, Layer } from "effect"
import type { EgressPolicy, Principal } from "./authorization"
import { type Adapter, type Query, type Result as AdapterResult } from "./adapters"
import {
  queryPlan,
  rank,
  status,
  type ContextCandidate,
  type GraphQueryStatus,
  type RankedCandidate,
} from "./federation"
import { ContextLinkStore } from "./link-store"
import type { GraphKind } from "./contract"
import type { ContextRef, ProjectScopeKey, SecurityNamespaceID } from "./reference"

const GraphOrder = ["code", "documents", "knowledge", "memory"] as const

export type Input = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly projectScopeKey: ProjectScopeKey
  readonly principal: Principal
  readonly egress: EgressPolicy
  readonly text: string
  readonly entityIds?: readonly string[]
  readonly relations?: readonly ContextLinkStore.Relation[]
  readonly limit?: number
  readonly toolCall: boolean
  readonly now?: number
}

export type QueryResult = {
  readonly plan: ReturnType<typeof queryPlan>
  readonly statuses: readonly GraphQueryStatus[]
  readonly candidates: Readonly<Partial<Record<GraphKind, readonly ContextCandidate[]>>>
  readonly ranked: readonly RankedCandidate[]
  readonly relationPaths: ReadonlyMap<string, readonly RelationStep[]>
  readonly linkRefreshPending: boolean
}

export type RelationStep = {
  readonly relation: string
  readonly ref: ContextRef
  readonly freshness: "exact"
}

export type ShadowResult = QueryResult & { readonly mode: "shadow" }

export interface Interface {
  readonly query: (input: Input) => Effect.Effect<QueryResult>
  readonly queryShadow: (input: Input) => Effect.Effect<ShadowResult>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/FederatedContextResolver") {}

export function layer(config: { readonly adapters: readonly Adapter[]; readonly perGraphTimeoutMs: number }) {
  if (!Number.isSafeInteger(config.perGraphTimeoutMs) || config.perGraphTimeoutMs <= 0)
    throw new Error("invalid timeout")
  const adapters = new Map(config.adapters.map((adapter) => [adapter.graph, adapter]))
  if (adapters.size !== config.adapters.length) throw new Error("one adapter per graph is required")
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const links = yield* ContextLinkStore.Service

      const query = Effect.fn("FederatedContextResolver.query")(function* (input: Input) {
        const plan = queryPlan({ text: input.text, hasExplicitRef: Boolean(input.entityIds?.length) })
        const queried = yield* Effect.forEach(
          GraphOrder,
          (graph) => {
            const adapter = adapters.get(graph)
            if (!adapter) {
              return Effect.succeed({ graph, result: { candidates: [], status: status.notQueried(graph) } })
            }
            const query: Query = {
              text: input.text,
              ...(input.entityIds ? { entityIds: input.entityIds } : {}),
              limit: Math.min(input.limit ?? 12, 100),
              now: input.now,
            }
            return adapter.query(query).pipe(
              Effect.timeout(config.perGraphTimeoutMs),
              Effect.catch(() =>
                Effect.succeed({
                  candidates: [],
                  status: status.partial({
                    graph,
                    state: "degraded",
                    reasonCode: "source_timeout",
                    revisions: [{ source: adapter.source, state: "degraded", reasonCode: "source_timeout" }],
                  }),
                }),
              ),
              Effect.map((result) => ({ graph, result })),
            )
          },
          { concurrency: "unbounded" },
        )
        const initial = Object.fromEntries(queried.map((entry) => [entry.graph, entry.result.candidates])) as Partial<
          Record<GraphKind, readonly ContextCandidate[]>
        >
        const preliminary = rank(initial, { weights: plan.weights, toolCall: input.toolCall, limit: input.limit })
        const expanded = yield* expand({
          frontier: preliminary.map((item) => item.candidate),
          accumulated: initial,
          depth: 2,
          refreshPending: false,
          input,
          adapters,
          links,
          relationPaths: new Map(),
        })
        const statuses = queried.map((entry) =>
          expanded.refreshGraphs.has(entry.graph)
            ? partialForLinkRefresh(entry.graph, entry.result)
            : entry.result.status,
        )
        return {
          plan,
          statuses,
          candidates: expanded.accumulated,
          ranked: rank(expanded.accumulated, { weights: plan.weights, toolCall: input.toolCall, limit: input.limit }),
          relationPaths: expanded.relationPaths,
          linkRefreshPending: expanded.refreshPending,
        }
      })

      const queryShadow: Interface["queryShadow"] = (input) => query(input).pipe(
        Effect.map((result) => ({ ...result, mode: "shadow" as const })),
      )

      return Service.of({ query, queryShadow })
    }),
  )
}

function expand(input: {
  readonly frontier: readonly ContextCandidate[]
  readonly accumulated: Readonly<Partial<Record<GraphKind, readonly ContextCandidate[]>>>
  readonly depth: number
  readonly refreshPending: boolean
  readonly refreshGraphs?: ReadonlySet<GraphKind>
  readonly input: Input
  readonly adapters: ReadonlyMap<GraphKind, Adapter>
  readonly links: ContextLinkStore.Interface
  readonly relationPaths: ReadonlyMap<string, readonly RelationStep[]>
}): Effect.Effect<{
  readonly accumulated: Readonly<Partial<Record<GraphKind, readonly ContextCandidate[]>>>
  readonly refreshPending: boolean
  readonly refreshGraphs: ReadonlySet<GraphKind>
  readonly relationPaths: ReadonlyMap<string, readonly RelationStep[]>
}> {
  if (input.depth === 0 || input.frontier.length === 0) {
    return Effect.succeed({
      accumulated: input.accumulated,
      refreshPending: input.refreshPending,
      refreshGraphs: input.refreshGraphs ?? new Set(),
      relationPaths: input.relationPaths,
    })
  }
  return Effect.gen(function* () {
    const neighborhoods = yield* Effect.forEach(
      input.frontier.slice(0, 8),
      (seed) =>
        input.links
          .neighbors({
            securityNamespaceId: input.input.securityNamespaceId,
            projectScopeKey: input.input.projectScopeKey,
            ref: seed.ref,
            principal: input.input.principal,
            egress: input.input.egress,
            ...(input.input.relations ? { relations: input.input.relations } : {}),
            limit: 8,
            now: input.input.now,
          })
          .pipe(
            Effect.catch(() => Effect.succeed({ links: [], refreshPending: false })),
            Effect.map((result) => ({ seed, result })),
          ),
      { concurrency: "unbounded" },
    )
    const refreshGraphs = new Set(input.refreshGraphs ?? [])
    neighborhoods.filter((item) => item.result.refreshPending).forEach((item) => refreshGraphs.add(item.seed.graph))
    const targets = new Map<string, { readonly graph: GraphKind; readonly entityId: string }>()
    const relationPaths = new Map(input.relationPaths)
    neighborhoods.forEach((item) =>
      item.result.links.forEach((link) => {
        const target = link.direction === "forward" ? link.to : link.from
        targets.set(`${target.graph}:${target.entityId}`, { graph: target.graph, entityId: target.entityId })
        const targetKey = `${target.graph}:${target.entityId}:${target.revision}`
        if (!relationPaths.has(targetKey)) {
          relationPaths.set(targetKey, [
            ...(input.relationPaths.get(key(item.seed)) ?? []),
            { relation: link.relation, ref: target, freshness: "exact" as const },
          ])
        }
      }),
    )
    const materialized = yield* Effect.forEach(
      GraphOrder,
      (graph) => {
        const ids = [...targets.values()].filter((target) => target.graph === graph).map((target) => target.entityId)
        const adapter = input.adapters.get(graph)
        if (!adapter || ids.length === 0) return Effect.succeed([] as readonly ContextCandidate[])
        return adapter.query({ text: input.input.text, entityIds: ids, limit: 8, now: input.input.now }).pipe(
          Effect.map((result) => result.candidates.filter((candidate) => ids.includes(candidate.ref.entityId))),
          Effect.catch(() => Effect.succeed([])),
        )
      },
      { concurrency: "unbounded" },
    )
    const next = materialized.flat()
    const accumulated = Object.fromEntries(
      GraphOrder.map((graph, index) => [graph, dedupe([...(input.accumulated[graph] ?? []), ...materialized[index]!])]),
    )
    const seen = new Set(
      Object.values(input.accumulated)
        .flat()
        .map((candidate) => key(candidate)),
    )
    return yield* expand({
      ...input,
      frontier: next.filter((candidate) => !seen.has(key(candidate))),
      accumulated,
      depth: input.depth - 1,
      refreshPending: input.refreshPending || neighborhoods.some((item) => item.result.refreshPending),
      refreshGraphs,
      relationPaths,
    })
  })
}

function partialForLinkRefresh(graph: GraphKind, result: AdapterResult) {
  if (result.status.kind === "blocked" || result.status.kind === "not_queried") return result.status
  return status.partial({
    graph,
    state: "degraded",
    reasonCode: "link_refresh_pending",
    revisions: [
      ...result.status.revisions,
      { source: "context_links", state: "degraded", reasonCode: "link_refresh_pending" },
    ],
  })
}

function dedupe(candidates: readonly ContextCandidate[]) {
  return [...new Map(candidates.map((candidate) => [key(candidate), candidate])).values()]
}

function key(candidate: ContextCandidate) {
  return `${candidate.graph}:${candidate.ref.entityId}:${candidate.ref.revision}`
}
