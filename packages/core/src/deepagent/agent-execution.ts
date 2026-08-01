export * as AgentExecution from "./agent-execution"

import { Context, Effect, Layer } from "effect"
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEvent } from "./deepagent-event"
import { AgentExecutionLockTable, AgentExecutionTable, AgentTokenDebitTable } from "./agent-execution-sql"

export const DEFAULT_LEASE_MS = 30_000

export interface Key {
  readonly workspaceID: string
  readonly eventID: DeepAgentEvent.ID
  readonly taskID: string
}

export interface Record extends Key {
  readonly status: "available" | "running" | "handoff_pending" | "completed" | "failed"
  readonly ownerID?: string
  readonly generation: number
  readonly agentID?: string
  readonly assignedAgentID?: string
  readonly leaseExpiresAt?: number
  readonly continuationRef?: string
  readonly artifacts: ReadonlyArray<string>
  readonly tokensUsed: number
  readonly lastError?: string
  readonly handoffID?: string
  readonly handoffToAgentID?: string
  readonly handoffReason?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type ClaimResult =
  | { readonly type: "claimed"; readonly record: Record }
  | {
      readonly type: "busy" | "resource_locked" | "assigned_elsewhere" | "handoff_pending" | "completed" | "failed"
      readonly record?: Record
    }

export interface Interface {
  readonly get: (key: Key) => Effect.Effect<Record | undefined>
  readonly claim: (
    input: Key & {
      readonly ownerID: string
      readonly agentID: string
      readonly resources?: ReadonlyArray<string>
      readonly leaseMs?: number
    },
  ) => Effect.Effect<ClaimResult>
  readonly renew: (
    input: Key & {
      readonly ownerID: string
      readonly generation: number
      readonly leaseMs?: number
    },
  ) => Effect.Effect<boolean>
  readonly complete: (
    input: Key & {
      readonly ownerID: string
      readonly generation: number
      readonly continuationRef?: string
      readonly artifacts?: ReadonlyArray<string>
      readonly tokensUsed?: number
      readonly tokenAt?: number
      readonly tokenWindowMs?: number
    },
  ) => Effect.Effect<boolean>
  readonly release: (
    input: Key & {
      readonly ownerID: string
      readonly generation: number
      readonly retryable: boolean
      readonly reason: string
      readonly tokensUsed?: number
      readonly tokenAt?: number
      readonly tokenWindowMs?: number
    },
  ) => Effect.Effect<boolean>
  readonly prepareHandoff: (
    input: Key & {
      readonly ownerID: string
      readonly generation: number
      readonly handoffID: string
      readonly toAgentID: string
      readonly reason: string
      readonly continuationRef?: string
      readonly tokensUsed?: number
      readonly tokenAt?: number
      readonly tokenWindowMs?: number
    },
  ) => Effect.Effect<Record | undefined>
  readonly acceptHandoff: (
    input: Key & {
      readonly handoffID: string
      readonly generation: number
      readonly fromAgentID: string
      readonly toAgentID: string
    },
  ) => Effect.Effect<boolean>
  readonly rejectHandoff: (
    input: Key & {
      readonly handoffID: string
      readonly generation: number
      readonly fromAgentID: string
      readonly toAgentID: string
      readonly reason: string
    },
  ) => Effect.Effect<boolean>
  readonly tokensUsed: (input: {
    readonly workspaceID: string
    readonly agentID: string
    readonly at: number
    readonly windowMs: number
  }) => Effect.Effect<number>
  readonly debitTokens: (input: {
    readonly workspaceID: string
    readonly agentID: string
    readonly tokens: number
    readonly at: number
    readonly windowMs: number
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/AgentExecution") {}

export interface LayerOptions {
  readonly now?: () => number
}

const whereKey = (key: Key) =>
  and(
    eq(AgentExecutionTable.workspace_id, key.workspaceID),
    eq(AgentExecutionTable.event_id, key.eventID),
    eq(AgentExecutionTable.task_id, key.taskID),
  )

const decode = (row: typeof AgentExecutionTable.$inferSelect): Record => ({
  workspaceID: row.workspace_id,
  eventID: row.event_id,
  taskID: row.task_id,
  status: row.status,
  ...(row.owner_id ? { ownerID: row.owner_id } : {}),
  generation: row.generation,
  ...(row.agent_id ? { agentID: row.agent_id } : {}),
  ...(row.assigned_agent_id ? { assignedAgentID: row.assigned_agent_id } : {}),
  ...(row.lease_expires_at != null ? { leaseExpiresAt: row.lease_expires_at } : {}),
  ...(row.continuation_ref ? { continuationRef: row.continuation_ref } : {}),
  artifacts: row.artifacts,
  tokensUsed: row.tokens_used,
  ...(row.last_error ? { lastError: row.last_error } : {}),
  ...(row.handoff_id ? { handoffID: row.handoff_id } : {}),
  ...(row.handoff_to_agent_id ? { handoffToAgentID: row.handoff_to_agent_id } : {}),
  ...(row.handoff_reason ? { handoffReason: row.handoff_reason } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const tokenWindowStart = (at: number, windowMs: number) => Math.floor(at / windowMs) * windowMs

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now

      const get: Interface["get"] = (key) =>
        db
          .select()
          .from(AgentExecutionTable)
          .where(whereKey(key))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row ? decode(row) : undefined)),
          )

      const claim: Interface["claim"] = (input) =>
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const at = now()
                const existing = yield* tx
                  .select()
                  .from(AgentExecutionTable)
                  .where(whereKey(input))
                  .get()
                  .pipe(Effect.orDie)
                if (existing?.status === "completed") return { type: "completed", record: decode(existing) } as const
                if (existing?.status === "failed") return { type: "failed", record: decode(existing) } as const
                if (existing?.status === "handoff_pending")
                  return { type: "handoff_pending", record: decode(existing) } as const
                if (existing?.status === "running" && (existing.lease_expires_at ?? 0) > at)
                  return { type: "busy", record: decode(existing) } as const
                if (existing?.assigned_agent_id && existing.assigned_agent_id !== input.agentID)
                  return { type: "assigned_elsewhere", record: decode(existing) } as const

                yield* tx
                  .delete(AgentExecutionLockTable)
                  .where(lte(AgentExecutionLockTable.lease_expires_at, at))
                  .run()
                  .pipe(Effect.orDie)
                if (existing) {
                  yield* tx
                    .delete(AgentExecutionLockTable)
                    .where(
                      and(
                        eq(AgentExecutionLockTable.workspace_id, input.workspaceID),
                        eq(AgentExecutionLockTable.event_id, input.eventID),
                        eq(AgentExecutionLockTable.task_id, input.taskID),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                }

                const resources = [...new Set(input.resources ?? [])].sort()
                if (resources.length > 0) {
                  const locks = yield* tx
                    .select()
                    .from(AgentExecutionLockTable)
                    .where(
                      and(
                        eq(AgentExecutionLockTable.workspace_id, input.workspaceID),
                        inArray(AgentExecutionLockTable.resource_key, resources),
                        gt(AgentExecutionLockTable.lease_expires_at, at),
                      ),
                    )
                    .all()
                    .pipe(Effect.orDie)
                  if (locks.length > 0) return { type: "resource_locked" } as const
                }

                const generation = (existing?.generation ?? 0) + 1
                const leaseExpiresAt = at + (input.leaseMs ?? DEFAULT_LEASE_MS)
                const values = {
                  workspace_id: input.workspaceID,
                  event_id: input.eventID,
                  task_id: input.taskID,
                  status: "running" as const,
                  owner_id: input.ownerID,
                  generation,
                  agent_id: input.agentID,
                  assigned_agent_id: existing?.assigned_agent_id ?? input.agentID,
                  lease_expires_at: leaseExpiresAt,
                  continuation_ref: existing?.continuation_ref ?? null,
                  artifacts: existing?.artifacts ?? [],
                  tokens_used: existing?.tokens_used ?? 0,
                  last_error: null,
                  handoff_id: existing?.handoff_id ?? null,
                  handoff_to_agent_id: null,
                  handoff_reason: null,
                  created_at: existing?.created_at ?? at,
                  updated_at: at,
                }
                const row = existing
                  ? yield* tx
                      .update(AgentExecutionTable)
                      .set(values)
                      .where(whereKey(input))
                      .returning()
                      .get()
                      .pipe(Effect.orDie)
                  : yield* tx.insert(AgentExecutionTable).values(values).returning().get().pipe(Effect.orDie)
                if (resources.length > 0) {
                  yield* tx
                    .insert(AgentExecutionLockTable)
                    .values(
                      resources.map((resource) => ({
                        workspace_id: input.workspaceID,
                        resource_key: resource,
                        event_id: input.eventID,
                        task_id: input.taskID,
                        owner_id: input.ownerID,
                        generation,
                        lease_expires_at: leaseExpiresAt,
                      })),
                    )
                    .run()
                    .pipe(Effect.orDie)
                }
                return { type: "claimed", record: decode(row) } as const
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)

      const renew: Interface["renew"] = (input) =>
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const at = now()
                const leaseExpiresAt = at + (input.leaseMs ?? DEFAULT_LEASE_MS)
                const updated = yield* tx
                  .update(AgentExecutionTable)
                  .set({ lease_expires_at: leaseExpiresAt, updated_at: at })
                  .where(
                    and(
                      whereKey(input),
                      eq(AgentExecutionTable.status, "running"),
                      eq(AgentExecutionTable.owner_id, input.ownerID),
                      eq(AgentExecutionTable.generation, input.generation),
                      gt(AgentExecutionTable.lease_expires_at, at),
                    ),
                  )
                  .returning({ task_id: AgentExecutionTable.task_id })
                  .get()
                  .pipe(Effect.orDie)
                if (!updated) return false
                yield* tx
                  .update(AgentExecutionLockTable)
                  .set({ lease_expires_at: leaseExpiresAt })
                  .where(
                    and(
                      eq(AgentExecutionLockTable.workspace_id, input.workspaceID),
                      eq(AgentExecutionLockTable.event_id, input.eventID),
                      eq(AgentExecutionLockTable.task_id, input.taskID),
                      eq(AgentExecutionLockTable.owner_id, input.ownerID),
                      eq(AgentExecutionLockTable.generation, input.generation),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
                return true
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)

      const settle = (
        input: Key & {
          readonly ownerID: string
          readonly generation: number
          readonly status: "available" | "completed" | "failed"
          readonly reason?: string
          readonly continuationRef?: string
          readonly artifacts?: ReadonlyArray<string>
          readonly tokensUsed?: number
          readonly tokenAt?: number
          readonly tokenWindowMs?: number
        },
      ) =>
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const at = now()
                const updated = yield* tx
                  .update(AgentExecutionTable)
                  .set({
                    status: input.status,
                    owner_id: null,
                    lease_expires_at: null,
                    ...(input.status === "available" ? {} : { assigned_agent_id: null }),
                    ...(input.continuationRef !== undefined ? { continuation_ref: input.continuationRef } : {}),
                    ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
                    ...(input.tokensUsed !== undefined ? { tokens_used: input.tokensUsed } : {}),
                    last_error: input.reason ?? null,
                    updated_at: at,
                  })
                  .where(
                    and(
                      whereKey(input),
                      eq(AgentExecutionTable.status, "running"),
                      eq(AgentExecutionTable.owner_id, input.ownerID),
                      eq(AgentExecutionTable.generation, input.generation),
                      gt(AgentExecutionTable.lease_expires_at, at),
                    ),
                  )
                  .returning({ task_id: AgentExecutionTable.task_id, agent_id: AgentExecutionTable.agent_id })
                  .get()
                  .pipe(Effect.orDie)
                if (!updated) return false
                if (
                  updated.agent_id &&
                  input.tokensUsed !== undefined &&
                  input.tokensUsed > 0 &&
                  input.tokenAt !== undefined &&
                  input.tokenWindowMs !== undefined
                ) {
                  yield* tx
                    .insert(AgentTokenDebitTable)
                    .values({
                      workspace_id: input.workspaceID,
                      agent_id: updated.agent_id,
                      window_start: tokenWindowStart(input.tokenAt, input.tokenWindowMs),
                      tokens_used: input.tokensUsed,
                      updated_at: input.tokenAt,
                    })
                    .onConflictDoUpdate({
                      target: [
                        AgentTokenDebitTable.workspace_id,
                        AgentTokenDebitTable.agent_id,
                        AgentTokenDebitTable.window_start,
                      ],
                      set: {
                        tokens_used: sql`${AgentTokenDebitTable.tokens_used} + ${input.tokensUsed}`,
                        updated_at: input.tokenAt,
                      },
                    })
                    .run()
                    .pipe(Effect.orDie)
                }
                yield* tx
                  .delete(AgentExecutionLockTable)
                  .where(
                    and(
                      eq(AgentExecutionLockTable.workspace_id, input.workspaceID),
                      eq(AgentExecutionLockTable.event_id, input.eventID),
                      eq(AgentExecutionLockTable.task_id, input.taskID),
                      eq(AgentExecutionLockTable.owner_id, input.ownerID),
                      eq(AgentExecutionLockTable.generation, input.generation),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
                return true
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)

      const complete: Interface["complete"] = (input) =>
        settle({ ...input, status: "completed", tokensUsed: input.tokensUsed ?? 0 })

      const release: Interface["release"] = (input) =>
        settle({ ...input, status: input.retryable ? "available" : "failed", reason: input.reason })

      const prepareHandoff: Interface["prepareHandoff"] = (input) =>
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const at = now()
                const row = yield* tx
                  .update(AgentExecutionTable)
                  .set({
                    status: "handoff_pending",
                    owner_id: null,
                    lease_expires_at: null,
                    ...(input.continuationRef ? { continuation_ref: input.continuationRef } : {}),
                    last_error: input.reason,
                    handoff_id: input.handoffID,
                    handoff_to_agent_id: input.toAgentID,
                    handoff_reason: input.reason,
                    updated_at: at,
                  })
                  .where(
                    and(
                      whereKey(input),
                      eq(AgentExecutionTable.status, "running"),
                      eq(AgentExecutionTable.owner_id, input.ownerID),
                      eq(AgentExecutionTable.generation, input.generation),
                      gt(AgentExecutionTable.lease_expires_at, at),
                    ),
                  )
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                if (!row) return undefined
                if (
                  row.agent_id &&
                  input.tokensUsed !== undefined &&
                  input.tokensUsed > 0 &&
                  input.tokenAt !== undefined &&
                  input.tokenWindowMs !== undefined
                ) {
                  yield* tx
                    .insert(AgentTokenDebitTable)
                    .values({
                      workspace_id: input.workspaceID,
                      agent_id: row.agent_id,
                      window_start: tokenWindowStart(input.tokenAt, input.tokenWindowMs),
                      tokens_used: input.tokensUsed,
                      updated_at: input.tokenAt,
                    })
                    .onConflictDoUpdate({
                      target: [
                        AgentTokenDebitTable.workspace_id,
                        AgentTokenDebitTable.agent_id,
                        AgentTokenDebitTable.window_start,
                      ],
                      set: {
                        tokens_used: sql`${AgentTokenDebitTable.tokens_used} + ${input.tokensUsed}`,
                        updated_at: input.tokenAt,
                      },
                    })
                    .run()
                    .pipe(Effect.orDie)
                }
                yield* tx
                  .delete(AgentExecutionLockTable)
                  .where(
                    and(
                      eq(AgentExecutionLockTable.workspace_id, input.workspaceID),
                      eq(AgentExecutionLockTable.event_id, input.eventID),
                      eq(AgentExecutionLockTable.task_id, input.taskID),
                      eq(AgentExecutionLockTable.owner_id, input.ownerID),
                      eq(AgentExecutionLockTable.generation, input.generation),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
                return decode(row)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)

      const acceptHandoff: Interface["acceptHandoff"] = (input) =>
        db
          .update(AgentExecutionTable)
          .set({
            status: "available",
            agent_id: null,
            assigned_agent_id: input.toAgentID,
            owner_id: null,
            lease_expires_at: null,
            updated_at: now(),
          })
          .where(
            and(
              whereKey(input),
              eq(AgentExecutionTable.status, "handoff_pending"),
              eq(AgentExecutionTable.generation, input.generation),
              eq(AgentExecutionTable.agent_id, input.fromAgentID),
              eq(AgentExecutionTable.handoff_id, input.handoffID),
              eq(AgentExecutionTable.handoff_to_agent_id, input.toAgentID),
            ),
          )
          .returning({ task_id: AgentExecutionTable.task_id })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row !== undefined),
          )

      const rejectHandoff: Interface["rejectHandoff"] = (input) =>
        db
          .update(AgentExecutionTable)
          .set({
            status: "failed",
            assigned_agent_id: null,
            owner_id: null,
            lease_expires_at: null,
            last_error: input.reason,
            updated_at: now(),
          })
          .where(
            and(
              whereKey(input),
              eq(AgentExecutionTable.status, "handoff_pending"),
              eq(AgentExecutionTable.generation, input.generation),
              eq(AgentExecutionTable.agent_id, input.fromAgentID),
              eq(AgentExecutionTable.handoff_id, input.handoffID),
              eq(AgentExecutionTable.handoff_to_agent_id, input.toAgentID),
            ),
          )
          .returning({ task_id: AgentExecutionTable.task_id })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row !== undefined),
          )

      const tokensUsed: Interface["tokensUsed"] = (input) =>
        db
          .select({ tokens_used: AgentTokenDebitTable.tokens_used })
          .from(AgentTokenDebitTable)
          .where(
            and(
              eq(AgentTokenDebitTable.workspace_id, input.workspaceID),
              eq(AgentTokenDebitTable.agent_id, input.agentID),
              eq(AgentTokenDebitTable.window_start, tokenWindowStart(input.at, input.windowMs)),
            ),
          )
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.tokens_used ?? 0),
          )

      const debitTokens: Interface["debitTokens"] = (input) => {
        if (input.tokens <= 0) return Effect.void
        const start = tokenWindowStart(input.at, input.windowMs)
        return db
          .insert(AgentTokenDebitTable)
          .values({
            workspace_id: input.workspaceID,
            agent_id: input.agentID,
            window_start: start,
            tokens_used: input.tokens,
            updated_at: input.at,
          })
          .onConflictDoUpdate({
            target: [
              AgentTokenDebitTable.workspace_id,
              AgentTokenDebitTable.agent_id,
              AgentTokenDebitTable.window_start,
            ],
            set: {
              tokens_used: sql`${AgentTokenDebitTable.tokens_used} + ${input.tokens}`,
              updated_at: input.at,
            },
          })
          .run()
          .pipe(Effect.orDie, Effect.asVoid)
      }

      return Service.of({
        get,
        claim,
        renew,
        complete,
        release,
        prepareHandoff,
        acceptHandoff,
        rejectHandoff,
        tokensUsed,
        debitTokens,
      })
    }),
  )

export const layer = layerWith()
export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
