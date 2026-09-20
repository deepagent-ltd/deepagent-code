import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { count, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Project } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { V2StructuredOutputEvidenceTable } from "@deepagent-code/core/session/runner/v2-structured-output-evidence.sql"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { testEffect } from "./lib/effect"

// Worklist #29 part 2 — the V2 structured-output evidence authority: every schema-bound V2 task
// run terminal path writes exactly ONE immutable evidence row bound to the V2 session_message
// that carries the final answer; V2 runs never touch the frozen V1 evidence table.

type DatabaseService = Database.Interface["db"]

const stackOver = (database: Layer.Layer<Database.Service, unknown>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(Project.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projector, sessions)
}

const it = testEffect(stackOver(Database.layerFromPath(":memory:")))

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    events: yield* EventV2.Service,
    sessions: yield* SessionV2.Service,
  }
})

const directory = AbsolutePath.make("/tmp")

const outputSchema = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
} as const

const specFor = (
  parentSessionID: SessionSchema.ID,
  toolCallID = "call-structured-1",
  deliveryMode: "foreground" | "background" = "foreground",
  withSchema = true,
) => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode,
  prompt: new Prompt({ text: "Research and report the answer." }),
  agent: "general",
  ...(withSchema ? { outputSchema: outputSchema as Record<string, unknown> } : {}),
  child: {
    title: "task: structured evidence test",
    location: { directory },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
  },
})

const evidenceCount = (db: DatabaseService) =>
  db.select({ total: count() }).from(V2StructuredOutputEvidenceTable).get().pipe(Effect.orDie)

const receiptCount = (db: DatabaseService) =>
  db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie)

const v1EvidenceCount = (db: DatabaseService) =>
  db
    .get<{ total: number }>(sql`SELECT count(*) AS total FROM task_structured_output_evidence`)
    .pipe(Effect.orDie)
    .pipe(Effect.map((row) => row?.total ?? 0))

/** Raw assistant session_message row in the child session (the authority binding target). */
const insertAssistantMessage = (db: DatabaseService, sessionID: string, id: string, seq: number) =>
  db.run(
    sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (${id}, ${sessionID}, 'assistant', ${seq}, 1, 1, '{"type":"assistant","agent":"general"}')`,
  ).pipe(Effect.orDie)

const rawInsert = (db: DatabaseService, values: string) =>
  db.run(sql`
    INSERT INTO session_v2_structured_output_evidence (
      evidence_id, run_id, session_id, child_session_id, output_message_id, schema_name,
      validation_outcome, output_sha256, schema_sha256, raw_output, owner_token, time_created
    ) VALUES ${sql.raw(`(${values})`)}
  `)

const submitSchemaRun = (toolCallID: string, deliveryMode: "foreground" | "background" = "foreground") =>
  Effect.gen(function* () {
    const { db, events, sessions } = yield* services
    const parent = yield* sessions.create({ location: { directory } })
    return yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, toolCallID, deliveryMode))
  })

const finalizerInput = (
  runID: string,
  overrides: {
    readonly validationOutcome?: "validated" | "validation_failed" | "unvalidated"
    readonly rawOutput?: string
    readonly outputMessageId?: SessionMessage.ID
    readonly withoutMessage?: boolean
  } = {},
) => ({
  runId: runID,
  schemaName: "inline",
  schema: outputSchema as Record<string, unknown>,
  validationOutcome: overrides.validationOutcome ?? ("validated" as const),
  rawOutput: overrides.rawOutput ?? JSON.stringify({ answer: 42 }),
  ...(overrides.withoutMessage
    ? {}
    : { outputMessageId: overrides.outputMessageId ?? SessionMessage.ID.make("msg_final_answer") }),
  ownerToken: "core-v2-finalizer:test",
})

describe("V2 structured output evidence", () => {
  it.effect("schema guards: insert admits only run-bound V2 evidence; update/delete are forbidden", () =>
    Effect.gen(function* () {
      const { db } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-guard")
      yield* insertAssistantMessage(db, submitted.run.childSessionID, "msg_final_answer", 5)

      // Well-formed, lineage-bound, message-bound evidence inserts.
      const valid = yield* rawInsert(
        db,
        `'evid_ok', '${submitted.run.runID}', '${submitted.run.parentSessionID}', '${submitted.run.childSessionID}', 'msg_final_answer', 'inline', 'validated', '${"a".repeat(64)}', '${"b".repeat(64)}', '{"answer":42}', 'owner-guard', 1`,
      ).pipe(Effect.exit)
      expect(valid._tag).toBe("Success")
      expect((yield* evidenceCount(db))?.total).toBe(1)

      const reject = (values: string) => rawInsert(db, values).pipe(Effect.exit)
      const lineage = `'${submitted.run.runID}', '${submitted.run.parentSessionID}', '${submitted.run.childSessionID}'`
      const binding = `'msg_final_answer', 'inline'`
      const hashes = `'${"c".repeat(64)}', '${"d".repeat(64)}'`
      // wrong outcome vocabulary
      expect((yield* reject(`'e1', ${lineage}, ${binding}, 'validatedd', ${hashes}, '{}', 'o', 1`))._tag).toBe("Failure")
      // short hash
      expect((yield* reject(`'e2', ${lineage}, ${binding}, 'validated', '${"c".repeat(63)}', '${"d".repeat(64)}', '{}', 'o', 1`))._tag).toBe("Failure")
      // uppercase (non-hex) hash
      expect((yield* reject(`'e3', ${lineage}, ${binding}, 'validated', '${"C".repeat(64)}', '${"d".repeat(64)}', '{}', 'o', 1`))._tag).toBe("Failure")
      // empty schema label
      expect((yield* reject(`'e4', ${lineage}, 'msg_final_answer', ' ', 'validated', ${hashes}, '{}', 'o', 1`))._tag).toBe("Failure")
      // unknown run
      expect((yield* reject(`'e5', 'job_missing', '${submitted.run.parentSessionID}', '${submitted.run.childSessionID}', ${binding}, 'validated', ${hashes}, '{}', 'o', 1`))._tag).toBe("Failure")
      // lineage mismatch: child does not belong to the run
      expect((yield* reject(`'e6', '${submitted.run.runID}', '${submitted.run.parentSessionID}', 'ses_other_child', ${binding}, 'validated', ${hashes}, '{}', 'o', 1`))._tag).toBe("Failure")
      // output message must be an assistant message of the child session
      expect((yield* reject(`'e7', ${lineage}, 'msg_not_in_child', 'inline', 'validated', ${hashes}, '{}', 'o', 1`))._tag).toBe("Failure")
      // validated requires the binding message
      expect((yield* reject(`'e8', ${lineage}, NULL, 'inline', 'validated', ${hashes}, '{}', 'o', 1`))._tag).toBe("Failure")
      // empty owner token
      expect((yield* reject(`'e9', ${lineage}, ${binding}, 'validated', ${hashes}, '{}', ' ', 1`))._tag).toBe("Failure")

      // V1-runtime runs can never gain V2 evidence.
      const { sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "job_v1_guard",
          request_hash: "legacy",
          execution_runtime: "v1",
          parent_session_id: parent.id,
          parent_message_id: SessionV1.MessageID.make("msg_v1_guard"),
          tool_call_id: "call-v1-guard",
          child_session_id: SessionSchema.ID.make("ses_v1_guard"),
          generation: 1,
          delivery_mode: "foreground",
          phase: "admission",
          state: "admitted",
          input_state: "ready",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        (yield* reject(`'e10', 'job_v1_guard', '${parent.id}', 'ses_v1_guard', NULL, 'inline', 'unvalidated', ${hashes}, '{}', 'o', 1`))._tag,
      ).toBe("Failure")

      // Well-formed non-validated evidence without a message binding admits (nullable binding).
      const secondRun = yield* submitSchemaRun("call-structured-guard-2")
      expect(
        (yield* reject(`'e11', '${secondRun.run.runID}', '${secondRun.run.parentSessionID}', '${secondRun.run.childSessionID}', NULL, 'inline', 'unvalidated', ${hashes}, '', 'owner-guard', 1`))._tag,
      ).toBe("Success")

      expect((yield* evidenceCount(db))?.total).toBe(2)

      // Immutable and append-only: update and delete are refused by triggers.
      expect(
        (yield* db.run(sql`UPDATE session_v2_structured_output_evidence SET raw_output = 'tampered'`).pipe(Effect.exit))
          ._tag,
      ).toBe("Failure")
      expect(
        (yield* db.run(sql`DELETE FROM session_v2_structured_output_evidence`).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect((yield* evidenceCount(db))?.total).toBe(2)
    }),
  )

  it.effect("settle E2E: foreground completed defers to the finalizer, which writes evidence exactly once", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-e2e")
      const executed = yield* TaskRunAuthority.execute({ db, run: submitted.run, sessions, timeoutMs: 5_000 })
      expect(executed.outcome).toBe("completed")
      // Foreground completed: the finalizer candidate does not exist yet — no evidence at settle.
      expect((yield* evidenceCount(db))?.total).toBe(0)

      // The finalizer validated candidate arrives after post-settle child turns.
      yield* insertAssistantMessage(db, submitted.run.childSessionID, "msg_final_answer", 5)
      const evidence = yield* TaskRunAuthority.recordStructuredEvidence(db, finalizerInput(submitted.run.runID))
      expect(evidence.validationOutcome).toBe("validated")
      expect(evidence.outputMessageId).toBe("msg_final_answer")
      expect((yield* evidenceCount(db))?.total).toBe(1)

      // Binding + hashes are recorded and readable.
      const read = yield* TaskRunAuthority.structuredEvidence(db, submitted.run.runID)
      expect(read?.outputMessageId).toBe("msg_final_answer")
      expect(read?.outputSha256).toBe(createHash("sha256").update(JSON.stringify({ answer: 42 })).digest("hex"))
      expect(read?.schemaSha256).toBe(createHash("sha256").update(canonicalJson(outputSchema)).digest("hex"))
      expect(yield* TaskRunAuthority.structuredEvidence(db, "job_missing")).toBeUndefined()

      // Exact finalizer retry converges on the UNIQUE(run_id) CAS — still one row.
      const retry = yield* TaskRunAuthority.recordStructuredEvidence(db, finalizerInput(submitted.run.runID))
      expect(retry.evidenceId).toBe(evidence.evidenceId)
      expect((yield* evidenceCount(db))?.total).toBe(1)

      // Divergent re-record is a typed conflict, never an overwrite.
      const divergent = yield* TaskRunAuthority.recordStructuredEvidence(
        db,
        finalizerInput(submitted.run.runID, {
          validationOutcome: "validation_failed",
          rawOutput: "not json",
          withoutMessage: true,
        }),
      ).pipe(Effect.flip)
      expect(divergent).toMatchObject({ _tag: "TaskRunAuthority.StructuredEvidenceConflict" })
      expect((yield* evidenceCount(db))?.total).toBe(1)

      // The frozen V1 authority stays untouched by the whole V2 flow.
      expect(yield* v1EvidenceCount(db)).toBe(0)
    }),
  )

  it.effect("failed and background settles record unvalidated evidence inside the settle transaction", () =>
    Effect.gen(function* () {
      const { db } = yield* services
      // Failed settle: evidence is written in the SAME settle transaction (no finalizer follows).
      const failed = yield* submitSchemaRun("call-structured-failed")
      const claimed = yield* TaskRunAuthority.claim(db, { runID: failed.run.runID, ownerToken: "owner-f", leaseMs: 60_000, now: 1_000 })
      yield* TaskRunAuthority.settle(db, {
        runID: failed.run.runID,
        ownerToken: "owner-f",
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "child_drain_failed",
        error: { code: "child_drain_failed", message: "boom" },
        now: 2_000,
      })
      const failedEvidence = yield* TaskRunAuthority.structuredEvidence(db, failed.run.runID)
      expect(failedEvidence?.validationOutcome).toBe("unvalidated")
      expect(failedEvidence?.schemaName).toBe("execution_spec")

      // Exact re-settle converges; the evidence stays a single row.
      const again = yield* TaskRunAuthority.settle(db, {
        runID: failed.run.runID,
        ownerToken: "owner-f",
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "child_drain_failed",
        error: { code: "child_drain_failed", message: "boom" },
        now: 3_000,
      })
      expect(again.converged).toBeTrue()
      expect((yield* evidenceCount(db))?.total).toBe(1)

      // Interrupted settles record evidence too.
      const interrupted = yield* submitSchemaRun("call-structured-int")
      const claimedInt = yield* TaskRunAuthority.claim(db, { runID: interrupted.run.runID, ownerToken: "owner-i", leaseMs: 60_000, now: 1_000 })
      yield* TaskRunAuthority.settle(db, {
        runID: interrupted.run.runID,
        ownerToken: "owner-i",
        claimGeneration: claimedInt.claimGeneration,
        state: "interrupted",
        reason: "parent_interrupted",
        now: 2_000,
      })
      expect((yield* TaskRunAuthority.structuredEvidence(db, interrupted.run.runID))?.validationOutcome).toBe("unvalidated")

      // Background completed: no foreground finalizer follows the settle — evidence now.
      const background = yield* submitSchemaRun("call-structured-bg", "background")
      const claimedBg = yield* TaskRunAuthority.claim(db, { runID: background.run.runID, ownerToken: "owner-bg", leaseMs: 60_000, now: 1_000 })
      yield* insertAssistantMessage(db, background.run.childSessionID, "msg_bg_answer", 4)
      yield* TaskRunAuthority.settle(db, {
        runID: background.run.runID,
        ownerToken: "owner-bg",
        claimGeneration: claimedBg.claimGeneration,
        state: "completed",
        reason: "core_v2_task_completed",
        output: "the research text",
        rawResultMessageID: SessionMessage.ID.make("msg_bg_answer"),
        now: 2_000,
      })
      const bgEvidence = yield* TaskRunAuthority.structuredEvidence(db, background.run.runID)
      expect(bgEvidence?.validationOutcome).toBe("unvalidated")
      expect(bgEvidence?.rawOutput).toBe("the research text")
      expect(bgEvidence?.outputMessageId).toBe("msg_bg_answer")
      expect((yield* evidenceCount(db))?.total).toBe(3)
      expect(yield* v1EvidenceCount(db)).toBe(0)
    }),
  )

  it.effect("fail-closed: a settle whose in-transaction evidence recording diverges refuses to settle", () =>
    Effect.gen(function* () {
      const { db } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-fc")
      const claimed = yield* TaskRunAuthority.claim(db, { runID: submitted.run.runID, ownerToken: "owner-fc", leaseMs: 60_000, now: 1_000 })

      // Pre-seal divergent evidence (a stale/divergent prior record) — the settle must refuse.
      yield* insertAssistantMessage(db, submitted.run.childSessionID, "msg_final_answer", 3)
      yield* TaskRunAuthority.recordStructuredEvidence(db, finalizerInput(submitted.run.runID))

      const refused = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-fc",
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "child_drain_failed",
        error: { code: "child_drain_failed", message: "boom" },
        now: 2_000,
      }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "TaskRunAuthority.StructuredEvidenceConflict" })

      // Fail-closed: no silent terminal state without matching evidence — the run stays running
      // and no receipt exists.
      const run = yield* TaskRunAuthority.get(db, submitted.run.runID)
      expect(run?.state).toBe("running")
      expect((yield* receiptCount(db))?.total).toBe(0)
      expect((yield* evidenceCount(db))?.total).toBe(1)
    }),
  )

  it.effect("crash between settle and finalizer evidence: rolled-back insert leaves no row; retry writes exactly once", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-crash")
      const executed = yield* TaskRunAuthority.execute({ db, run: submitted.run, sessions, timeoutMs: 5_000 })
      expect(executed.outcome).toBe("completed")
      yield* insertAssistantMessage(db, submitted.run.childSessionID, "msg_final_answer", 5)

      // Simulated crash: the evidence insert commits inside a transaction that then dies — the
      // rollback leaves the database exactly as it was after the settle (no evidence row).
      const input = finalizerInput(submitted.run.runID)
      const crashed = yield* db
        .transaction((tx) =>
          TaskRunAuthority.recordStructuredEvidenceInTransaction(tx, input).pipe(
            Effect.andThen(Effect.die("crash after evidence")),
          ),
        )
        .pipe(Effect.exit)
      expect(crashed._tag).toBe("Failure")
      expect((yield* evidenceCount(db))?.total).toBe(0)

      // Retry converges by UNIQUE(run_id): exactly one row, idempotent on repeat.
      const first = yield* TaskRunAuthority.recordStructuredEvidence(db, input)
      const retry = yield* TaskRunAuthority.recordStructuredEvidence(db, input)
      expect(retry.evidenceId).toBe(first.evidenceId)
      expect((yield* evidenceCount(db))?.total).toBe(1)
      expect(yield* v1EvidenceCount(db)).toBe(0)
    }),
  )

  it.effect("validation_failed path: exhausted finalizer records the outcome without a message binding", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-vf")
      const executed = yield* TaskRunAuthority.execute({ db, run: submitted.run, sessions, timeoutMs: 5_000 })
      expect(executed.outcome).toBe("completed")

      // The finalizer ran out of bounded attempts; the last material failed validation.
      const input = finalizerInput(submitted.run.runID, {
        validationOutcome: "validation_failed",
        rawOutput: "not a json value",
        withoutMessage: true,
      })
      const evidence = yield* TaskRunAuthority.recordStructuredEvidence(db, input)
      expect(evidence.validationOutcome).toBe("validation_failed")
      expect(evidence.outputMessageId).toBeUndefined()
      yield* TaskRunAuthority.recordStructuredEvidence(db, input)
      expect((yield* evidenceCount(db))?.total).toBe(1)
      expect(yield* v1EvidenceCount(db)).toBe(0)
    }),
  )

  it.effect("schema-less runs settle with no evidence rows at all", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-structured-none", "foreground", false))
      const executed = yield* TaskRunAuthority.execute({ db, run: submitted.run, sessions, timeoutMs: 5_000 })
      expect(executed.outcome).toBe("completed")
      expect((yield* evidenceCount(db))?.total).toBe(0)
      expect(yield* TaskRunAuthority.structuredEvidence(db, submitted.run.runID)).toBeUndefined()
    }),
  )

  it.effect("recordStructuredEvidence refuses unknown and non-v2 runs", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "job_v1_refuse",
          request_hash: "legacy",
          execution_runtime: "v1",
          parent_session_id: parent.id,
          parent_message_id: SessionV1.MessageID.make("msg_v1_refuse"),
          tool_call_id: "call-v1-refuse",
          child_session_id: SessionSchema.ID.make("ses_v1_refuse"),
          generation: 1,
          delivery_mode: "foreground",
          phase: "admission",
          state: "admitted",
          input_state: "ready",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      for (const runId of ["job_missing", "job_v1_refuse"]) {
        const refused = yield* TaskRunAuthority.recordStructuredEvidence(
          db,
          finalizerInput(runId, { validationOutcome: "unvalidated", rawOutput: "", withoutMessage: true }),
        ).pipe(Effect.exit)
        expect(refused._tag).toBe("Failure")
      }
      expect((yield* evidenceCount(db))?.total).toBe(0)
    }),
  )

  it.effect("a failed settle binds its evidence to the child's last assistant message", () =>
    Effect.gen(function* () {
      const { db } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-hash")
      const claimed = yield* TaskRunAuthority.claim(db, { runID: submitted.run.runID, ownerToken: "owner-h", leaseMs: 60_000, now: 1_000 })
      yield* insertAssistantMessage(db, submitted.run.childSessionID, "msg_last_answer", 2)
      yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-h",
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "child_drain_failed",
        error: { code: "child_drain_failed", message: "boom" },
        rawResultMessageID: SessionMessage.ID.make("msg_last_answer"),
        now: 2_000,
      })
      const evidence = yield* TaskRunAuthority.structuredEvidence(db, submitted.run.runID)
      expect(evidence?.outputMessageId).toBe("msg_last_answer")
      expect(evidence?.outputSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(evidence?.schemaSha256).toBe(createHash("sha256").update(canonicalJson(outputSchema)).digest("hex"))
      // The schema hash pins the frozen execution_spec contract.
      const run = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, submitted.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(run?.execution_spec?.outputSchema).toEqual(outputSchema)
    }),
  )

  it.effect("recordStructuredEvidence fails closed when the binding message is missing", () =>
    Effect.gen(function* () {
      const { db } = yield* services
      const submitted = yield* submitSchemaRun("call-structured-bind")
      const refused = yield* TaskRunAuthority.recordStructuredEvidence(
        db,
        finalizerInput(submitted.run.runID, { outputMessageId: SessionMessage.ID.make("msg_never_created") }),
      ).pipe(Effect.exit)
      // (binding target deliberately never inserted)
      expect(refused._tag).toBe("Failure")
      expect((yield* evidenceCount(db))?.total).toBe(0)
    }),
  )
})

/** Key-sorted canonical JSON — mirrors the authority's stable hashing shape for assertions. */
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
