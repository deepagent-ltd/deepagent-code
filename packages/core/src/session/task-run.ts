export * as TaskRunAuthority from "./task-run"

import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { Cause, Data, Duration, Effect, Exit, Option, Schedule, Schema } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Identifier } from "../id/id"
import type { LocationRef } from "../location/ref"
import type { PermissionSchema } from "../permission/schema"
import { Hash } from "../util/hash"
import { AgentV2 } from "../agent"
import { SessionV1 } from "../v1/session"
import type { SessionV2 } from "../session"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionTable, TaskAdmissionTable, TaskNotificationOutboxTable, TaskRunEventTable, TaskRunTable } from "./sql"
import { V2StructuredOutputEvidenceTable } from "./runner/v2-structured-output-evidence.sql"
import { TaskWorkspace } from "./task-workspace"
import { V2TaskRunReceiptTable } from "./runner/v2-task-run-receipt.sql"
import { V2TaskRunReceipt } from "./runner/v2-task-run-receipt"

type DatabaseService = Database.Interface["db"]
type Transaction = Parameters<Parameters<DatabaseService["transaction"]>[0]>[0]
/** Query surface shared by the raw `db` handle and an open transaction (commit hooks join the ambient transaction). */
type Writer = Pick<DatabaseService, "select" | "insert" | "update">

// The task ledger tables brand message ids with the V1 wire brand; the authority's public surface
// speaks SessionMessage.ID. Both are `msg`-prefixed strings, so conversion is a checked make().
const wireMessageID = (id: SessionMessage.ID) => SessionV1.MessageID.make(id)

export type RunState = typeof TaskRunTable.$inferSelect["state"]
export type InputState = typeof TaskRunTable.$inferSelect["input_state"]
export type DeliveryMode = "foreground" | "background"

/** Frozen execution intent (agent/model/schema/permission) snapshotted at admission. */
export type ExecutionSpec = {
  readonly runtime: "core_v2"
  readonly agent: string
  readonly outputSchema?: Record<string, unknown>
  readonly permissions: PermissionSchema.Ruleset
  /** Frozen workspace intent: `worktree` runs execute write-isolated in a run-owned worktree. */
  readonly workspace?: { readonly mode: "worktree" }
}

export type SubmitSpec = {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly deliveryMode: DeliveryMode
  readonly prompt: Prompt
  readonly agent: string
  readonly outputSchema?: Record<string, unknown>
  readonly child: {
    readonly title: string
    /**
     * Admission-time Location context. Shared runs create the child HERE; write-isolated
     * (`workspace.mode === "worktree"`) runs prepare the worktree first and root the child at
     * the receipt's worktree directory instead.
     */
    readonly location: LocationRef.Ref
    readonly permissions: PermissionSchema.Ruleset
    /** Omitted (or shared) keeps the current shared-parent behavior; `worktree` isolates writes. */
    readonly workspace?: { readonly mode: "worktree" }
  }
}

export type Run = {
  readonly runID: string
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly childSessionID: SessionSchema.ID
  readonly childMessageID: SessionMessage.ID
  readonly deliveryMode: DeliveryMode
  readonly state: RunState
  readonly inputState: InputState
  readonly generation: number
  readonly version: number
  readonly claimGeneration: number
  readonly executionOwner?: string
  readonly leaseExpiresAt?: number
  readonly output?: string
  readonly reason?: string
}

export class AdmissionConflict extends Data.TaggedError("TaskRunAuthority.AdmissionConflict")<{
  readonly reason: "request" | "child"
}> {}

export class ClaimLost extends Data.TaggedError("TaskRunAuthority.ClaimLost")<{
  readonly runID: string
  readonly reason: string
}> {}

export class SettlementConflict extends Data.TaggedError("TaskRunAuthority.SettlementConflict")<{
  readonly runID: string
  readonly reason: "unknown_run" | "settlement_fence_lost" | "outcome_divergence"
}> {}

export class ExecutionLeaseLost extends Data.TaggedError("TaskRunAuthority.ExecutionLeaseLost")<{
  readonly runID: string
}> {}

export type Admission = {
  readonly run: Run
  readonly exactRetry: boolean
}

export type SettleOutcome = {
  readonly run: Run
  readonly converged: boolean
}

// ── Deterministic identity ────────────────────────────────────────────────────────────────────
// The child session and its first input derive from the admission key, so a crash between the
// ledger commit and the child create (or between create and input admission) converges on retry
// without orphans or duplicate rows. `task_run.child_session_id` is NOT NULL before the session
// row exists precisely because the identity is derived, not generated.

export function admissionKey(input: {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly toolCallID: string
}) {
  return `${input.parentSessionID}\u0000${input.parentMessageID}\u0000${input.toolCallID}`
}

export function deterministicChildSessionID(input: {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly toolCallID: string
}) {
  return SessionSchema.ID.make(`ses_task_${Hash.sha256(admissionKey(input)).slice(0, 24)}`)
}

export function deterministicChildMessageID(input: {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly toolCallID: string
}) {
  return SessionMessage.ID.make(`msg_task_${Hash.sha256(admissionKey(input)).slice(0, 24)}`)
}

// ── Admission: the ONE durable ledger transaction ─────────────────────────────────────────────

/**
 * Admit a durable task run: a single IMMEDIATE transaction writes the `task_run` row
 * (state='admitted', input_state='pending', execution_runtime='v2'), the deterministic
 * `task_admission` dedupe row, and the v1 `task_run_event`. No external side effect (child
 * session, worktree, provider call) may precede this commit. Exact retry with the same
 * admission key and request hash returns the EXISTING run with zero new rows; the same key with
 * a different request hash is a typed conflict.
 */
export const admitRun = Effect.fn("TaskRunAuthority.admitRun")(function* (db: DatabaseService, spec: SubmitSpec) {
  const key = admissionKey(spec)
  const requestHash = Hash.sha256(canonicalJson(requestFingerprint(spec)))
  const childSessionID = deterministicChildSessionID(spec)
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select({ admission: TaskAdmissionTable, run: TaskRunTable })
          .from(TaskAdmissionTable)
          .innerJoin(TaskRunTable, eq(TaskRunTable.run_id, TaskAdmissionTable.run_id))
          .where(eq(TaskAdmissionTable.admission_key, key))
          .get()
          .pipe(Effect.orDie)
        if (existing) {
          if (existing.admission.request_hash !== requestHash)
            return yield* new AdmissionConflict({ reason: "request" })
          if (existing.run.child_session_id !== childSessionID)
            return yield* new AdmissionConflict({ reason: "child" })
          return { run: fromRow(existing.run), exactRetry: true } satisfies Admission
        }

        // Lineage depth: a parent session that is itself a task child carries its run's depth.
        const parentRun = yield* tx
          .select({ runID: TaskRunTable.run_id, rootRunID: TaskRunTable.root_run_id, depth: TaskRunTable.depth })
          .from(TaskRunTable)
          .where(
            and(
              eq(TaskRunTable.child_session_id, spec.parentSessionID),
              eq(TaskRunTable.execution_runtime, "v2"),
              sql`${TaskRunTable.state} IN ('admitted', 'provisioning', 'running', 'researching', 'finalizing')`,
            ),
          )
          .get()
          .pipe(Effect.orDie)

        const now = Date.now()
        const runID = Identifier.ascending("job")
        // Workspace intent freezes at admission. Isolated (worktree) runs provision their
        // workspace AFTER this commit (TaskWorkspace.prepare) and hold preflight_state='pending'
        // as the child-start fence; shared runs are live-ready immediately (legacy behavior).
        const isolated = spec.child.workspace?.mode === "worktree"
        const inserted = yield* tx
          .insert(TaskRunTable)
          .values({
            run_id: runID,
            root_run_id: parentRun?.rootRunID ?? parentRun?.runID ?? runID,
            parent_run_id: parentRun?.runID,
            request_hash: requestHash,
            execution_runtime: "v2",
            parent_session_id: spec.parentSessionID,
            parent_message_id: wireMessageID(spec.parentMessageID),
            tool_call_id: spec.toolCallID,
            child_session_id: childSessionID,
            child_message_id: wireMessageID(deterministicChildMessageID(spec)),
            generation: 1,
            delivery_mode: spec.deliveryMode,
            effective_delivery_mode: spec.deliveryMode,
            phase: "admission",
            state: "admitted",
            depth: (parentRun?.depth ?? 0) + 1,
            origin_kind: "task_tool",
            origin_key: key,
            session_mode: "new",
            context_mode: "fresh",
            mutation_capability: isolated ? "write" : "read_only",
            tool_capability_hash: Hash.sha256(canonicalJson(spec.child.permissions)),
            workspace_mode: isolated ? "worktree" : "shared",
            workspace_owner: isolated ? "run" : "parent",
            // An isolated child sees the recorded base commit, not live parent state.
            workspace_visibility: isolated ? "base_commit" : "live",
            parent_dirty_policy: isolated ? "exclude" : "allow_live",
            workspace_operation_key: childSessionID,
            workspace_preflight_state: isolated ? "pending" : "ready",
            input_state: "pending",
            execution_spec: executionSpec(spec),
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        yield* appendEvent(
          tx,
          inserted,
          "run_admitted",
          null,
          "admitted",
          "core_v2_admission",
          now,
        )
        yield* tx
          .insert(TaskAdmissionTable)
          .values({
            admission_key: key,
            request_hash: requestHash,
            run_id: runID,
            parent_session_id: spec.parentSessionID,
            parent_message_id: wireMessageID(spec.parentMessageID),
            tool_call_id: spec.toolCallID,
            delivery_mode: spec.deliveryMode,
            time_created: now,
          })
          .run()
          .pipe(Effect.orDie)
        return { run: fromRow(inserted), exactRetry: false } satisfies Admission
      }),
    { behavior: "immediate" },
  )
})

/**
 * Create — or ADOPT, after a crash between the ledger commit and the create — the deterministic
 * child session. Strictly after the admission transaction: adoption rides SessionV2.create's
 * existing identity check (`store.get` early return). Write-isolated runs are FENCED: the
 * durable preflight receipt must be `ready` (typed refusal otherwise) and the child is then
 * rooted at the receipt's worktree directory, so every Location-keyed service (filesystem,
 * mutation tools) operates inside the worktree instead of the parent checkout.
 */
export const ensureChildSession = Effect.fn("TaskRunAuthority.ensureChildSession")(
  function* (
    db: DatabaseService,
    sessions: SessionV2.Interface,
    spec: SubmitSpec,
    run: Pick<Run, "runID" | "childSessionID">,
  ) {
    const location = yield* TaskWorkspace.childLocation(db, {
      runID: run.runID,
      fallback: spec.child.location,
    })
    yield* sessions.create({
      id: run.childSessionID,
      parentID: spec.parentSessionID,
      agent: AgentV2.ID.make(spec.agent),
      title: spec.child.title,
      location,
      permissions: spec.child.permissions,
    })
    return run.childSessionID
  },
)

/**
 * Admit the ONE first child input: the `PromptLifecycle.Admitted` event, its `session_input`
 * projection, and the `task_run` input_state pending→ready CAS commit in the SAME transaction
 * (the EventV2 `{ commit }` hook). A hook failure rolls back BOTH the event and the projected
 * row, leaving the run at input_state='pending'; a retry then succeeds exactly once.
 * Write-isolated runs admit ONLY against a ready workspace preflight receipt (typed refusal).
 */
export const admitChildInput = Effect.fn("TaskRunAuthority.admitChildInput")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  run: Run,
  prompt: Prompt,
) {
  yield* TaskWorkspace.requireAdmissible(db, run.runID)
  yield* SessionInput.admit(db, events, {
    id: run.childMessageID,
    sessionID: run.childSessionID,
    prompt,
    delivery: "steer",
    commit: () => casInputReady(db, run),
  })
  // The early-return path (input row already projected, e.g. replayed from the serialized event
  // log by another ingress) never runs the commit hook — repair the CAS idempotently.
  return yield* ensureInputReady(db, run)
})

/**
 * Submit a fresh durable task: admit the ledger transaction, then (strictly after the commit)
 * prepare the isolated workspace when the run is write-isolated — the durable preflight
 * receipt settles BEFORE any child execution — create-or-adopt the deterministic child session
 * and admit the single first child input with its atomic ready-CAS. No provider work runs
 * here — the caller claims and executes.
 */
export const submit = Effect.fn("TaskRunAuthority.submit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessions: SessionV2.Interface,
  spec: SubmitSpec,
) {
  const admission = yield* admitRun(db, spec)
  if (spec.child.workspace?.mode === "worktree")
    yield* TaskWorkspace.prepare(db, {
      runID: admission.run.runID,
      parentDirectory: spec.child.location.directory,
    })
  yield* ensureChildSession(db, sessions, spec, admission.run)
  const run = yield* admitChildInput(db, events, admission.run, spec.prompt)
  return { ...admission, run }
})

export const ensureInputReady = Effect.fn("TaskRunAuthority.ensureInputReady")(function* (
  db: DatabaseService,
  run: Run,
) {
  const current = yield* loadRun(db, run.runID)
  if (current === undefined) return yield* Effect.die(`task_run missing: ${run.runID}`)
  if (current.inputState === "ready") return current
  if (current.inputState !== "pending") return yield* Effect.die(`task_run input state diverged: ${current.inputState}`)
  yield* casInputReady(db, run)
  const ready = yield* loadRun(db, run.runID)
  if (ready?.inputState !== "ready") return yield* Effect.die(`task_run input CAS did not converge: ${run.runID}`)
  return ready
})

// Bare-statement CAS (NO nested transaction): inside the commit hook the statements join the
// event transaction; standalone they run as their own implicit transaction. The pending→ready
// state fence is the CAS; divergence dies so the surrounding transaction rolls back.
const casInputReady = (db: Writer, run: Pick<Run, "runID" | "childMessageID">) =>
  Effect.gen(function* () {
    const now = Date.now()
    const row = yield* db
      .update(TaskRunTable)
      .set({
        input_state: "ready",
        input_admission_started_at: now,
        child_input_materialized_hash: Hash.sha256(`${run.runID}\u0000${run.childMessageID}`),
        child_input_part_count: 1,
        version: sql`${TaskRunTable.version} + 1`,
        time_updated: now,
      })
      .where(
        and(
          eq(TaskRunTable.run_id, run.runID),
          eq(TaskRunTable.input_state, "pending"),
          eq(TaskRunTable.child_message_id, wireMessageID(run.childMessageID)),
          eq(TaskRunTable.execution_runtime, "v2"),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (row)
      return yield* appendEvent(
        db,
        row,
        "input_ready",
        "admitted",
        "admitted",
        "core_v2_session_input_admitted",
        now,
      ).pipe(Effect.asVoid)
    // Exact hook re-run (idempotent publish retry) or replay repair: converge only on the same
    // deterministic child input.
    const current = yield* db
      .select({ input_state: TaskRunTable.input_state, child_message_id: TaskRunTable.child_message_id })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, run.runID))
      .get()
      .pipe(Effect.orDie)
    if (current?.input_state === "ready" && current.child_message_id === wireMessageID(run.childMessageID))
      return
    return yield* Effect.die(`task_run input CAS diverged: ${run.runID} is '${current?.input_state ?? "missing"}'`)
  })

// ── Claim / lease (owner + generation fence) ──────────────────────────────────────────────────

/**
 * Claim/start CAS: admitted→running takes an unowned row; recovery re-claims a running row whose
 * lease expired. The write installs the process owner token, bumps claim_generation, and fences
 * on execution_runtime='v2' only — historical V1 rows are invisible to this authority.
 */
export const claim = Effect.fn("TaskRunAuthority.claim")(function* (
  db: DatabaseService,
  input: {
    readonly runID: string
    readonly ownerToken: string
    readonly leaseMs?: number
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const leaseMs = input.leaseMs ?? 30_000
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .update(TaskRunTable)
          .set({
            phase: "research",
            state: "running",
            execution_owner: input.ownerToken,
            execution_started_at: now,
            lease_expires_at: now + leaseMs,
            claim_generation: sql`${TaskRunTable.claim_generation} + 1`,
            start_attempts: sql`${TaskRunTable.start_attempts} + 1`,
            version: sql`${TaskRunTable.version} + 1`,
            time_updated: now,
          })
          .where(
            and(
              eq(TaskRunTable.run_id, input.runID),
              eq(TaskRunTable.execution_runtime, "v2"),
              eq(TaskRunTable.input_state, "ready"),
              eq(TaskRunTable.control_state, "open"),
              or(
                and(eq(TaskRunTable.state, "admitted"), isNull(TaskRunTable.execution_owner)),
                and(
                  eq(TaskRunTable.state, "running"),
                  or(isNull(TaskRunTable.lease_expires_at), lte(TaskRunTable.lease_expires_at, now))!,
                ),
              )!,
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new ClaimLost({ runID: input.runID, reason: "claim_fence_lost" })
        yield* appendEvent(tx, row, "execution_started", null, "running", "core_v2_owner_claim", now)
        return fromRow(row)
      }),
    { behavior: "immediate" },
  )
})

/** Lease renewal keeps the SAME owner/generation; losing the fence is a typed failure. */
export const renewLease = Effect.fn("TaskRunAuthority.renewLease")(function* (
  db: DatabaseService,
  input: {
    readonly runID: string
    readonly ownerToken: string
    readonly claimGeneration: number
    readonly leaseMs?: number
  },
) {
  const now = Date.now()
  const row = yield* db
    .update(TaskRunTable)
    .set({ lease_expires_at: now + (input.leaseMs ?? 30_000), time_updated: now })
    .where(
      and(
        eq(TaskRunTable.run_id, input.runID),
        eq(TaskRunTable.execution_runtime, "v2"),
        eq(TaskRunTable.execution_owner, input.ownerToken),
        eq(TaskRunTable.claim_generation, input.claimGeneration),
        eq(TaskRunTable.state, "running"),
        gt(TaskRunTable.lease_expires_at, now),
      ),
    )
    .returning({ runID: TaskRunTable.run_id })
    .get()
    .pipe(Effect.orDie)
  if (row) return
  return yield* new ClaimLost({ runID: input.runID, reason: "lease_renewal_fence_lost" })
})

// ── Terminal settle (receipt + outbox, fenced) ────────────────────────────────────────────────

export type SettleInput = {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly state: "completed" | "failed" | "interrupted"
  readonly reason: string
  readonly output?: string
  readonly rawResultMessageID?: SessionMessage.ID
  readonly error?: { readonly code: string; readonly message: string; readonly data?: Record<string, unknown> }
  readonly now?: number
}

/**
 * Terminal settle: ONE transaction CASes the run to a terminal state fenced by
 * owner+claim_generation+lease, appends the settle event, records the immutable
 * `session_v2_task_run_receipt`, and (background delivery only) enqueues a queued
 * `task_notification_outbox` row for the wave-2 Core dispatcher. A stale generation or expired
 * lease is a typed SettlementConflict with NO receipt written; an exact re-settle of the same
 * outcome converges; a divergent outcome conflicts.
 */
export const settle = Effect.fn("TaskRunAuthority.settle")(function* (db: DatabaseService, input: SettleInput) {
  return yield* Effect.uninterruptible(
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = input.now ?? Date.now()
          const current = yield* tx
            .select()
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, input.runID))
            .get()
            .pipe(Effect.orDie)
          if (!current || current.execution_runtime !== "v2")
            return yield* new SettlementConflict({ runID: input.runID, reason: "unknown_run" })
          const fenced =
            current.state === "running" &&
            current.execution_owner === input.ownerToken &&
            current.claim_generation === input.claimGeneration &&
            current.lease_expires_at !== null &&
            current.lease_expires_at > now
          if (!fenced) return yield* convergeOrConflict(tx, current, input, now)

          const row = yield* tx
            .update(TaskRunTable)
            .set({
              phase: "settled",
              state: input.state,
              reason: input.reason,
              output: input.state === "completed" ? input.output ?? null : null,
              raw_result_message_id: input.rawResultMessageID === undefined ? null : wireMessageID(input.rawResultMessageID),
              error:
                input.state === "completed"
                  ? null
                  : (input.error ?? { code: input.state, message: input.reason }),
              execution_owner: null,
              lease_expires_at: null,
              control_state: "closed",
              version: sql`${TaskRunTable.version} + 1`,
              time_updated: now,
              time_settled: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.state, "running"),
                gt(TaskRunTable.lease_expires_at, now),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new SettlementConflict({ runID: input.runID, reason: "settlement_fence_lost" })
          yield* appendEvent(tx, row, "run_settled", "running", input.state, input.reason, now)
          yield* V2TaskRunReceipt.recordInTransaction(tx, {
            sessionId: current.parent_session_id,
            runId: current.run_id,
            childSessionId: current.child_session_id,
            generation: current.generation,
            state: input.state,
            reason: input.reason,
            outcomeHash: outcomeHash(input),
            ownerToken: input.ownerToken,
            now,
          })
          // Schema-bound runs record their structured-contract verdict durably. Terminal outcomes
          // that foreclose a tool finalizer (failed/interrupted, or completed background runs
          // with no foreground finalizer) seal 'unvalidated' evidence INSIDE the settle
          // transaction — fail-closed: a divergent pre-existing record aborts the settle. A
          // foreground completed settle defers to the task tool's finalizer, which records the
          // validated/validation_failed verdict strictly after (UNIQUE(run_id) CAS converges).
          const settledSchema = runOutputSchema(current)
          if (settledSchema !== undefined && (input.state !== "completed" || current.delivery_mode === "background"))
            yield* recordStructuredEvidenceInTransaction(tx, {
              runId: current.run_id,
              schemaName: "execution_spec",
              schema: settledSchema,
              validationOutcome: "unvalidated",
              rawOutput: input.state === "completed" ? input.output ?? "" : "",
              ...(input.rawResultMessageID === undefined ? {} : { outputMessageId: input.rawResultMessageID }),
              ownerToken: input.ownerToken,
              now,
            })
          if (row.delivery_mode === "background") yield* enqueueNotification(tx, row, now)
          return { run: fromRow(row), converged: false } satisfies SettleOutcome
        }),
      { behavior: "immediate" },
    ),
  )
})

// A fenced settle that lost its window either re-observes its own terminal outcome (exact
// re-settle converges) or is a genuine conflict (another owner settled, or evidence diverged).
const convergeOrConflict = (
  tx: Transaction,
  current: typeof TaskRunTable.$inferSelect,
  input: SettleInput,
  now: number,
) =>
  Effect.gen(function* () {
    if (current.state !== "running")
      return yield* Effect.gen(function* () {
        const receipt = yield* tx
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.run_id, input.runID))
          .get()
          .pipe(Effect.orDie)
        if (
          receipt &&
          receipt.state === input.state &&
          receipt.reason === input.reason &&
          receipt.outcome_hash === outcomeHash(input)
        )
          return { run: fromRow(current), converged: true } satisfies SettleOutcome
        return yield* new SettlementConflict({ runID: input.runID, reason: "outcome_divergence" })
      })
    return yield* new SettlementConflict({ runID: input.runID, reason: "settlement_fence_lost" })
  })

// ── Structured-output evidence (V2 authority) ────────────────────────────────────────────────
// Every schema-bound V2 task run leaves exactly ONE immutable evidence row pinning its
// structured-contract verdict and binding it to the V2 session_message that carries the final
// answer. Two writers, one converge discipline (UNIQUE(run_id) + full evidence comparison):
//  - the settle transaction itself, for terminal outcomes that foreclose the tool finalizer
//    (failed/interrupted, completed background runs) — outcome 'unvalidated';
//  - the task tool's finalizer, strictly after a foreground completed settle, with the final
//    validated candidate ('validated') or the exhausted material ('validation_failed').
// A crash between settle and the finalizer record converges on retry; a divergent record is a
// typed conflict and — inside settle — aborts the settle (fail-closed: no silent schema-bound
// terminal state without matching evidence). The frozen V1 `task_structured_output_evidence`
// table is never read or written by the V2 authority.

export type StructuredEvidenceOutcome = "validated" | "validation_failed" | "unvalidated"

export type StructuredEvidence = {
  readonly evidenceId: string
  readonly runId: string
  readonly sessionId: string
  readonly childSessionId: string
  readonly outputMessageId?: string
  readonly schemaName: string
  readonly validationOutcome: StructuredEvidenceOutcome
  readonly outputSha256: string
  readonly schemaSha256: string
  readonly rawOutput: string
  readonly ownerToken: string
  readonly timeCreated: number
}

export type StructuredEvidenceInput = {
  readonly runId: string
  /**
   * Label of the output contract: the named registry key the tool resolved, 'inline' for raw
   * JSON-schema documents, or 'execution_spec' when the authority derived it from the frozen
   * execution spec. Informational only — `schemaSha256` pins the exact contract content.
   */
  readonly schemaName: string
  readonly schema: Record<string, unknown>
  readonly validationOutcome: StructuredEvidenceOutcome
  /** The final answer material: the validated candidate JSON, the last rejected material, or the bounded research text. */
  readonly rawOutput: string
  /** The child session_message carrying the final answer (required for 'validated'; the child's last assistant message otherwise). */
  readonly outputMessageId?: SessionMessage.ID
  readonly ownerToken: string
  readonly now?: number
}

export class StructuredEvidenceConflict extends Data.TaggedError("TaskRunAuthority.StructuredEvidenceConflict")<{
  readonly runId: string
  readonly reason: "divergence"
}> {}

/** Record the structured-contract verdict for a settled schema-bound run (own immediate transaction). */
export const recordStructuredEvidence = Effect.fn("TaskRunAuthority.recordStructuredEvidence")(function* (
  db: DatabaseService,
  input: StructuredEvidenceInput,
) {
  return yield* db.transaction((tx) => recordStructuredEvidenceInTransaction(tx, input), { behavior: "immediate" })
})

/**
 * Tx-bound CAS writer: the first record wins, an exact re-record converges on the same row, and
 * any divergence is a typed conflict — the recorded verdict is never overwritten. Shape or
 * binding violations (hex64 hashes, outcome vocabulary, missing binding message, non-V2 run)
 * abort the insert at the database guard, rolling the surrounding transaction back.
 */
export const recordStructuredEvidenceInTransaction = Effect.fn(
  "TaskRunAuthority.recordStructuredEvidenceInTransaction",
)(function* (tx: Transaction, input: StructuredEvidenceInput) {
  const run = yield* tx
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, input.runId))
    .get()
    .pipe(Effect.orDie)
  if (!run || run.execution_runtime !== "v2")
    return yield* Effect.die(`structured evidence run missing or not v2: ${input.runId}`)
  const schemaSha256 = Hash.sha256(canonicalJson(input.schema))
  const outputSha256 = Hash.sha256(input.rawOutput)
  const existing = yield* tx
    .select()
    .from(V2StructuredOutputEvidenceTable)
    .where(eq(V2StructuredOutputEvidenceTable.run_id, input.runId))
    .get()
    .pipe(Effect.orDie)
  if (existing) {
    if (
      existing.schema_name !== input.schemaName ||
      existing.validation_outcome !== input.validationOutcome ||
      existing.output_sha256 !== outputSha256 ||
      existing.schema_sha256 !== schemaSha256 ||
      existing.raw_output !== input.rawOutput ||
      existing.output_message_id !== (input.outputMessageId ?? null)
    )
      return yield* new StructuredEvidenceConflict({ runId: input.runId, reason: "divergence" })
    return fromEvidenceRow(existing)
  }
  const evidence: StructuredEvidence = {
    evidenceId: Identifier.ascending("job"),
    runId: run.run_id,
    sessionId: run.parent_session_id,
    childSessionId: run.child_session_id,
    ...(input.outputMessageId === undefined ? {} : { outputMessageId: input.outputMessageId }),
    schemaName: input.schemaName,
    validationOutcome: input.validationOutcome,
    outputSha256,
    schemaSha256,
    rawOutput: input.rawOutput,
    ownerToken: input.ownerToken,
    timeCreated: input.now ?? Date.now(),
  }
  yield* tx
    .insert(V2StructuredOutputEvidenceTable)
    .values({
      evidence_id: evidence.evidenceId,
      run_id: evidence.runId,
      session_id: evidence.sessionId,
      child_session_id: evidence.childSessionId,
      output_message_id: evidence.outputMessageId ?? null,
      schema_name: evidence.schemaName,
      validation_outcome: evidence.validationOutcome,
      output_sha256: evidence.outputSha256,
      schema_sha256: evidence.schemaSha256,
      raw_output: evidence.rawOutput,
      owner_token: evidence.ownerToken,
      time_created: evidence.timeCreated,
    })
    .run()
    .pipe(Effect.orDie)
  return evidence
})

/**
 * Reader for status/review surfaces: the durable structured-contract verdict of a run, or
 * undefined. A schema-bound V2 run that reads undefined after settling is missing its authority
 * evidence (crash between a foreground completed settle and the finalizer record) and needs
 * explicit recovery — the surface, not the reader, decides how to flag it.
 */
export const structuredEvidence = Effect.fn("TaskRunAuthority.structuredEvidence")(function* (
  db: DatabaseService,
  runID: string,
) {
  const row = yield* db
    .select()
    .from(V2StructuredOutputEvidenceTable)
    .where(eq(V2StructuredOutputEvidenceTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)
  return row ? fromEvidenceRow(row) : undefined
})

// The frozen execution_spec carries the V2 structured contract under `outputSchema`; the V1
// `structuredOutput` key stays V1-only, so the V1 trigger machinery never fires for V2 rows.
const runOutputSchema = (row: typeof TaskRunTable.$inferSelect) => {
  const schema = row.execution_spec?.outputSchema
  return typeof schema === "object" && schema !== null && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : undefined
}

function fromEvidenceRow(row: typeof V2StructuredOutputEvidenceTable.$inferSelect): StructuredEvidence {
  return {
    evidenceId: row.evidence_id,
    runId: row.run_id,
    sessionId: row.session_id,
    childSessionId: row.child_session_id,
    ...(row.output_message_id === null ? {} : { outputMessageId: row.output_message_id }),
    schemaName: row.schema_name,
    validationOutcome: row.validation_outcome,
    outputSha256: row.output_sha256,
    schemaSha256: row.schema_sha256,
    rawOutput: row.raw_output,
    ownerToken: row.owner_token,
    timeCreated: row.time_created,
  }
}

// ── Executor: claim → resume → join → settle ──────────────────────────────────────────────────
// The executor NEVER admits another prompt: the first input is durable (admitChildInput) and
// follow-up turns stay with the tool layer. Execution is SessionExecution.resume by Session ID.

export const execute = Effect.fn("TaskRunAuthority.execute")(function* (input: {
  readonly db: DatabaseService
  readonly run: Run
  readonly sessions: SessionV2.Interface
  readonly timeoutMs: number
  readonly leaseMs?: number
}) {
  const ownerToken = `core-v2-task:${Identifier.ascending("job")}`
  const claimed = yield* claim(input.db, { runID: input.run.runID, ownerToken, leaseMs: input.leaseMs })
  // An interrupted parent turn still owes the durable record a terminal settle; losing the fence
  // to a recovering owner is the fence doing its job, not an error.
  return yield* drainAndSettle(input, claimed, ownerToken).pipe(
    Effect.onInterrupt(() =>
      settle(input.db, {
        runID: input.run.runID,
        ownerToken,
        claimGeneration: claimed.claimGeneration,
        state: "interrupted",
        reason: "parent_interrupted",
        error: { code: "interrupted", message: "The parent turn interrupted the subagent." },
      }).pipe(Effect.ignore),
    ),
  )
})

const drainAndSettle = (
  input: {
    readonly db: DatabaseService
    readonly run: Run
    readonly sessions: SessionV2.Interface
    readonly timeoutMs: number
    readonly leaseMs?: number
  },
  claimed: Run,
  ownerToken: string,
) =>
  Effect.gen(function* () {
    const work = Effect.gen(function* () {
      const drain = yield* input.sessions
        .resume(input.run.childSessionID)
        .pipe(Effect.exit, Effect.timeoutOption(input.timeoutMs))
      const transcript = yield* input.sessions
        .messages({ sessionID: input.run.childSessionID, order: "asc" })
        .pipe(Effect.orDie)
      const research = lastAssistantText(transcript)
      const rawResultMessageID = lastAssistantMessageID(transcript)
      if (Option.isNone(drain)) {
        yield* input.sessions.interrupt(input.run.childSessionID).pipe(Effect.ignore)
        return { outcome: "timeout" as const, research, rawResultMessageID }
      }
      if (Exit.isSuccess(drain.value)) return { outcome: "completed" as const, research, rawResultMessageID }
      const failure = Option.getOrUndefined(Cause.findErrorOption(drain.value.cause))
      return { outcome: "failed" as const, research, rawResultMessageID, failureMessage: failureMessage(failure) }
    }).pipe(Effect.onInterrupt(() => input.sessions.interrupt(input.run.childSessionID).pipe(Effect.ignore)))

    const maintenance = renewLease(input.db, {
      runID: input.run.runID,
      ownerToken,
      claimGeneration: claimed.claimGeneration,
      leaseMs: input.leaseMs,
    }).pipe(
      Effect.repeat(Schedule.fixed(Duration.millis(Math.max(10, Math.floor((input.leaseMs ?? 30_000) / 3))))),
      Effect.andThen(Effect.never),
    )

    const result = yield* Effect.raceFirst(work, maintenance).pipe(
      Effect.catchTag("TaskRunAuthority.ClaimLost", (error) => new ExecutionLeaseLost({ runID: error.runID })),
    )

    // Terminal settle is the workspace release fence: after the run is durably terminal the
    // run-owned worktree is pruned best-effort (the receipt keeps the branch for the later PR
    // flow). An interrupted parent turn settles separately below and deliberately KEEPS the
    // workspace — the child stays resumable by task_id.
    const releaseWorkspace = TaskWorkspace.release(input.db, { runID: input.run.runID }).pipe(
      Effect.catchTag("TaskWorkspace.Error", (error) =>
        Effect.logWarning(`workspace release deferred (${error.code}): ${error.message}`).pipe(
          Effect.annotateLogs("runID", error.runID),
        ),
      ),
    )

    if (result.outcome === "completed") {
      yield* settle(input.db, {
        runID: input.run.runID,
        ownerToken,
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "core_v2_task_completed",
        output: result.research,
        rawResultMessageID: result.rawResultMessageID,
      })
      yield* releaseWorkspace
      return { outcome: result.outcome, research: result.research } as const
    }
    if (result.outcome === "timeout") {
      yield* settle(input.db, {
        runID: input.run.runID,
        ownerToken,
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "task_timeout",
        error: { code: "task_timeout", message: `Subagent timed out after ${input.timeoutMs}ms.` },
      })
      yield* releaseWorkspace
      return { outcome: result.outcome, research: result.research } as const
    }
    yield* settle(input.db, {
      runID: input.run.runID,
      ownerToken,
      claimGeneration: claimed.claimGeneration,
      state: "failed",
      reason: "child_drain_failed",
      error: { code: "child_drain_failed", message: result.failureMessage },
    })
    yield* releaseWorkspace
    return {
      outcome: result.outcome,
      research: result.research,
      failureMessage: result.failureMessage,
    } as const
  })

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────

export const get = Effect.fn("TaskRunAuthority.get")(function* (db: DatabaseService, runID: string) {
  return yield* loadRun(db, runID)
})

export const getByAdmission = Effect.fn("TaskRunAuthority.getByAdmission")(function* (
  db: DatabaseService,
  input: {
    readonly parentSessionID: SessionSchema.ID
    readonly parentMessageID: SessionMessage.ID
    readonly toolCallID: string
  },
) {
  const row = yield* db
    .select({ run: TaskRunTable })
    .from(TaskAdmissionTable)
    .innerJoin(TaskRunTable, eq(TaskRunTable.run_id, TaskAdmissionTable.run_id))
    .where(eq(TaskAdmissionTable.admission_key, admissionKey(input)))
    .get()
    .pipe(Effect.orDie)
  return row ? fromRow(row.run) : undefined
})

const loadRun = (db: Writer, runID: string) =>
  db
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)
    .pipe(Effect.map((row) => (row ? fromRow(row) : undefined)))

// ── Background notification (wave-2 dispatcher owns delivery) ─────────────────────────────────
// The settle transaction enqueues a QUEUED terminal notification for delivery_mode='background'.
// The process-global Core dispatcher that drains it is wave 2 and deliberately NOT built here.

const enqueueNotification = (tx: Transaction, row: typeof TaskRunTable.$inferSelect, now: number) =>
  Effect.gen(function* () {
    const session = yield* tx
      .select({ directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, row.parent_session_id))
      .get()
      .pipe(Effect.orDie)
    if (!session) return yield* Effect.die(`parent session missing: ${row.parent_session_id}`)
    const agent = typeof row.execution_spec?.agent === "string" ? row.execution_spec.agent : "general"
    const text = row.output ?? row.error?.message ?? row.reason ?? ""
    yield* tx
      .insert(TaskNotificationOutboxTable)
      .values({
        id: Identifier.ascending("job"),
        run_id: row.run_id,
        message_id: SessionV1.MessageID.make(`msg_tasknotify_${Hash.sha256(row.run_id).slice(0, 24)}`),
        parent_session_id: row.parent_session_id,
        directory: session.directory,
        payload: { agent, text },
        status: "pending",
        attempts: 0,
        available_at: now,
        time_created: now,
        time_updated: now,
        event_kind: "terminal",
        correlation_id: row.run_id,
        payload_hash: Hash.sha256(canonicalJson({ agent, text })),
      })
      .run()
      .pipe(Effect.orDie)
  })

// ── Shared helpers ────────────────────────────────────────────────────────────────────────────

const appendEvent = (
  db: Writer,
  row: typeof TaskRunTable.$inferSelect,
  type: string,
  fromState: string | null,
  toState: string | null,
  reason: string,
  now: number,
) =>
  db
    .insert(TaskRunEventTable)
    .values({
      event_id: Identifier.ascending("event"),
      run_id: row.run_id,
      version: row.version,
      type,
      from_state: fromState,
      to_state: toState,
      reason,
      time_created: now,
    })
    .run()
    .pipe(Effect.orDie)

const executionSpec = (spec: SubmitSpec): ExecutionSpec => ({
  runtime: "core_v2",
  agent: spec.agent,
  ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
  permissions: spec.child.permissions,
  ...(spec.child.workspace === undefined ? {} : { workspace: spec.child.workspace }),
})

const requestFingerprint = (spec: SubmitSpec) => ({
  prompt: Schema.encodeSync(Prompt)(spec.prompt),
  agent: spec.agent,
  outputSchema: spec.outputSchema ?? null,
  deliveryMode: spec.deliveryMode,
  permissions: spec.child.permissions,
  workspace: spec.child.workspace ?? null,
})

const outcomeHash = (input: SettleInput) =>
  Hash.sha256(
    canonicalJson({
      state: input.state,
      reason: input.reason,
      output: input.state === "completed" ? input.output ?? null : null,
      error: input.state === "completed" ? null : input.error ?? { code: input.state, message: input.reason },
    }),
  )

const lastAssistantMessageID = (messages: readonly SessionMessage.Message[]) =>
  messages
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
    .at(-1)?.id

const lastAssistantText = (messages: readonly SessionMessage.Message[]) =>
  messages
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
    .flatMap((message) => message.content)
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .at(-1)?.text ?? ""

const failureMessage = (failure: unknown) => {
  const message = failure instanceof Error && failure.message.trim() ? failure.message : String(failure ?? "unknown")
  return message.slice(0, 300)
}

/** Stable request hashing: key-sorted JSON so structurally equal requests hash equal. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function fromRow(row: typeof TaskRunTable.$inferSelect): Run {
  return {
    runID: row.run_id,
    parentSessionID: row.parent_session_id,
    parentMessageID: SessionMessage.ID.make(row.parent_message_id),
    toolCallID: row.tool_call_id,
    childSessionID: row.child_session_id,
    childMessageID: SessionMessage.ID.make(row.child_message_id ?? `msg_task_${Hash.sha256(row.run_id).slice(0, 24)}`),
    deliveryMode: row.delivery_mode,
    state: row.state,
    inputState: row.input_state,
    generation: row.generation,
    version: row.version,
    claimGeneration: row.claim_generation,
    ...(row.execution_owner === null ? {} : { executionOwner: row.execution_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  }
}
