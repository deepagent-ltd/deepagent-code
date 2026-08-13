export * as DeepAgentLearningLifecycleTrigger from "./learning-lifecycle-trigger"

import path from "node:path"
import { readdir, realpath } from "node:fs/promises"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { writeFileExclusive } from "./atomic-write"
import { DeepAgentDurableLearning, type Admission } from "./durable-learning"
import { LearningLifecycleTriggerTable } from "./learning-lifecycle-trigger.sql"

type DatabaseClient = Database.Interface["db"]
export type Trigger = "idle" | "pause" | "project_switch"

export type SessionBoundary = {
  readonly trigger: "idle" | "pause"
  readonly boundaryKey: string
  readonly sessionID: string
  readonly match: "session" | "parent"
  readonly goalID?: string
}

export type ProjectBoundary = {
  readonly trigger: "project_switch"
  readonly boundaryKey: string
  readonly directory: string
}

export type ObserveInput = SessionBoundary | ProjectBoundary

export type Outcome =
  | { readonly state: "skipped"; readonly reason: "no_exact_settled_run" }
  | { readonly state: "prepared" | "admitted"; readonly receiptId: string; readonly runId: string }

export type RuntimeObserver = {
  readonly observe: (input: ObserveInput) => Promise<Outcome>
}

export type Options = {
  readonly authorityRoot: string
  readonly runsDir: string
  readonly now?: number
}

type Source = {
  readonly runDir: string
  readonly receiptPath: string
  readonly terminalContent: string
  readonly terminal: globalThis.Record<string, unknown>
  readonly admission: Admission
  readonly admissionHash: string
}

export class IdentityConflictError extends Schema.TaggedErrorClass<IdentityConflictError>()(
  "DeepAgentLearningLifecycleTrigger.IdentityConflictError",
  { trigger: Schema.String, sessionId: Schema.String, runId: Schema.String },
) {}

let runtimeObserver: RuntimeObserver | undefined

export const setRuntimeObserver = (observer: RuntimeObserver | undefined) => {
  runtimeObserver = observer
}

export const notify = (input: ObserveInput): Promise<Outcome> =>
  runtimeObserver?.observe(input) ?? Promise.resolve({ state: "skipped", reason: "no_exact_settled_run" })

export const observe = Effect.fn("DeepAgentLearningLifecycleTrigger.observe")(function* (
  db: DatabaseClient,
  input: ObserveInput,
  options: Options,
) {
  const authorityRoot = path.resolve(options.authorityRoot)
  const runsDir = path.resolve(options.runsDir)
  const source = yield* Effect.promise(() => latestSource(runsDir, input))
  if (!source) return { state: "skipped", reason: "no_exact_settled_run" } as const

  const seededAdmission = lifecycleAdmission(source, input)
  const artifact = lifecycleArtifact(source, input, seededAdmission)
  const admission: Admission = {
    ...seededAdmission,
    terminalArtifact: { ...seededAdmission.terminalArtifact, sha256: artifact.sha256 },
  }
  const prepared = yield* prepare(db, {
    input,
    admission,
    artifactPath: artifact.path,
    artifactHash: artifact.sha256,
    artifactJson: artifact.content,
    sourceAdmissionHash: source.admissionHash,
    sourceTerminalHash: Hash.sha256(source.terminalContent),
    now: options.now,
  })
  if (prepared.state === "admitted") {
    return { state: "admitted", receiptId: prepared.receiptId, runId: prepared.runId } as const
  }
  yield* submit(db, prepared, authorityRoot)
  return { state: "admitted", receiptId: prepared.receiptId, runId: prepared.runId } as const
})

export const recover = Effect.fn("DeepAgentLearningLifecycleTrigger.recover")(function* (
  db: DatabaseClient,
  options: Pick<Options, "authorityRoot">,
) {
  const rows = yield* db
    .select()
    .from(LearningLifecycleTriggerTable)
    .where(eq(LearningLifecycleTriggerTable.state, "prepared"))
    .orderBy(asc(LearningLifecycleTriggerTable.created_at), asc(LearningLifecycleTriggerTable.receipt_id))
  return yield* Effect.forEach(rows, (row) => submit(db, decode(row), path.resolve(options.authorityRoot)))
})

const prepare = Effect.fn("DeepAgentLearningLifecycleTrigger.prepare")(function* (
  db: DatabaseClient,
  input: {
    readonly input: ObserveInput
    readonly admission: Admission
    readonly artifactPath: string
    readonly artifactHash: string
    readonly artifactJson: string
    readonly sourceAdmissionHash: string
    readonly sourceTerminalHash: string
    readonly now?: number
  },
) {
  const fingerprint = DeepAgentDurableLearning.admissionFingerprint(input.admission)
  const receiptId = `learning-lifecycle:${Hash.sha256(
    `${input.input.trigger}:${input.admission.input.sessionID}:${input.admission.input.runID}`,
  )}`
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningLifecycleTriggerTable)
          .where(
            and(
              eq(LearningLifecycleTriggerTable.trigger, input.input.trigger),
              eq(LearningLifecycleTriggerTable.session_id, input.admission.input.sessionID),
              eq(LearningLifecycleTriggerTable.run_id, input.admission.input.runID),
            ),
          )
          .get()
        if (existing) {
          if (
            existing.receipt_id !== receiptId ||
            existing.boundary_key !== input.input.boundaryKey ||
            existing.source_admission_hash !== input.sourceAdmissionHash ||
            existing.source_terminal_hash !== input.sourceTerminalHash ||
            existing.artifact_path !== input.artifactPath ||
            existing.artifact_hash !== input.artifactHash ||
            existing.artifact_json !== input.artifactJson ||
            existing.admission_fingerprint !== fingerprint
          ) {
            return yield* new IdentityConflictError({
              trigger: input.input.trigger,
              sessionId: input.admission.input.sessionID,
              runId: input.admission.input.runID,
            })
          }
          return decode(existing)
        }
        const inserted = yield* tx
          .insert(LearningLifecycleTriggerTable)
          .values({
            receipt_id: receiptId,
            trigger: input.input.trigger,
            boundary_key: input.input.boundaryKey,
            session_id: input.admission.input.sessionID,
            run_id: input.admission.input.runID,
            source_admission_hash: input.sourceAdmissionHash,
            source_terminal_hash: input.sourceTerminalHash,
            artifact_path: input.artifactPath,
            artifact_hash: input.artifactHash,
            artifact_json: input.artifactJson,
            admission_fingerprint: fingerprint,
            admission_json: CanonicalJson.stringify(
              DeepAgentDurableLearning.localAdmissionReceipt(input.admission, "local_pending"),
            ),
            state: "prepared",
            error_detail: null,
            created_at: now,
            settled_at: null,
            updated_at: now,
          })
          .returning()
          .get()
        return decode(inserted)
      }),
    { behavior: "immediate" },
  )
})

const submit = Effect.fn("DeepAgentLearningLifecycleTrigger.submit")(function* (
  db: DatabaseClient,
  receipt: ReceiptRecord,
  authorityRoot: string,
) {
  if (receipt.state === "admitted") return receipt
  if (Hash.sha256(receipt.artifactJson) !== receipt.artifactHash) {
    return yield* new IdentityConflictError({
      trigger: receipt.trigger,
      sessionId: receipt.sessionId,
      runId: receipt.runId,
    })
  }
  yield* Effect.promise(() => publishArtifact(authorityRoot, receipt.artifactPath, receipt.artifactJson))
  const local = DeepAgentDurableLearning.admissionFromLocalReceipt(JSON.parse(receipt.admissionJson))
  if (
    !local ||
    local.admission.input.trigger !== receipt.trigger ||
    local.admission.input.sessionID !== receipt.sessionId ||
    local.admission.input.runID !== receipt.runId ||
    DeepAgentDurableLearning.admissionFingerprint(local.admission) !== receipt.admissionFingerprint
  ) {
    return yield* new IdentityConflictError({
      trigger: receipt.trigger,
      sessionId: receipt.sessionId,
      runId: receipt.runId,
    })
  }
  const admitted = yield* DeepAgentDurableLearning.admit(db, local.admission, { authorityRoot }).pipe(Effect.exit)
  if (admitted._tag === "Failure") {
    yield* db
      .update(LearningLifecycleTriggerTable)
      .set({ error_detail: String(admitted.cause), updated_at: Date.now() })
      .where(
        and(
          eq(LearningLifecycleTriggerTable.receipt_id, receipt.receiptId),
          eq(LearningLifecycleTriggerTable.state, "prepared"),
        ),
      )
    return yield* Effect.failCause(admitted.cause)
  }
  const now = Date.now()
  const updated = yield* db
    .update(LearningLifecycleTriggerTable)
    .set({ state: "admitted", error_detail: null, settled_at: now, updated_at: now })
    .where(
      and(
        eq(LearningLifecycleTriggerTable.receipt_id, receipt.receiptId),
        eq(LearningLifecycleTriggerTable.state, "prepared"),
      ),
    )
    .returning()
    .get()
  if (updated) return decode(updated)
  const current = yield* db
    .select()
    .from(LearningLifecycleTriggerTable)
    .where(eq(LearningLifecycleTriggerTable.receipt_id, receipt.receiptId))
    .get()
  if (current?.state === "admitted") return decode(current)
  return yield* new IdentityConflictError({
    trigger: receipt.trigger,
    sessionId: receipt.sessionId,
    runId: receipt.runId,
  })
})

async function latestSource(runsDir: string, input: ObserveInput): Promise<Source | undefined> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  const candidates = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => sourceFromRun(path.join(runsDir, entry.name), input)),
  )
  const eligible = candidates.filter((source): source is Source => source !== undefined)
  return eligible.toSorted(
    (left, right) =>
      sourceTime(right) - sourceTime(left) || right.admission.input.runID.localeCompare(left.admission.input.runID),
  )[0]
}

async function sourceFromRun(runDir: string, input: ObserveInput): Promise<Source | undefined> {
  const receiptPath = path.join(runDir, "LEARNING_ADMISSION_RECEIPT.json")
  const receiptContent = await Bun.file(receiptPath)
    .text()
    .catch(() => undefined)
  if (!receiptContent) return undefined
  const parsed = (() => {
    try {
      return JSON.parse(receiptContent) as unknown
    } catch {
      return undefined
    }
  })()
  const decoded = DeepAgentDurableLearning.admissionFromLocalReceipt(parsed)
  if (!decoded || decoded.receipt.state !== "submitted" || decoded.admission.input.trigger !== "session_finalization") {
    return undefined
  }
  if (!(await DeepAgentDurableLearning.validateLocalAdmissionReceipt(decoded.admission, runDir))) return undefined
  const terminalContent = await Bun.file(decoded.admission.terminalArtifact.path)
    .text()
    .catch(() => undefined)
  if (!terminalContent) return undefined
  const terminal = (() => {
    try {
      return JSON.parse(terminalContent) as globalThis.Record<string, unknown>
    } catch {
      return undefined
    }
  })()
  if (!terminal) return undefined
  const matches =
    input.trigger === "project_switch"
      ? path.resolve(decoded.admission.workspacePath) === path.resolve(input.directory)
      : input.match === "session"
        ? decoded.admission.input.sessionID === input.sessionID
        : terminal.parent_generic_agent_session_id === input.sessionID && terminal.goal_id === input.goalID
  if (!matches) return undefined
  return {
    runDir,
    receiptPath,
    terminalContent,
    terminal,
    admission: decoded.admission,
    admissionHash: Hash.sha256(CanonicalJson.stringify(decoded.receipt.admission_intent)),
  }
}

function lifecycleAdmission(source: Source, input: ObserveInput): Admission {
  const artifactPath = path.join(source.runDir, `LEARNING_LIFECYCLE_TRIGGER_${input.trigger.toUpperCase()}.json`)
  const admission: Admission = {
    ...source.admission,
    terminalArtifact: {
      schema_version: "deepagent-code.learning_lifecycle_trigger_artifact.v1",
      path: artifactPath,
      sha256: "0".repeat(64),
      learning_admission_fingerprint: "0".repeat(64),
      source_terminal_path: source.admission.terminalArtifact.path,
      source_terminal_sha256: source.admission.terminalArtifact.sha256,
      source_learning_admission_fingerprint: source.admission.terminalArtifact.learning_admission_fingerprint,
      source_admission_path: source.receiptPath,
      source_admission_sha256: source.admissionHash,
      trigger: input.trigger,
      boundary_key: input.boundaryKey,
      boundary_subject: input.trigger === "project_switch" ? path.resolve(input.directory) : input.sessionID,
      goal_id: input.trigger === "pause" ? (input.goalID ?? null) : null,
      source_session_relation: input.trigger === "project_switch" ? "workspace" : input.match,
    },
    input: { ...source.admission.input, trigger: input.trigger },
  }
  return {
    ...admission,
    terminalArtifact: {
      ...admission.terminalArtifact,
      learning_admission_fingerprint: DeepAgentDurableLearning.admissionFingerprint(admission),
    },
  }
}

function lifecycleArtifact(source: Source, input: ObserveInput, admission: Admission) {
  const content = CanonicalJson.stringify({
    schema_version: "deepagent-code.learning_lifecycle_trigger_receipt.v1",
    trigger: input.trigger,
    boundary_key: input.boundaryKey,
    boundary_subject: input.trigger === "project_switch" ? path.resolve(input.directory) : input.sessionID,
    goal_id: input.trigger === "pause" ? (input.goalID ?? null) : null,
    session_id: admission.input.sessionID,
    run_id: admission.input.runID,
    source_admission_path: source.receiptPath,
    source_admission_sha256: source.admissionHash,
    source_terminal_path: source.admission.terminalArtifact.path,
    source_terminal_sha256: source.admission.terminalArtifact.sha256,
    source_learning_admission_fingerprint: source.admission.terminalArtifact.learning_admission_fingerprint,
    learning_admission_fingerprint: admission.terminalArtifact.learning_admission_fingerprint,
    source_session_relation: input.trigger === "project_switch" ? "workspace" : input.match,
  })
  return { path: admission.terminalArtifact.path, content, sha256: Hash.sha256(content) }
}

async function publishArtifact(authorityRoot: string, artifactPath: string, content: string) {
  const root = await realpath(authorityRoot)
  const parent = await realpath(path.dirname(artifactPath))
  const relative = path.relative(root, parent)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Learning lifecycle artifact escapes authority root")
  if (await Bun.file(artifactPath).exists()) {
    if ((await Bun.file(artifactPath).text()) !== content)
      throw new Error("Learning lifecycle artifact identity conflict")
    return
  }
  try {
    writeFileExclusive(artifactPath, content)
  } catch (error) {
    if (!(await Bun.file(artifactPath).exists()) || (await Bun.file(artifactPath).text()) !== content) throw error
  }
}

function sourceTime(source: Source) {
  const value = source.terminal.updated_at
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

type ReceiptRecord = ReturnType<typeof decode>

function decode(row: typeof LearningLifecycleTriggerTable.$inferSelect) {
  return {
    receiptId: row.receipt_id,
    trigger: row.trigger,
    boundaryKey: row.boundary_key,
    sessionId: row.session_id,
    runId: row.run_id,
    sourceAdmissionHash: row.source_admission_hash,
    sourceTerminalHash: row.source_terminal_hash,
    artifactPath: row.artifact_path,
    artifactHash: row.artifact_hash,
    artifactJson: row.artifact_json,
    admissionFingerprint: row.admission_fingerprint,
    admissionJson: row.admission_json,
    state: row.state,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}
