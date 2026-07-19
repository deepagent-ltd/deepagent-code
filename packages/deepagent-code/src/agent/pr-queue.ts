import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { writeFileAtomic } from "@deepagent-code/core/deepagent/atomic-write"

export namespace PRQueue {
  export const statuses = [
    "draft",
    "awaiting_review",
    "changes_requested",
    "approved",
    "merging",
    "merged",
    "conflicted",
    "rejected",
    "superseded",
  ] as const

  export type Status = (typeof statuses)[number]
  export type Verdict = "approved" | "changes_requested"
  export type ID = string

  export class PRQueueError extends Schema.TaggedErrorClass<PRQueueError>()("PRQueueError", {
    operation: Schema.Literals(["load", "persist", "duplicate"]),
    message: Schema.String,
  }) {}

  export interface Entry {
    readonly id: ID
    readonly parentID: string
    readonly workerID: string
    readonly reviewerID: string
    readonly sha: string
    readonly metadata?: Record<string, unknown>
    readonly findings: readonly string[]
    readonly mergeDiagnostic?: string
    readonly workerHead?: string
    readonly status: Status
    readonly redoCount: number
    readonly createdAt: number
    readonly updatedAt: number
  }

  export interface CreateInput {
    readonly id: ID
    readonly parentID: string
    readonly workerID: string
    readonly reviewerID: string
    readonly sha: string
    readonly metadata?: Record<string, unknown>
    readonly findings?: readonly string[]
    readonly workerHead?: string
  }

  export interface Interface {
    readonly create: (input: CreateInput) => Effect.Effect<Entry, PRQueueError>
    readonly get: (id: ID) => Effect.Effect<Entry | null, PRQueueError>
    readonly list: () => Effect.Effect<ReadonlyArray<Entry>, PRQueueError>
    /** Claims the oldest waiting review owned by this parent, in FIFO creation order. */
    readonly claimForReview: (parentID: string) => Effect.Effect<Entry | null, PRQueueError>
    /** The owning worker alone may publish a new SHA after a requested revision. */
    readonly resubmit: (input: {
      readonly id: ID
      readonly workerID: string
      readonly sha: string
      readonly workerHead?: string
      readonly findings?: readonly string[]
    }) => Effect.Effect<Entry | null, PRQueueError>
    /** The assigned reviewer may decide only the exact SHA currently awaiting review. */
    readonly verdict: (input: {
      readonly id: ID
      readonly reviewerID: string
      readonly sha: string
      readonly verdict: Verdict
    }) => Effect.Effect<Entry | null, PRQueueError>
    /** Acquires the sole merge lease. A parent may merge at most one queue entry at a time. */
    readonly claimMerge: (input: { readonly id: ID; readonly parentID: string }) => Effect.Effect<Entry | null, PRQueueError>
    readonly completeMerge: (input: { readonly id: ID; readonly parentID: string }) => Effect.Effect<Entry | null, PRQueueError>
    readonly conflictMerge: (input: { readonly id: ID; readonly parentID: string; readonly diagnostic?: string }) => Effect.Effect<Entry | null, PRQueueError>
    readonly supersede: (id: ID) => Effect.Effect<Entry | null, PRQueueError>
  }

  export class Service extends Context.Service<Service, Interface>()("@deepagent-code/PRQueue") {}

  export const stateDirectory = (): string => path.join(Global.Path.data, "agent-gateway", "state", "pr-queue")
  export const stateFile = (): string => path.join(stateDirectory(), "queue.json")

  type State = { readonly entries: ReadonlyArray<Entry> }

  const empty: State = { entries: [] }
  const terminal = new Set<Status>(["merged", "conflicted", "rejected", "superseded"])
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  const isStatus = (value: unknown): value is Status => typeof value === "string" && statuses.includes(value as Status)
  const isEntry = (value: unknown): value is Entry =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.parentID === "string" &&
    typeof value.workerID === "string" &&
    typeof value.reviewerID === "string" &&
    typeof value.sha === "string" &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    Array.isArray(value.findings) &&
    value.findings.every((finding) => typeof finding === "string") &&
    (value.mergeDiagnostic === undefined || typeof value.mergeDiagnostic === "string") &&
    (value.workerHead === undefined || typeof value.workerHead === "string") &&
    isStatus(value.status) &&
    typeof value.redoCount === "number" &&
    Number.isInteger(value.redoCount) &&
    value.redoCount >= 0 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)

  const decode = (value: unknown): State => {
    if (!isRecord(value) || !Array.isArray(value.entries) || !value.entries.every(isEntry)) {
      throw new Error("Invalid PR queue state")
    }
    const ids = new Set<string>()
    if (value.entries.some((entry) => ids.has(entry.id) || (ids.add(entry.id), false))) {
      throw new Error("PR queue state contains duplicate entry ids")
    }
    return { entries: value.entries }
  }

  const read = (): Effect.Effect<State, PRQueueError> =>
    Effect.tryPromise({
      try: async () => {
        try {
          return decode(JSON.parse(await fs.readFile(stateFile(), "utf8")))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty
          throw error
        }
      },
      catch: (cause) => new PRQueueError({ operation: "load", message: `Unable to load PR queue: ${String(cause)}` }),
    })

  const persist = (state: State): Effect.Effect<void, PRQueueError> =>
    Effect.try({
      try: () => {
        fsSync.mkdirSync(stateDirectory(), { recursive: true })
        writeFileAtomic(stateFile(), JSON.stringify(state, null, 2))
      },
      catch: (cause) => new PRQueueError({ operation: "persist", message: `Unable to persist PR queue: ${String(cause)}` }),
    })

  const copy = (entry: Entry): Entry => ({ ...entry })
  const publicState = (state: State): ReadonlyArray<Entry> => state.entries.map(copy)

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const ref = yield* SynchronizedRef.make(yield* read())

      const mutate = <A>(f: (state: State) => readonly [A, State]): Effect.Effect<A, PRQueueError> =>
        SynchronizedRef.modifyEffect(
          ref,
          Effect.fnUntraced(function* (state) {
            const [value, next] = f(state)
            if (next !== state) yield* persist(next)
            return [value, next] as const
          }),
        )

      const update = (id: ID, f: (entry: Entry) => Entry | null): Effect.Effect<Entry | null, PRQueueError> =>
        mutate((state) => {
          const index = state.entries.findIndex((entry) => entry.id === id)
          if (index < 0) return [null, state]
          const current = state.entries[index]!
          const nextEntry = f(current)
          if (!nextEntry) return [null, state]
          const entries = [...state.entries]
          entries[index] = nextEntry
          return [copy(nextEntry), { entries }]
        })

      const create: Interface["create"] = (input) =>
        mutate((state) => {
          if (state.entries.some((entry) => entry.id === input.id)) return [null, state]
          const now = Date.now()
          const entry: Entry = {
            ...input,
            findings: input.findings ?? [],
            status: "draft",
            redoCount: 0,
            createdAt: now,
            updatedAt: now,
          }
          return [copy(entry), { entries: [...state.entries, entry] }]
        }).pipe(
          Effect.flatMap((entry) =>
            entry
              ? Effect.succeed(entry)
              : Effect.fail(
                  new PRQueueError({ operation: "duplicate", message: `PR queue id already exists: ${input.id}` }),
                ),
          ),
        )

      const get: Interface["get"] = (id) =>
        SynchronizedRef.get(ref).pipe(
          Effect.map((state) => state.entries.find((entry) => entry.id === id)),
          Effect.map((entry) => (entry ? copy(entry) : null)),
        )

      const list: Interface["list"] = () => SynchronizedRef.get(ref).pipe(Effect.map(publicState))

      const claimForReview: Interface["claimForReview"] = (parentID) =>
        mutate((state) => {
          const candidate = state.entries
            .filter((entry) => entry.parentID === parentID && entry.status === "draft")
            .sort((a, b) => a.createdAt - b.createdAt)[0]
          if (!candidate) return [null, state]
          const next = { ...candidate, status: "awaiting_review" as const, updatedAt: Date.now() }
          return [copy(next), { entries: state.entries.map((entry) => (entry.id === next.id ? next : entry)) }]
        })

      const resubmit: Interface["resubmit"] = ({ id, workerID, sha, workerHead, findings }) =>
        update(id, (entry) =>
          (entry.status === "changes_requested" || (entry.status === "draft" && !entry.workerHead)) &&
          entry.workerID === workerID &&
          sha.length > 0
            ? {
                ...entry,
                sha,
                ...(workerHead ? { workerHead } : {}),
                ...(findings ? { findings: [...findings] } : {}),
                status: "draft",
                updatedAt: Date.now(),
              }
            : null,
        )

      const verdict: Interface["verdict"] = ({ id, reviewerID, sha, verdict }) =>
        update(id, (entry) => {
          if (entry.status !== "awaiting_review" || entry.reviewerID !== reviewerID || entry.sha !== sha) return null
          if (verdict === "approved") return { ...entry, status: "approved", updatedAt: Date.now() }
          const redoCount = entry.redoCount + 1
          return {
            ...entry,
            redoCount,
            status: redoCount > 3 ? "rejected" : "changes_requested",
            updatedAt: Date.now(),
          }
        })

      const claimMerge: Interface["claimMerge"] = ({ id, parentID }) =>
        mutate((state) => {
          const entry = state.entries.find((candidate) => candidate.id === id)
          if (!entry || entry.parentID !== parentID || entry.status !== "approved") return [null, state]
          if (state.entries.some((candidate) => candidate.parentID === parentID && candidate.status === "merging")) {
            return [null, state]
          }
          const next = { ...entry, status: "merging" as const, updatedAt: Date.now() }
          return [copy(next), { entries: state.entries.map((candidate) => (candidate.id === id ? next : candidate)) }]
        })

      const finishMerge = (id: ID, parentID: string, status: "merged" | "conflicted", mergeDiagnostic?: string) =>
        update(id, (entry) =>
          entry.parentID === parentID && entry.status === "merging"
            ? { ...entry, status, ...(mergeDiagnostic ? { mergeDiagnostic } : {}), updatedAt: Date.now() }
            : null,
        )

      const supersede: Interface["supersede"] = (id) =>
        update(id, (entry) =>
          !terminal.has(entry.status) && entry.status !== "merging" ? { ...entry, status: "superseded", updatedAt: Date.now() } : null,
        )

      return Service.of({
        create,
        get,
        list,
        claimForReview,
        resubmit,
        verdict,
        claimMerge,
        completeMerge: ({ id, parentID }) => finishMerge(id, parentID, "merged"),
        conflictMerge: ({ id, parentID, diagnostic }) => finishMerge(id, parentID, "conflicted", diagnostic),
        supersede,
      })
    }),
  )
}
