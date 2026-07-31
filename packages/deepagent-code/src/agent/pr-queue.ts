import { Context, Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { writeFileAtomic } from "@deepagent-code/core/deepagent/atomic-write"
import { Flock } from "@deepagent-code/core/util/flock"

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
  export type Verdict = "approved" | "changes_requested" | "rejected"
  export type ID = string
  export type StageReview = {
    readonly status: "pending" | "approved" | "blocked"
    readonly reviewerID: string
    readonly implementationCommitSha?: string
    readonly diagnostic?: string
  }

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
    readonly claimForReview: (parentID: string, id?: ID) => Effect.Effect<Entry | null, PRQueueError>
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
    readonly claimMerge: (input: {
      readonly id: ID
      readonly parentID: string
    }) => Effect.Effect<Entry | null, PRQueueError>
    readonly refreshBaseline: (input: {
      readonly id: ID
      readonly parentID: string
      readonly parentHead: string
      readonly diagnostic: string
    }) => Effect.Effect<Entry | null, PRQueueError>
    readonly completeMerge: (input: {
      readonly id: ID
      readonly parentID: string
      readonly parentHead?: string
    }) => Effect.Effect<Entry | null, PRQueueError>
    /** Persists batch-level Senior Reviewer ownership and settlement across tool/process retries. */
    readonly setStageReview: (input: {
      readonly parentID: string
      readonly batchID: string
      readonly review: StageReview
    }) => Effect.Effect<ReadonlyArray<Entry>, PRQueueError>
    readonly conflictMerge: (input: {
      readonly id: ID
      readonly parentID: string
      readonly diagnostic?: string
    }) => Effect.Effect<Entry | null, PRQueueError>
    /** Returns a conflicting merge to its author and enforces the same three-redo ceiling as review findings. */
    readonly bounceMerge: (input: {
      readonly id: ID
      readonly parentID: string
      readonly diagnostic?: string
    }) => Effect.Effect<Entry | null, PRQueueError>
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
      catch: (cause) =>
        new PRQueueError({ operation: "persist", message: `Unable to persist PR queue: ${String(cause)}` }),
    })

  const copy = (entry: Entry): Entry => ({ ...entry })
  const publicState = (state: State): ReadonlyArray<Entry> => state.entries.map(copy)

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const mutate = <A>(f: (state: State) => readonly [A, State]): Effect.Effect<A, PRQueueError> =>
        Effect.tryPromise({
          try: (signal) =>
            Flock.withLock(
              `pr-queue:${stateFile()}`,
              async () => {
                const state = await Effect.runPromise(read())
                const [value, next] = f(state)
                if (next !== state) await Effect.runPromise(persist(next))
                return value
              },
              { dir: path.join(stateDirectory(), ".locks"), signal },
            ),
          catch: (cause) =>
            cause instanceof PRQueueError
              ? cause
              : new PRQueueError({ operation: "persist", message: `Unable to mutate PR queue: ${String(cause)}` }),
        })

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
        read().pipe(
          Effect.map((state) => state.entries.find((entry) => entry.id === id)),
          Effect.map((entry) => (entry ? copy(entry) : null)),
        )

      const list: Interface["list"] = () => read().pipe(Effect.map(publicState))

      const claimForReview: Interface["claimForReview"] = (parentID, id) =>
        mutate((state) => {
          const candidate = state.entries
            .filter(
              (entry) =>
                entry.parentID === parentID && entry.status === "draft" && (id === undefined || entry.id === id),
            )
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
          if (verdict === "rejected") return { ...entry, status: "rejected", updatedAt: Date.now() }
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

      const refreshBaseline: Interface["refreshBaseline"] = ({ id, parentID, parentHead, diagnostic }) =>
        update(id, (entry) =>
          entry.parentID === parentID && entry.status === "approved"
            ? {
                ...entry,
                status: "awaiting_review",
                mergeDiagnostic: diagnostic,
                metadata: { ...entry.metadata, parentHead },
                updatedAt: Date.now(),
              }
            : null,
        )

      const finishMerge = (id: ID, parentID: string, status: "merged" | "conflicted", mergeDiagnostic?: string) =>
        update(id, (entry) =>
          entry.parentID === parentID && entry.status === "merging"
            ? { ...entry, status, ...(mergeDiagnostic ? { mergeDiagnostic } : {}), updatedAt: Date.now() }
            : null,
        )

      const bounceMerge: Interface["bounceMerge"] = ({ id, parentID, diagnostic }) =>
        update(id, (entry) => {
          if (entry.parentID !== parentID || entry.status !== "merging") return null
          const redoCount = entry.redoCount + 1
          return {
            ...entry,
            redoCount,
            status: redoCount > 3 ? "rejected" : "changes_requested",
            ...(diagnostic ? { mergeDiagnostic: diagnostic } : {}),
            updatedAt: Date.now(),
          }
        })

      const completeMerge: Interface["completeMerge"] = ({ id, parentID, parentHead }) =>
        mutate((state) => {
          const entry = state.entries.find((candidate) => candidate.id === id)
          if (!entry || entry.parentID !== parentID || entry.status !== "merging") return [null, state]
          const now = Date.now()
          const completed = { ...entry, status: "merged" as const, updatedAt: now }
          return [
            copy(completed),
            {
              entries: state.entries.map((candidate) => {
                if (candidate.id === id) return completed
                if (!parentHead || candidate.parentID !== parentID || terminal.has(candidate.status)) return candidate
                const metadata = candidate.metadata
                if (!metadata || typeof metadata.parentHead !== "string") return candidate
                return { ...candidate, metadata: { ...metadata, parentHead }, updatedAt: now }
              }),
            },
          ]
        })

      const setStageReview: Interface["setStageReview"] = ({ parentID, batchID, review }) =>
        mutate((state) => {
          const now = Date.now()
          const entries = state.entries.map((entry) => {
            const entryBatchID =
              typeof entry.metadata?.batchID === "string" ? entry.metadata.batchID : entry.id
            if (entry.parentID !== parentID || entryBatchID !== batchID) return entry
            return {
              ...entry,
              metadata: { ...entry.metadata, stageReview: review },
              updatedAt: now,
            }
          })
          const changed = entries.filter((entry, index) => entry !== state.entries[index])
          return changed.length === 0 ? [[], state] : [changed.map(copy), { entries }]
        })

      const supersede: Interface["supersede"] = (id) =>
        update(id, (entry) =>
          !terminal.has(entry.status) && entry.status !== "merging"
            ? { ...entry, status: "superseded", updatedAt: Date.now() }
            : null,
        )

      return Service.of({
        create,
        get,
        list,
        claimForReview,
        resubmit,
        verdict,
        claimMerge,
        refreshBaseline,
        completeMerge,
        setStageReview,
        conflictMerge: ({ id, parentID, diagnostic }) => finishMerge(id, parentID, "conflicted", diagnostic),
        bounceMerge,
        supersede,
      })
    }),
  )
}
