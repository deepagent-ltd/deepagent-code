export * as DeepAgentLearningGeneration from "./learning-generation"

import path from "node:path"
import { readFile } from "node:fs/promises"
import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm"
import { Cause, Effect } from "effect"
import { Database } from "../database/database"
import { SessionTable } from "../session/sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { writeFileExclusive } from "./atomic-write"
import { DeepAgentDurableLearning, type Admission } from "./durable-learning"
import { LearningGenerationTable } from "./learning-generation.sql"

type DatabaseClient = Database.Interface["db"]

export type Boundary =
  | { readonly trigger: "idle"; readonly sessionID: string; readonly dueAt: number }
  | { readonly trigger: "pause"; readonly sessionID: string }
  | { readonly trigger: "project_switch"; readonly projectID: string }

export class GenerationConflictError extends Error {
  override readonly name = "DeepAgentLearningGeneration.GenerationConflictError"
}

/** Store the immutable evidence at settle, before any lifecycle signal can choose its trigger. */
export const record = Effect.fn("DeepAgentLearningGeneration.record")(function* (
  db: DatabaseClient,
  admission: Admission,
  settledAt = Date.now(),
) {
  if (admission.input.trigger !== "idle" || admission.terminalArtifact.schema_version !== "deepagent-code.learning_terminal_artifact.v1")
    return yield* Effect.fail(new GenerationConflictError("generation requires an unclaimed terminal admission"))
  const generationId = admission.input.runID
  if (!admission.input.evidence?.activity_id)
    return yield* Effect.fail(new GenerationConflictError("generation requires a settled activity"))
  const content = CanonicalJson.stringify({
    ...DeepAgentDurableLearning.localAdmissionReceipt(admission, "local_pending"),
    updated_at: "1970-01-01T00:00:00.000Z",
  })
  const hash = Hash.sha256(content)
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* tx.insert(LearningGenerationTable).values({
          generation_id: generationId,
          session_id: admission.input.sessionID,
          project_id: admission.input.projectID,
          activity_id: admission.input.evidence?.activity_id ?? "",
          workspace_path: path.resolve(admission.workspacePath),
          admission_json: content,
          admission_hash: hash,
          settled_at: settledAt,
          trigger: null,
          claimed_at: null,
          admitted_at: null,
        }).onConflictDoNothing()
        const row = yield* tx.select().from(LearningGenerationTable)
          .where(eq(LearningGenerationTable.generation_id, generationId)).get()
        if (!row || row.admission_hash !== hash || row.admission_json !== content)
          return yield* Effect.fail(new GenerationConflictError(`generation ${generationId} changed on retry`))
        return row
      }),
    { behavior: "immediate" },
  )
})

/** CAS chooses exactly one lifecycle trigger per settled activity, including across processes.
 * Pause may read the previous settled activity while a newer turn is active; idle and project
 * switch require the session execution claim to be released. */
export const claim = Effect.fn("DeepAgentLearningGeneration.claim")(function* (
  db: DatabaseClient,
  boundary: Boundary,
  now = Date.now(),
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const matching = boundary.trigger === "project_switch"
          ? eq(LearningGenerationTable.project_id, boundary.projectID)
          : eq(LearningGenerationTable.session_id, boundary.sessionID)
        const candidate = yield* tx.select({ generation: LearningGenerationTable }).from(LearningGenerationTable)
          .innerJoin(SessionTable, eq(LearningGenerationTable.session_id, SessionTable.id))
          .where(and(isNull(LearningGenerationTable.trigger), matching,
            ...(boundary.trigger === "pause" ? [] : [isNull(SessionTable.execution_claim_token)]),
            ...(boundary.trigger === "idle" ? [lte(LearningGenerationTable.settled_at, boundary.dueAt)] : [])))
          .orderBy(asc(LearningGenerationTable.settled_at), asc(LearningGenerationTable.generation_id)).get()
        if (!candidate) return undefined
        return yield* tx.update(LearningGenerationTable)
          .set({ trigger: boundary.trigger, claimed_at: now })
          .where(and(eq(LearningGenerationTable.generation_id, candidate.generation.generation_id), isNull(LearningGenerationTable.trigger)))
          .returning().get()
      }),
    { behavior: "immediate" },
  )
})

export const admitClaimed = Effect.fn("DeepAgentLearningGeneration.admitClaimed")(function* (
  db: DatabaseClient,
  row: typeof LearningGenerationTable.$inferSelect,
  authorityRoot: string,
) {
  if (!row.trigger) return yield* Effect.fail(new GenerationConflictError("generation is not claimed"))
  if (row.admitted_at !== null) return row
  if (Hash.sha256(row.admission_json) !== row.admission_hash)
    return yield* Effect.fail(new GenerationConflictError("generation payload hash changed"))
  const decoded = DeepAgentDurableLearning.admissionFromLocalReceipt(JSON.parse(row.admission_json))
  if (!decoded || decoded.receipt.state !== "local_pending" || decoded.admission.input.runID !== row.generation_id ||
    decoded.admission.input.sessionID !== row.session_id ||
    decoded.admission.input.projectID !== row.project_id ||
    decoded.admission.input.evidence?.activity_id !== row.activity_id ||
    path.resolve(decoded.admission.workspacePath) !== row.workspace_path ||
    path.resolve(decoded.admission.baseDir) !== path.resolve(authorityRoot))
    return yield* Effect.fail(new GenerationConflictError("generation payload identity changed"))
  const admission: Admission = {
    ...decoded.admission,
    input: { ...decoded.admission.input, trigger: row.trigger },
  }
  const fingerprint = DeepAgentDurableLearning.admissionFingerprint(admission)
  const content = CanonicalJson.stringify({
    schema_version: "deepagent_global_run_state.v1",
    run_id: row.generation_id,
    generic_agent_session_id: row.session_id,
    agent_mode: admission.input.mode,
    state: "completed",
    activity_id: row.activity_id,
    lifecycle_trigger: row.trigger,
    updated_at: new Date(row.claimed_at!).toISOString(),
    learning_admission_fingerprint: fingerprint,
  })
  const terminalPath = admission.terminalArtifact.path
  const existing = yield* Effect.promise(() => readFile(terminalPath, "utf8").catch(() => undefined))
  if (existing !== undefined && existing !== content)
    return yield* Effect.fail(new GenerationConflictError("generation terminal artifact changed"))
  if (existing === undefined) yield* Effect.sync(() => writeFileExclusive(terminalPath, content))
  yield* DeepAgentDurableLearning.admit(db, {
    ...admission,
    terminalArtifact: { ...admission.terminalArtifact, sha256: Hash.sha256(content), learning_admission_fingerprint: fingerprint },
  }, { authorityRoot })
  const updated = yield* db.update(LearningGenerationTable)
    .set({ admitted_at: Date.now() })
    .where(and(eq(LearningGenerationTable.generation_id, row.generation_id), eq(LearningGenerationTable.trigger, row.trigger), isNull(LearningGenerationTable.admitted_at)))
    .returning().get()
  return updated ?? row
})

export const recover = Effect.fn("DeepAgentLearningGeneration.recover")(function* (
  db: DatabaseClient,
  authorityRoot: string,
) {
  const rows = yield* db.select().from(LearningGenerationTable)
    .where(and(isNotNull(LearningGenerationTable.trigger), isNull(LearningGenerationTable.admitted_at)))
    .orderBy(asc(LearningGenerationTable.claimed_at), asc(LearningGenerationTable.generation_id))
  // A damaged generation remains visible for operator repair, but must not starve all other
  // learning jobs at every startup tick.
  return yield* Effect.forEach(rows, (row) => admitClaimed(db, row, authorityRoot).pipe(
    Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("learning generation recovery failed", {
          generationID: row.generation_id,
          cause,
        }).pipe(Effect.as(undefined))),
  ))
})

export const notify = Effect.fn("DeepAgentLearningGeneration.notify")(function* (
  db: DatabaseClient,
  boundary: Boundary,
  authorityRoot: string,
) {
  const claimed = yield* claim(db, boundary)
  if (!claimed) return undefined
  return yield* admitClaimed(db, claimed, authorityRoot)
})
