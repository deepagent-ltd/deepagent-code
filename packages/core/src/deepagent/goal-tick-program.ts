export * as GoalTickProgram from "./goal-tick-program"

import { Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { GoalTickCheckpointSchema } from "./goal-tick-checkpoint.schema"

// Pure, versioned storage contracts only. Decoding these values grants no execution or policy authority.
export const MAX_BYTES = 1_048_576
export const RESULT_BYTES = 2048
export const EFFECT_BYTES = 2048
export const ACTIVATION_BYTES = 1024
export const DISPOSITION_BYTES = 512
export const DOCUMENT_METADATA_BYTES = 2048
export const FULL_DOCUMENT_METADATA_BYTES = 8192
export const Ref = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:~-]{1,128}$/))
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const SmallIndex = Count.check(Schema.isLessThanOrEqualTo(63))
const DocumentID = Schema.String.check(Schema.isPattern(/^doc:[a-z_]+:[A-Za-z0-9_.:-]{1,100}$/))

export const Recipe = Schema.Struct({
  id: Schema.Literals(["goal-worker-v2", "goal-reviewer-v2", "goal-panel-v2"]),
  hash: Hash,
  schemaHash: Hash,
  // Immutable program indices, never completion-order indices. Actual result dependencies are checked by the store.
  dependencies: Schema.Array(SmallIndex).check(Schema.isMaxLength(64)),
})
export const Role = Schema.Struct({
  key: Ref,
  agent: Ref,
  kind: Schema.Literals(["worker", "reviewer", "panel"]),
  ordinal: SmallIndex,
  criterion: Schema.NullOr(SmallIndex),
  round: Schema.NullOr(Count.check(Schema.isLessThanOrEqualTo(2))),
  lens: Schema.NullOr(Count.check(Schema.isLessThanOrEqualTo(7))),
  mode: Schema.Literals(["plain", "structured"]),
  policyHash: Hash,
  scratch: Schema.optional(
    Schema.Struct({
      documentID: DocumentID,
      payload: Schema.String,
      payloadHash: Hash,
      parentDocumentID: DocumentID,
      parentVersion: Count,
      parentHash: Hash,
      criteriaHash: Hash,
    }),
  ),
  recipe: Recipe,
})
export type Role = typeof Role.Type

export const Document = Schema.Struct({
  id: DocumentID,
  kind: Schema.Literals(["plan", "state", "worklog", "diagnosis", "completion", "link"]),
  // Includes JSON string quoting/escaping in the journal, not just the document body's UTF-8 bytes.
  payloadBytes: Count.check(Schema.isLessThanOrEqualTo(262144)),
  bodyBytes: Count.check(Schema.isLessThanOrEqualTo(131072)),
  metadataHash: Hash,
  links: Schema.Array(DocumentID).check(Schema.isMaxLength(8)),
})
export const PlanLineage = Schema.Struct({
  version: Schema.Literal(1),
  planRevision: Count,
  rebaseID: Schema.NullOr(Ref),
  sourceReceiptHash: Hash,
  planDocID: DocumentID,
  planDocVersion: Count,
  planDocHash: Hash,
  baselineDocsHash: Hash,
})
export type PlanLineage = typeof PlanLineage.Type
export const ProgramV2 = Schema.Struct({
  version: Schema.Literal(2),
  contract: Schema.Literal("owned-goal-v2"),
  roles: Schema.Array(Role).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  documents: Schema.Array(Document).check(Schema.isMaxLength(8)),
  localEffectSlots: Count.check(Schema.isLessThanOrEqualTo(33)),
  nextStateBytes: Count.check(Schema.isLessThanOrEqualTo(131072)),
})
export const ProgramV3 = Schema.Struct({
  ...ProgramV2.fields,
  version: Schema.Literal(3),
  planLineage: PlanLineage,
})
export const Program = Schema.Union([ProgramV2, ProgramV3])
export type Program = typeof Program.Type

export const Activation = Schema.Struct({
  role: SmallIndex,
  recipeHash: Hash,
  dependencies: Schema.Struct({ count: Count, through: Count, hash: Hash }),
  promptHash: Hash,
  unitID: Ref,
  // Prompt bytes remain in the stable Goal input, not duplicated in this bounded journal.
  inputID: Ref,
  activatedAt: Count,
})
export type Activation = typeof Activation.Type
export const Disposition = Schema.Struct({
  role: SmallIndex,
  kind: Schema.Literals(["completed", "skipped"]),
  rule: Schema.Literals(["actual-result-v2", "cheap-gate-v2", "panel-converged-v2", "terminal-decision-v2"]),
  evidence: Schema.Struct({ count: Count, through: Count, hash: Hash }),
})
export type Disposition = typeof Disposition.Type

const Output = Schema.Struct({ ref: Ref, hash: Hash, bytes: Count, truncated: Schema.Boolean })
export const LocalEffect = Schema.Struct({
  version: Schema.Literal(2),
  id: Ref,
  kind: Schema.Literals(["validation", "rollback"]),
  commandHash: Hash,
  cwdHash: Hash,
  profileHash: Hash,
  instanceID: Ref,
  handleID: Ref,
  state: Schema.Literals([
    "prepared",
    "dispatched",
    "exited",
    "cancelled_before_dispatch",
    "stop_confirmed",
    "unknown",
  ]),
  // A command exit and termination of every process/effect are deliberately different observations.
  outcome: Schema.NullOr(Schema.Literals(["passed", "failed", "cancelled"])),
  containment: Schema.Literals(["single-process", "posix-group", "windows-job", "linux-cgroup", "uncontained"]),
  stopProof: Schema.Literals([
    "not_requested",
    "not_started",
    "owned_process_exit",
    "contained_tree_exit",
    "unconfirmed",
  ]),
  exitCode: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 }))),
  signal: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{1,32}$/))),
  stdout: Schema.NullOr(Output),
  stderr: Schema.NullOr(Output),
  startedAt: Count,
  endedAt: Schema.NullOr(Count),
})
export type LocalEffect = typeof LocalEffect.Type

export const FullDocument = Schema.Struct({
  documentID: DocumentID,
  expectedVersion: Schema.NullOr(Count),
  expectedHash: Schema.NullOr(Hash),
  // Entire canonical Doc sans hash; includes type/scope/links/provenance/extensions/version/body.
  payload: Schema.String,
  payloadHash: Hash,
  state: Schema.Literals(["pending", "confirmed"]),
  observedVersion: Schema.NullOr(Count),
  observedHash: Schema.NullOr(Hash),
})
export const JournalV2 = Schema.Struct({
  version: Schema.Literal(2),
  program: ProgramV2,
  programHash: Hash,
  parent: GoalTickCheckpointSchema.Parent,
  cursor: GoalTickCheckpointSchema.Cursor,
  activations: Schema.Array(Activation).check(Schema.isMaxLength(64)),
  dispositions: Schema.Array(Disposition).check(Schema.isMaxLength(64)),
  results: Schema.Array(GoalTickCheckpointSchema.Result).check(Schema.isMaxLength(192)),
  localEffects: Schema.Array(LocalEffect).check(Schema.isMaxLength(33)),
  documents: Schema.Array(FullDocument).check(Schema.isMaxLength(8)),
  nextState: Schema.NullOr(Schema.String),
  nextStateHash: Schema.NullOr(Hash),
})
export const JournalV3 = Schema.Struct({
  ...JournalV2.fields,
  version: Schema.Literal(3),
  program: ProgramV3,
})
export const Journal = Schema.Union([JournalV2, JournalV3])
export type Journal = typeof Journal.Type

export const DocumentPayload = Schema.Struct({
  id: DocumentID,
  type: Schema.Literals(["plan", "run_context", "worklog", "diagnosis", "decision"]),
  scope: Ref,
  status: Schema.Literals(["draft", "candidate", "active", "superseded", "rejected", "quarantined", "provisional"]),
  version: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  superseded_by: Schema.NullOr(DocumentID),
  created_round: Schema.NullOr(Count),
  domain: Schema.NullOr(Ref),
  tags: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(32)),
  description: Schema.String.check(Schema.isMaxLength(512)),
  provenance: Schema.Record(Schema.String, Schema.Unknown),
  links: Schema.Array(
    Schema.Struct({ rel: Ref, to: DocumentID, note: Schema.optional(Schema.String.check(Schema.isMaxLength(512))) }),
  ).check(Schema.isMaxLength(8)),
  extensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  body: Schema.String,
})
export type DocumentPayload = typeof DocumentPayload.Type

export function documentMetadata(document: DocumentPayload) {
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !["version", "superseded_by", "body"].includes(key)),
  )
}

/** The body's double encoding is reserved separately from the exact immutable Doc metadata. */
export function documentBudget(document: DocumentPayload, kind: (typeof Document.Type)["kind"], bodyBytes: number) {
  if (!Schema.is(DocumentPayload)(document) || bodyBytes < bytes(canonical(document.body)))
    throw invalid("Document template does not fit its body allocation")
  if (bytes(canonical(documentMetadata(document))) > FULL_DOCUMENT_METADATA_BYTES)
    throw capacity("Full document metadata exceeds its separate encoding bound")
  const declared = {
    id: document.id,
    kind,
    payloadBytes: bytes(canonical({ ...document, body: "" })) + bodyBytes - bytes(canonical("")),
    bodyBytes,
    metadataHash: hash(documentMetadata(document)),
    links: document.links.map((link) => link.to),
  }
  if (!Schema.is(Document)(declared)) throw capacity("Full document template exceeds its declared maximum")
  return declared
}

export class Error extends Schema.TaggedErrorClass<Error>()("GoalTickProgram.Error", {
  code: Schema.Literals(["PROGRAM_INVALID", "PROGRAM_CAPACITY", "PROGRAM_CONFLICT"]),
  message: Schema.String,
}) {}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== "object") throw invalid("Non-JSON values cannot form a stable fingerprint")
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
    .join(",")}}`
}

export const bytes = (value: unknown) => Buffer.byteLength(canonical(value))
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")

export function validate(program: Program) {
  if (!Schema.is(Program)(program)) throw invalid("Program shape is invalid")
  if (new Set(program.roles.map((role) => role.key)).size !== program.roles.length)
    throw invalid("Role identity is duplicated")
  const identities = program.roles.map((role) =>
    [role.kind, role.ordinal, role.criterion, role.round, role.lens].join(":"),
  )
  if (new Set(identities).size !== identities.length) throw invalid("Role coordinates are duplicated")
  program.roles.forEach((role, index) => {
    if (
      role.recipe.dependencies.some((prior) => prior >= index) ||
      new Set(role.recipe.dependencies).size !== role.recipe.dependencies.length
    )
      throw invalid("Role dependencies must be an exact preceding set")
    if (
      role.kind === "worker"
        ? role.criterion !== null || role.round !== null || role.lens !== null
        : role.criterion === null
    )
      throw invalid("Role coordinates do not match their kind")
    if (role.kind === "panel" ? role.round === null || role.lens === null : role.round !== null || role.lens !== null)
      throw invalid("Panel coordinates do not match their kind")
    if (role.recipe.id !== `goal-${role.kind}-v2`) throw invalid("Role recipe does not match its kind")
    if (role.scratch) {
      const payload = Schema.decodeUnknownOption(Schema.fromJsonString(DocumentPayload))(role.scratch.payload)
      if (
        role.kind !== "worker" ||
        role.mode !== "plain" ||
        Option.isNone(payload) ||
        payload.value.id !== role.scratch.documentID ||
        payload.value.type !== "plan" ||
        payload.value.version !== 1 ||
        payload.value.links.length !== 0 ||
        payload.value.superseded_by !== null ||
        role.scratch.parentVersion < 1 ||
        role.scratch.payloadHash !== hash(role.scratch.payload) ||
        canonical(payload.value) !== role.scratch.payload
      )
        throw invalid("Scratch initialization is not an exact immutable worker document")
      if (bytes(role.scratch) > 131072) throw capacity("Scratch initialization exceeds its encoded per-unit slot")
    }
  })
  const ids = new Set(program.documents.map((doc) => doc.id))
  if (ids.size !== program.documents.length) throw invalid("Document identity is duplicated")
  program.documents.forEach((doc) => {
    if (new Set(doc.links).size !== doc.links.length || doc.links.some((id) => !ids.has(id) || id === doc.id))
      throw invalid("Document links are outside the exact set")
    if (doc.kind !== "link" && doc.payloadBytes < doc.bodyBytes)
      throw invalid("Full document slot is smaller than its body slot")
  })
  return program
}

/** Reserve every possible remaining field before external work. Mutable slots cannot borrow from each other. */
export function reservation(program: Program, parent: typeof GoalTickCheckpointSchema.Parent.Type) {
  validate(program)
  if (!Schema.is(GoalTickCheckpointSchema.Parent)(parent)) throw invalid("Parent shape is invalid")
  const empty = Schema.decodeUnknownSync(Journal)({
    version: program.version,
    program,
    programHash: hash(program),
    parent,
    cursor: { role: 0, stage: program.roles[0].mode === "plain" ? "plain" : "research" },
    activations: [],
    dispositions: [],
    results: [],
    localEffects: [],
    documents: [],
    nextState: null,
    nextStateHash: null,
  })
  const stageSlots = program.roles.reduce((sum, role) => sum + (role.mode === "plain" ? 1 : 3), 0)
  const total =
    bytes(empty) +
    program.roles.length * (ACTIVATION_BYTES + DISPOSITION_BYTES + 2) +
    stageSlots * (RESULT_BYTES + 1) +
    program.localEffectSlots * (EFFECT_BYTES + 1) +
    program.documents.reduce((sum, doc) => sum + doc.payloadBytes + DOCUMENT_METADATA_BYTES + 1, 0) +
    program.nextStateBytes +
    128
  if (total > MAX_BYTES) throw capacity("Program cannot reserve all remaining journal slots")
  return { bytes: total, stageSlots, empty }
}

/** Structural consistency only. A store must re-read actual source/result/OS facts; a decoded journal is not authority. */
export function validateJournal(journal: Journal) {
  if (!Schema.is(Journal)(journal)) throw invalid("Journal shape is invalid")
  const reserved = reservation(journal.program, journal.parent)
  if (journal.programHash !== hash(journal.program)) throw invalid("Program hash differs")
  if (
    journal.activations.some((value) => bytes(value) > ACTIVATION_BYTES) ||
    journal.dispositions.some((value) => bytes(value) > DISPOSITION_BYTES) ||
    journal.results.some((value) => bytes(value) > RESULT_BYTES) ||
    journal.localEffects.some((value) => bytes(value) > EFFECT_BYTES)
  )
    throw capacity("A fixed receipt slot exceeds its reserved encoding")
  if (journal.localEffects.length > journal.program.localEffectSlots || journal.results.length > reserved.stageSlots)
    throw capacity("Receipt slots are exhausted")
  if (new Set(journal.localEffects.map((item) => item.id)).size !== journal.localEffects.length)
    throw invalid("Local effect identity is duplicated")
  journal.localEffects.forEach(validateLocalEffect)
  const roles = new Set<number>()
  journal.activations.forEach((activation) => {
    if (
      roles.has(activation.role) ||
      !journal.program.roles[activation.role] ||
      activation.recipeHash !== journal.program.roles[activation.role].recipe.hash
    )
      throw invalid("Role activation is duplicated or differs from its recipe")
    roles.add(activation.role)
  })
  if (new Set(journal.activations.map((item) => item.unitID)).size !== journal.activations.length)
    throw invalid("Activation unit identity is duplicated")
  for (const key of ["inputID", "activityID", "messageID", "executionID"] as const) {
    if (new Set(journal.results.map((result) => result[key])).size !== journal.results.length)
      throw invalid("Result execution identity is duplicated")
  }
  const terminal = new Set<number>()
  journal.activations.forEach((activation) => {
    const role = journal.program.roles[activation.role]
    const results = journal.results.filter((result) => result.unitID === activation.unitID)
    const stages = role.mode === "plain" ? ["plain"] : ["research", "finalizer.1", "finalizer.2"]
    if (activation.inputID !== inputID(activation.unitID, stages[0]))
      throw invalid("Activation input differs from its stable identity")
    if (
      results.length > stages.length ||
      results.some(
        (result, index) =>
          result.stage !== stages[index] ||
          result.inputID !== inputID(activation.unitID, result.stage) ||
          ((result.stage === "plain" || result.stage === "research") && result.outcome !== "valid"),
      ) ||
      (results.length === 3 && results[1].outcome !== "schema_invalid")
    )
      throw invalid("Result stage order differs from its activation")
    if (
      (role.mode === "plain" && results.length === 1) ||
      (role.mode === "structured" && (results.length === 3 || (results.length === 2 && results[1].outcome === "valid")))
    )
      terminal.add(activation.role)
  })
  if (journal.results.some((result) => !journal.activations.some((activation) => activation.unitID === result.unitID)))
    throw invalid("Result has no activated unit")
  const dispositions = new Set<number>()
  journal.dispositions.forEach((value) => {
    if (
      dispositions.has(value.role) ||
      !journal.program.roles[value.role] ||
      (value.kind === "completed"
        ? !terminal.has(value.role) || value.rule !== "actual-result-v2"
        : roles.has(value.role) || value.rule === "actual-result-v2")
    )
      throw invalid("Role disposition is inconsistent")
    dispositions.add(value.role)
  })
  const roleIndex = journal.program.roles.findIndex((_, index) => !dispositions.has(index))
  const activation = journal.activations.find((item) => item.role === roleIndex)
  const results = journal.results.filter((item) => item.unitID === activation?.unitID)
  const stage =
    roleIndex < 0 || journal.program.roles[roleIndex].mode === "plain"
      ? "plain"
      : results.length === 0
        ? "research"
        : results.length === 1
          ? "finalizer.1"
          : results[1].outcome === "schema_invalid"
            ? "finalizer.2"
            : "finalizer.1"
  if (
    journal.cursor.role !== (roleIndex < 0 ? journal.program.roles.length : roleIndex) ||
    journal.cursor.stage !== stage
  )
    throw invalid("Cursor differs from the actual role dispositions and stage receipts")
  const docs = new Set<string>()
  journal.documents.forEach((doc) => {
    const declared = journal.program.documents.find((item) => item.id === doc.documentID)
    if (!declared || docs.has(doc.documentID) || doc.payloadHash !== hash(doc.payload))
      throw invalid("Document projection is not in the exact set")
    if (bytes(doc.payload) > declared.payloadBytes || bytes({ ...doc, payload: "" }) > DOCUMENT_METADATA_BYTES)
      throw capacity("Document exceeds its separate reserved slot")
    if ((doc.expectedVersion === null) !== (doc.expectedHash === null))
      throw invalid("Document creation must have no prior revision")
    if (doc.expectedVersion !== null && doc.expectedVersion < 1)
      throw invalid("Document prior revision must be positive")
    if (
      doc.state === "pending"
        ? doc.observedVersion !== null || doc.observedHash !== null
        : doc.observedVersion === null || doc.observedHash === null
    )
      throw invalid("Document confirmation does not match its observed revision")
    const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(doc.payload)
    const decoded = Option.isSome(json) ? Schema.decodeUnknownOption(DocumentPayload)(json.value) : Option.none()
    if (Option.isNone(decoded)) throw invalid("Full document payload is invalid")
    const payload = decoded.value
    if (
      canonical(payload) !== doc.payload ||
      payload.id !== doc.documentID ||
      payload.scope !== `run:${journal.parent.sessionID}` ||
      hash(documentMetadata(payload)) !== declared.metadataHash ||
      canonical(payload.links.map((link) => link.to)) !== canonical(declared.links) ||
      (doc.expectedVersion === null
        ? payload.version !== 1
        : ![doc.expectedVersion, doc.expectedVersion + 1].includes(payload.version)) ||
      payload.superseded_by !== null ||
      bytes(canonical(documentMetadata(payload))) > FULL_DOCUMENT_METADATA_BYTES ||
      bytes(canonical(payload.body)) > declared.bodyBytes
    )
      throw invalid("Full document identity, metadata, body or links differs from its frozen declaration")
    const types = {
      plan: "plan",
      state: "run_context",
      worklog: "worklog",
      diagnosis: "diagnosis",
      completion: "decision",
      link: null,
    }
    if (types[declared.kind] !== payload.type) throw invalid("Document type differs from its declared purpose")
    if (doc.state === "confirmed" && (doc.observedVersion !== payload.version || doc.observedHash !== hash(payload)))
      throw invalid("Document confirmation differs from its full payload")
    docs.add(doc.documentID)
  })
  if (journal.nextState === null ? journal.nextStateHash !== null : journal.nextStateHash !== hash(journal.nextState))
    throw invalid("Next state hash differs")
  if (
    (journal.nextState !== null && bytes(journal.nextState) > journal.program.nextStateBytes) ||
    bytes(journal) > reserved.bytes
  )
    throw capacity("Journal exceeds its reservation")
  return reserved
}

export const inputID = (unitID: string, stage: string) => `msg_goalchild_${hash([unitID, stage]).slice(0, 40)}`

export function validateLocalEffect(effect: LocalEffect) {
  if (!Schema.is(LocalEffect)(effect)) throw invalid("Local effect shape is invalid")
  if (effect.endedAt !== null && effect.endedAt < effect.startedAt) throw invalid("Local effect time moved backwards")
  if (["prepared", "dispatched", "cancelled_before_dispatch"].includes(effect.state)) {
    if (
      effect.exitCode !== null ||
      effect.signal !== null ||
      effect.stdout !== null ||
      effect.stderr !== null ||
      (effect.state === "cancelled_before_dispatch"
        ? effect.outcome !== "cancelled" || effect.stopProof !== "not_started" || effect.endedAt === null
        : effect.outcome !== null || effect.stopProof !== "not_requested" || effect.endedAt !== null)
    )
      throw invalid("Unexecuted effect contains invented exit evidence")
    return effect
  }
  if (effect.state === "unknown") {
    if (effect.outcome !== null || effect.stopProof !== "unconfirmed")
      throw invalid("Unknown effect cannot claim a business outcome or stop")
    return effect
  }
  if (effect.endedAt === null || effect.stdout === null || effect.stderr === null)
    throw invalid("Terminal effect lacks actual completion evidence")
  if (effect.state === "stop_confirmed") {
    if ((effect.exitCode === null) === (effect.signal === null))
      throw invalid("Confirmed stop requires exactly one process exit status")
    if (
      effect.outcome !== "cancelled" ||
      (effect.containment === "single-process"
        ? effect.stopProof !== "owned_process_exit"
        : !["windows-job", "linux-cgroup"].includes(effect.containment) || effect.stopProof !== "contained_tree_exit")
    )
      throw invalid("Observed process group cannot certify a contained tree stop")
    return effect
  }
  if (
    effect.stopProof !== "not_requested" ||
    effect.exitCode === null ||
    effect.signal !== null ||
    effect.outcome !== (effect.exitCode === 0 ? "passed" : "failed")
  )
    throw invalid("Command exit outcome is inconsistent")
  return effect
}

function invalid(message: string) {
  return new Error({ code: "PROGRAM_INVALID", message })
}
function capacity(message: string) {
  return new Error({ code: "PROGRAM_CAPACITY", message })
}
