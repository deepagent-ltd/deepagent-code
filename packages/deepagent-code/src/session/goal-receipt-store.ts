/**
 * GoalReceiptStore — CAS-safe receipt adapter for Goal workspace and tick receipts.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.9.1
 *
 * Wraps the existing DocumentStore with:
 *   - collision-resistant business keys via SHA-256 (avoids 48-char idSlug truncation)
 *   - EffectFlock for cross-process Goal lock
 *   - rebuildIndex() for fresh reads within the locked scope
 *   - expected-version CAS via DocumentStore's exclusive-create mechanics
 */

import { Data, Effect } from "effect"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Hash } from "@deepagent-code/core/util/hash"
import { DocumentStore, DocumentConflictError } from "@deepagent-code/core/deepagent/document-store"
import type { Doc } from "@deepagent-code/core/deepagent/document-store"
import { Global } from "@deepagent-code/core/global"
import * as path from "path"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GoalReceiptKeyConflictError extends Data.TaggedError(
  "GoalReceiptStore.KeyConflict",
)<{
  readonly goalID: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Key types
// ---------------------------------------------------------------------------

export type GoalReceiptKey =
  | { readonly kind: "workspace"; readonly goalID: string }
  | { readonly kind: "tick"; readonly goalID: string; readonly tickSeq: number }

export type GoalWorkspaceReceipt = {
  readonly goal_id: string
  readonly parent_session_id: string
  readonly operation_key: string
  readonly repository_root: string
  readonly parent_directory: string
  readonly base_commit: string
  readonly worktree_directory: string
  readonly worktree_branch: string
  readonly workspace_revision: number
  readonly state:
    | "pending" | "provisioning" | "ready"
    | "submitting" | "submitted" | "retained"
    | "removed" | "recovery_required"
  readonly pr_operation_key?: string
  readonly pr_id?: string
  readonly create_started_at?: number
  readonly submission_started_at?: number
  readonly last_status_hash?: string
  readonly last_head?: string
  readonly key_schema_version: 1
}

export type GoalTickReceipt = {
  readonly goal_id: string
  readonly tick_seq: number
  readonly state:
    | "prepared" | "roles_settled" | "observations_settled"
    | "commit_prepared" | "applying" | "applied"
    | "successor_published" | "terminal_published"
  readonly apply_cursor?: string
  readonly roles?: ReadonlyArray<{ run_id: string; result_hash?: string }>
  readonly key_schema_version: 1
}

export type GoalReceiptSnapshot = {
  readonly key: GoalReceiptKey
  readonly docID: string
  readonly docVersion: number
  readonly contentHash: string
  readonly body: GoalWorkspaceReceipt | GoalTickReceipt
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RECEIPT_SCOPE = "durable"
const RECEIPT_PROVENANCE = { source: "runner" as const }

function receiptSlug(key: GoalReceiptKey): string {
  if (key.kind === "workspace") {
    const digest = Hash.sha256(`workspace:${key.goalID.length}:${key.goalID}`)
    return `goal-ws-v1-${digest.slice(0, 32)}`
  }
  const digest = Hash.sha256(`tick:${key.goalID.length}:${key.goalID}:${key.tickSeq}`)
  return `goal-tick-v1-${digest.slice(0, 32)}`
}

function receiptDescription(key: GoalReceiptKey): string {
  return `DeepAgent goal ${key.kind === "workspace" ? "workspace" : "tick"} receipt ${receiptSlug(key)}`
}

function bodyToString(body: GoalWorkspaceReceipt | GoalTickReceipt): string {
  return JSON.stringify(body)
}

function stringToBody(str: string): GoalWorkspaceReceipt | GoalTickReceipt | undefined {
  try { return JSON.parse(str) as GoalWorkspaceReceipt | GoalTickReceipt }
  catch { return undefined }
}

function receiptContentHash(body: GoalWorkspaceReceipt | GoalTickReceipt): string {
  return Hash.sha256(JSON.stringify(body))
}

function docToSnapshot(doc: Doc, key: GoalReceiptKey): GoalReceiptSnapshot | undefined {
  const body = stringToBody(doc.body)
  if (!body) return undefined
  return {
    key,
    docID: doc.id,
    docVersion: doc.version,
    contentHash: receiptContentHash(body),
    body,
  }
}

function goalReceiptRoot(goalID: string): string {
  return path.join(
    Global.Path.agent.data,
    "state", "goal", goalID, "receipt",
  )
}

function lockKeyForGoal(goalID: string): string {
  const digest = Hash.sha256(`goal-lock:${goalID.length}:${goalID}`)
  return `goal-lock-${digest.slice(0, 32)}`
}

/**
 * Find a receipt by its slug inside a DocumentStore.
 * Uses list() + ID matching since DocumentStore has no direct slug lookup.
 */
function findReceiptInStore(
  store: DocumentStore,
  key: GoalReceiptKey,
): GoalReceiptSnapshot | undefined {
  const slug = receiptSlug(key)
  const refs = store.list({ type: "run_context", scope: RECEIPT_SCOPE })
  for (const ref of refs) {
    const doc = store.get(ref.id)
    if (!doc) continue
    // Match by description which we derive deterministically from slug
    if (doc.description === receiptDescription(key)) {
      return docToSnapshot(doc, key)
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// withGoalLock — acquire Goal lock and provide a CAS-capable locked handle
// Design §3.9.1
// ---------------------------------------------------------------------------

export function withGoalLock<A, E, R = never>(
  goalID: string,
  use: (locked: {
    refresh: () => Effect.Effect<void>
    readFresh: (key: GoalReceiptKey) => Effect.Effect<GoalReceiptSnapshot | undefined>
    compareAndSet: (input: {
      key: GoalReceiptKey
      expected?: { docVersion: number; contentHash: string }
      desiredBody: GoalWorkspaceReceipt | GoalTickReceipt
    }) => Effect.Effect<GoalReceiptSnapshot, GoalReceiptKeyConflictError | DocumentConflictError>
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    const root = goalReceiptRoot(goalID)
    const key = lockKeyForGoal(goalID)

    // Use shared store so all calls within the process share an index
    const store = DocumentStore.shared(root)

    return yield* flock.withLock(
      Effect.gen(function* () {
        const refresh = () =>
          Effect.sync(() => { store.rebuildIndex() })

        const readFresh = (receiptKey: GoalReceiptKey) =>
          Effect.sync(() => {
            store.rebuildIndex()
            return findReceiptInStore(store, receiptKey)
          })

        const compareAndSet = (input: {
          key: GoalReceiptKey
          expected?: { docVersion: number; contentHash: string }
          desiredBody: GoalWorkspaceReceipt | GoalTickReceipt
        }) =>
          Effect.try({
            try: () => {
              store.rebuildIndex()
              const existing = findReceiptInStore(store, input.key)
              const desiredHash = receiptContentHash(input.desiredBody)
              const desiredStr = bodyToString(input.desiredBody)

              if (!input.expected) {
                // New receipt — must not exist
                if (existing) {
                  if (existing.contentHash === desiredHash) return existing // exact replay
                  throw new GoalReceiptKeyConflictError({
                    goalID,
                    reason: `receipt already exists at v${existing.docVersion} with different content`,
                  })
                }
                const doc = store.create({
                  type: "run_context",
                  scope: RECEIPT_SCOPE,
                  idSlug: receiptSlug(input.key),
                  description: receiptDescription(input.key),
                  body: desiredStr,
                  provenance: RECEIPT_PROVENANCE,
                  extensions: {
                    record_kind: input.key.kind === "workspace"
                      ? "goal_workspace_receipt" : "goal_tick_receipt",
                    workspace_receipt_goal_id: goalID,
                    tick_seq: input.key.kind === "tick" ? input.key.tickSeq : undefined,
                    key_schema_version: 1,
                  },
                })
                const snap = docToSnapshot(doc, input.key)
                if (!snap) throw new Error("Failed to read back new receipt")
                return snap
              }

              // CAS update — expected version must match
              if (!existing) {
                throw new GoalReceiptKeyConflictError({
                  goalID,
                  reason: `expected receipt at v${input.expected.docVersion} but not found`,
                })
              }
              if (existing.contentHash === desiredHash && existing.docVersion === input.expected.docVersion) {
                return existing // exact replay
              }
              if (
                existing.docVersion !== input.expected.docVersion ||
                existing.contentHash !== input.expected.contentHash
              ) {
                throw new GoalReceiptKeyConflictError({
                  goalID,
                  reason: `CAS conflict: expected v${input.expected.docVersion}/${input.expected.contentHash.slice(0, 8)}, got v${existing.docVersion}/${existing.contentHash.slice(0, 8)}`,
                })
              }
              const updated = store.update(existing.docID, desiredStr)
              const snap = docToSnapshot(updated, input.key)
              if (!snap) throw new Error("Failed to read back updated receipt")
              return snap
            },
            catch: (e) => {
              if (e instanceof GoalReceiptKeyConflictError) return e
              if (e instanceof DocumentConflictError) return e
              throw e
            },
          })

        return yield* use({ refresh, readFresh, compareAndSet })
      }),
      key,
      root,
    )
  })
}

export * as GoalReceiptStore from "./goal-receipt-store"
