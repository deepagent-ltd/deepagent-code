export * as WorkToolPolicy from "./work-tool-policy"

import { and, asc, eq, sql } from "drizzle-orm"
import { Finish, ToolCall, ToolFailure } from "@deepagent-code/llm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import type { Tool } from "../tool/tool"
import type { ToolRegistry } from "../tool/registry"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SecurityNamespaceTable } from "../context-federation/sql"
import { SessionContextSelectionTable, SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { WorkAuthority } from "./work-authority"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkFileCapability } from "./work-file-capability"
import { WorkCommandSchema } from "./work-command.schema"
import { WorkCommandV2Schema } from "./work-command-v2.schema"
import { WorkWriteStageSchema } from "./work-write-stage.schema"
import { WorkChildAuthority } from "./work-child-authority"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./runner/v2-tool-effect.sql"
import type { V2ToolEffect } from "./runner/v2-tool-effect"

type Db = Database.Interface["db"]
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const ID = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 512))
const Identity = WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity
export const KnownRead = Schema.Struct({
  version: Schema.Literal(1),
  workID: ID, rootWorkID: ID, bindingHash: WorkAuthoritySchema.Digest, profileHash: WorkAuthoritySchema.Digest,
  controlRevision: Count, sessionID: ID, inputID: ID, activityID: ID, receiptID: ID, attemptID: ID,
  admissionID: ID, toolCallID: ID, assistantMessageID: ID, ownerToken: ID, sessionClaimToken: Count,
  toolID: Schema.Literal("read"), definitionHash: WorkAuthoritySchema.Digest, registrationGeneration: ID,
  inputHash: WorkAuthoritySchema.Digest, outcomeHash: WorkAuthoritySchema.Digest,
  securityNamespaceID: ID, locationKey: ID, projectScopeKey: ID, namespaceBindingHash: WorkAuthoritySchema.Digest,
  selectionID: ID, selectionHash: WorkAuthoritySchema.Digest, helperHash: WorkAuthoritySchema.Digest,
  rootIdentity: Identity, fileIdentity: Identity,
  relative: Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 2048)),
  offset: Count, bytes: Count, fileBytes: Count, scannedBytes: Count,
  observedHash: WorkAuthoritySchema.Digest, pageHash: WorkAuthoritySchema.Digest,
  observedAt: Count, expiresAt: Count, snapshot: Schema.Literal("stream_observation"),
})
export type KnownRead = typeof KnownRead.Type
export const READ_REFUSED = "Native project read was refused before reading a file. Use an authorized relative file path with explicit byteOffset and pageBytes (at most 51200); directory reads, offset/limit and references are unavailable."
export const ReadRefusalReason = Schema.Literals(["invalid_path", "outside_read_scope", "invalid_pagination"])
export const KnownReadRefusal = Schema.Struct({
  version: Schema.Literal(1), toolID: Schema.Literal("read"), outcome: Schema.Literal("refused_before_read"),
  workID: ID, rootWorkID: ID, bindingHash: WorkAuthoritySchema.Digest, profileHash: WorkAuthoritySchema.Digest,
  controlRevision: Count, sessionID: ID, inputID: ID, activityID: ID, receiptID: ID, attemptID: ID,
  admissionID: ID, toolCallID: ID, assistantMessageID: ID, ownerToken: ID, sessionClaimToken: Count,
  definitionHash: WorkAuthoritySchema.Digest, registrationGeneration: ID,
  inputHash: WorkAuthoritySchema.Digest, outcomeHash: WorkAuthoritySchema.Digest,
  securityNamespaceID: ID, locationKey: ID, projectScopeKey: ID, namespaceBindingHash: WorkAuthoritySchema.Digest,
  selectionID: ID, selectionHash: WorkAuthoritySchema.Digest, helperHash: WorkAuthoritySchema.Digest,
  rootIdentity: Identity, reason: ReadRefusalReason, observedAt: Count, expiresAt: Count,
})
export type KnownReadRefusal = typeof KnownReadRefusal.Type
export const ReadKnown = Schema.Union([KnownRead, KnownReadRefusal])
/** Local input/scope rejection only. This strict grammar also verifies older signed
 * before-read refusals; runtime defaults are applied only inside the admitted entry. */
export function readRefusalReason(input: unknown, binding: WorkAuthoritySchema.ProjectBinding): typeof ReadRefusalReason.Type | undefined {
  if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") return undefined
  const relative = input.path
  if (Buffer.byteLength(relative) > 2048 || /[\\:\u0000-\u001f\u007f]/.test(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")) return "invalid_path"
  const matches = (rule: { kind: "file" | "tree"; path: string }) => relative === rule.path ||
    (rule.kind === "tree" && relative.startsWith(`${rule.path}/`))
  if (binding.toolPolicy.fileScope.deny.some(matches) || !binding.toolPolicy.fileScope.read.some(matches)) return "outside_read_scope"
  if (!("byteOffset" in input) || !Number.isSafeInteger(input.byteOffset) || (input.byteOffset as number) < 0 ||
    !("pageBytes" in input) || !Number.isSafeInteger(input.pageBytes) || (input.pageBytes as number) < 1 || (input.pageBytes as number) > 51_200 ||
    Math.min(binding.toolPolicy.fileScope.maxReadBytes, binding.toolPolicy.fileScope.maxHashBytes) < 1 ||
    ("offset" in input && input.offset !== undefined) || ("limit" in input && input.limit !== undefined) ||
    ("reference" in input && input.reference !== undefined)) return "invalid_pagination"
  return undefined
}
export const WRITE_REFUSED = "Native write was refused before publication; the project target was not changed. Read its current version before making a new request."
export const KnownWrite = Schema.Struct({
  version: Schema.Literal(1), toolID: Schema.Literal("write"),
  workID: ID, rootWorkID: ID, bindingHash: WorkAuthoritySchema.Digest, profileHash: WorkAuthoritySchema.Digest,
  controlRevision: Count, sessionID: ID, inputID: ID, activityID: ID, receiptID: ID, attemptID: ID,
  admissionID: ID, toolCallID: ID, assistantMessageID: ID, ownerToken: ID, sessionClaimToken: Count,
  definitionHash: WorkAuthoritySchema.Digest, registrationGeneration: ID,
  inputHash: WorkAuthoritySchema.Digest, outcomeHash: WorkAuthoritySchema.Digest,
  securityNamespaceID: ID, locationKey: ID, projectScopeKey: ID, namespaceBindingHash: WorkAuthoritySchema.Digest,
  selectionID: ID, selectionHash: WorkAuthoritySchema.Digest, helperHash: WorkAuthoritySchema.Digest,
  rootIdentity: Identity, fileIdentity: Schema.NullOr(Identity), relative: WorkWriteStageSchema.Relative,
  stageID: ID, stageRequestHash: WorkAuthoritySchema.Digest, expected: WorkWriteStageSchema.Expected,
  nextHash: WorkAuthoritySchema.Digest, nextBytes: Count,
  outcome: Schema.Literals(["published", "refused_before_publish"]),
  observedAt: Count, expiresAt: Count, publication: Schema.Literal("optimistic_namespace_publish"),
})
export type KnownWrite = typeof KnownWrite.Type
export const KnownCommandV1 = Schema.Struct({
  version: Schema.Literal(1), toolID: Schema.Literal("managed_command"),
  workID: ID, rootWorkID: ID, bindingHash: WorkAuthoritySchema.Digest, profileHash: WorkAuthoritySchema.Digest,
  controlRevision: Count, sessionID: ID, inputID: ID, activityID: ID, receiptID: ID, attemptID: ID,
  admissionID: ID, toolCallID: ID, assistantMessageID: ID, ownerToken: ID, sessionClaimToken: Count,
  definitionHash: WorkAuthoritySchema.Digest, registrationGeneration: ID,
  inputHash: WorkAuthoritySchema.Digest, outcomeHash: WorkAuthoritySchema.Digest,
  securityNamespaceID: ID, locationKey: ID, projectScopeKey: ID, namespaceBindingHash: WorkAuthoritySchema.Digest,
  selectionID: ID, selectionHash: WorkAuthoritySchema.Digest, helperHash: WorkAuthoritySchema.Digest,
  rootIdentity: Identity, commandID: ID, recipeID: ID, recipeRevision: Count,
  recipeHash: WorkAuthoritySchema.Digest, commandRequestHash: WorkAuthoritySchema.Digest,
  runtimeHash: WorkAuthoritySchema.Digest, commandResultHash: WorkAuthoritySchema.Digest,
  observedAt: Count, expiresAt: Count,
})
export const KnownCommandV2 = Schema.Struct({ ...KnownCommandV1.fields,
  version: Schema.Literal(2), supervision: WorkCommandV2Schema.Supervision,
})
export const KnownCommand = Schema.Union([KnownCommandV1, KnownCommandV2])
export type KnownCommand = typeof KnownCommand.Type
export type Known = KnownRead | KnownReadRefusal | KnownWrite | KnownCommand

declare const recovered: unique symbol
export interface VerifiedRecovery { readonly [recovered]: true }

declare const witness: unique symbol
export interface Witness { readonly [witness]: true }
/** Host fixed-purpose sealing. No default, caller JSON, or general sign(payload) operation. */
export class LeafProof extends Context.Service<LeafProof, {
  readonly seal: (witness: Witness, outcomeHash: string) => Effect.Effect<string, WorkAuthoritySchema.Error>
  readonly verify: (effectID: string) => Effect.Effect<Known, WorkAuthoritySchema.Error>
  /** Requires a current authenticated operator mutation; authenticates original history only. */
  readonly authenticateHistorical?: (effectID: string, expectedControlRevision: number) => Effect.Effect<Known, WorkAuthoritySchema.Error>
  /** Storage retirement authenticates a known original result without minting execution
   * permission, refreshing a deadline or populating the execution proof cache. */
  readonly authenticateStorage?: (effectID: string) => Effect.Effect<KnownWrite | KnownCommand, WorkAuthoritySchema.Error>
  /** Fixed event accounting purpose. Authenticates known original terminal facts after expiry,
   * but never populates the execution predecessor cache or recreates a missing effect. */
  readonly authenticateEventTerminal?: (effectID: string) => Effect.Effect<Known, WorkAuthoritySchema.Error>
  readonly requireEventTerminal?: (effectID: string) => Effect.Effect<Known, WorkAuthoritySchema.Error>
  readonly releaseEventTerminal?: (workID: string) => Effect.Effect<void>
  readonly verifyRecovery?: (record: import("./work-known-recovery.schema").Record, mac: string) => Effect.Effect<VerifiedRecovery, WorkAuthoritySchema.Error>
  readonly inspectRecovery?: (proof: VerifiedRecovery) => import("./work-known-recovery.schema").Record | undefined
  /** Rechecks a previously authenticated native proof using local SQL only. Missing cache is
   * unavailable; cold callers must first invoke verify outside the transaction. */
  readonly requireVerified: (effectID: string) => Effect.Effect<Known, WorkAuthoritySchema.Error>
}>()("@deepagent-code/WorkToolPolicy/LeafProof") {}

type Entry = {
  active: boolean
  db: Db
  binding: typeof WorkAuthoritySchema.ProjectBinding.Type
  controlRevision: number
  admission: V2ToolEffect.ToolEffectAdmission
  context: Tool.Context
  location: Location.Interface
  materialization: ToolRegistry.Materialization
  registrationGeneration: string
  definitionHash: string
  inputHash: string
  files: WorkFileCapability.Interface
  root: WorkFileCapability.Root
  readRefusal?: { reason: typeof ReadRefusalReason.Type; observedAt: number }
  observation?: WorkFileCapability.Observation
  writeObservation?: WorkFileCapability.WriteObservation
  commandObservation?: WorkFileCapability.CommandObservation
  commandSource?: WorkCommandSchema.OutputReference
}
const entries = new WeakMap<Witness, Entry>()
const Current = Context.Reference<Witness | undefined>("@deepagent-code/WorkToolPolicy/Current", { defaultValue: () => undefined })
const denied = () => new WorkAuthoritySchema.Error({ code: "WORK_RECOVERY_REQUIRED",
  message: "Current project tool authority or native evidence is unavailable" })

/** Only the original canonical native tool frame can attest its new private storage. */
export const storageProducer = Effect.fn("WorkToolPolicy.storageProducer")(function* (kind: "write" | "command", admissionID: string) {
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  if (!entry?.active || entry.admission.admissionId !== admissionID ||
    entry.admission.toolName !== (kind === "write" ? "write" : "managed_command")) return yield* denied()
  yield* verifyCurrent(entry)
  return handle
})

/** Local SQL recheck of the same opaque frame, inside the attestation INSERT transaction.
 * No Location/model/plugin resolution or outbound IO runs while this transaction is held. */
export const requireStorageProducer = Effect.fn("WorkToolPolicy.requireStorageProducer")(function* (
  tx: WorkAuthority.Transaction, handle: Witness, kind: "write" | "command", admissionID: string,
) {
  const entry = entries.get(handle)
  if (!entry?.active || (yield* Current) !== handle || entry.admission.admissionId !== admissionID ||
    entry.admission.toolName !== (kind === "write" ? "write" : "managed_command")) return yield* denied()
  const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: entry.binding.workID, expectedRevision: entry.controlRevision })
  const rows = yield* tx.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
    attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, session: SessionTable,
  }).from(V2ToolEffectAdmissionTable)
    .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
    .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
    .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
    .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
    .where(eq(V2ToolEffectAdmissionTable.admission_id, admissionID)).get()
  if (work.binding.schemaVersion !== "work-execution.v2" || work.binding_hash !== Hash.sha256(CanonicalJson.stringify(entry.binding)) ||
    !rows || rows.admission.session_id !== work.session_id || rows.admission.tool_name !== entry.admission.toolName ||
    rows.admission.receipt_id !== entry.admission.receiptId || rows.admission.provider_attempt_id !== entry.admission.providerAttemptId ||
    rows.admission.owner_token !== entry.admission.ownerToken || rows.admission.tool_call_id !== entry.context.toolCallID ||
    rows.admission.effect_kind !== "mutating" || rows.receipt.owner_token !== rows.owner.owner_token ||
    rows.attempt.owner_token !== rows.owner.owner_token || rows.owner.released_at !== null || rows.owner.lease_expires_at <= Date.now() ||
    rows.attempt.execution_claim_token !== rows.session.execution_claim_token || rows.session.execution_claim_token === null ||
    rows.session.id !== work.session_id || !["streaming", "settled"].includes(rows.receipt.state) ||
    !["streaming", "settled"].includes(rows.attempt.state)) return yield* denied()
  return { work, admission: rows.admission, attempt: rows.attempt, session: rows.session }
})

/** Only the canonical runner calls this after real durable admission. It captures a real
 * registry advertisement, never a caller-supplied tool name/hash as implementation proof. */
export function withAdmission<A, E, R>(
  db: Db,
  input: {
    readonly binding: typeof WorkAuthoritySchema.ProjectBinding.Type
    readonly controlRevision: number
    readonly admission: V2ToolEffect.ToolEffectAdmission
    readonly context: Tool.Context
    readonly location: Location.Interface
    readonly materialization: ToolRegistry.Materialization
    readonly input: unknown
  },
  body: Effect.Effect<A, E, R>,
) {
  return Effect.scoped(Effect.acquireUseRelease(
    Effect.gen(function* () {
      const files = yield* Effect.serviceOption(WorkFileCapability.Service)
      const proof = yield* Effect.serviceOption(LeafProof)
      const { ToolRegistry } = yield* Effect.promise(() => import("../tool/registry"))
      const { ReadTool } = yield* Effect.promise(() => import("../tool/read"))
      const { WriteTool } = yield* Effect.promise(() => import("../tool/write"))
      const { ManagedCommandTool } = yield* Effect.promise(() => import("../tool/work-command"))
      const registered = ToolRegistry.inspect(input.materialization, input.admission.toolName)
      const native = registered && (input.admission.toolName === "read" ? ReadTool.isNativeRead(registered.tool)
        : input.admission.toolName === "write" ? WriteTool.isNativeWrite(registered.tool)
        : input.admission.toolName === "managed_command" && ManagedCommandTool.isNativeCommand(registered.tool))
      if (Option.isNone(files) || Option.isNone(proof) || !registered || !native)
        return yield* denied()
      const definitionHash = Hash.sha256(CanonicalJson.stringify(registered.definition))
      const allowed = input.binding.toolPolicy.capabilities.find((item) => item.toolID === input.admission.toolName)
      const operation = input.admission.toolName === "read" ? "read" : input.admission.toolName === "write" ? "write" : "run"
      if (input.admission.effectKind !== (operation === "read" ? "read_only" : "mutating") ||
        !allowed || allowed.definitionHash !== definitionHash || !allowed.operations.includes(operation)) return yield* denied()
      const entry = { ...input, db, active: true, files: files.value,
        registrationGeneration: registered.generation, definitionHash,
        inputHash: Hash.sha256(CanonicalJson.stringify(input.input)),
      }
      yield* verifyCurrent(entry)
      const root = yield* files.value.open({ binding: input.binding, controlRevision: input.controlRevision })
        .pipe(Effect.mapError(() => denied()))
      const handle = Object.freeze({}) as Witness
      entries.set(handle, { ...entry, root })
      return handle
    }),
    (handle) => body.pipe(Effect.provideService(Current, handle)),
    (handle) => Effect.sync(() => {
      const entry = entries.get(handle)
      if (entry) entry.active = false
      entries.delete(handle)
    }),
  ))
}

/** Fast ordinary path; a project leaf still verifies its exact admission and current source.
 * This also runs after permission approval, so a once decision cannot outlive Work control. */
export const requireCurrent = Effect.fn("WorkToolPolicy.requireCurrent")(function* (db: Db, sessionID: string,
  task?: { action: string; resources: readonly string[] }) {
  const handle = yield* Current
  if (!handle) {
    if (yield* WorkChildAuthority.requireTaskCurrent(db, sessionID, task)) return
    const found = yield* WorkAuthority.lookupSession(db, sessionID)
    if (found.kind !== "ordinary") return yield* denied()
    return
  }
  const entry = entries.get(handle)
  if (!entry?.active || entry.context.sessionID !== sessionID) return yield* denied()
  yield* verifyCurrent(entry)
})

export const readResource = Effect.fn("WorkToolPolicy.readResource")(function* (
  context: Tool.Context, input: { readonly path: string; readonly byteOffset?: number; readonly pageBytes?: number;
    readonly offset?: number; readonly limit?: number; readonly reference?: unknown },
) {
  const handle = yield* Current
  if (!handle) return undefined
  const entry = entries.get(handle)
  if (!entry?.active || entry.admission.toolName !== "read" || entry.context.sessionID !== context.sessionID ||
    entry.context.toolCallID !== context.toolCallID || entry.context.assistantMessageID !== context.assistantMessageID ||
    entry.context.agent !== context.agent || Hash.sha256(CanonicalJson.stringify(input)) !== entry.inputHash ||
    entry.observation || entry.readRefusal) return yield* denied()
  yield* verifyCurrent(entry)
  // Validate defaults after the original input hash/current fence. The strict
  // exported grammar and refusal bytes remain valid for previously sealed facts.
  const reason = readRefusalReason({ ...input, byteOffset: input.byteOffset ?? 0,
    pageBytes: input.pageBytes ?? Math.min(51_200, entry.binding.toolPolicy.fileScope.maxReadBytes, entry.binding.toolPolicy.fileScope.maxHashBytes) }, entry.binding)
  if (reason) {
    // This is before files.read and before permission dispatch. A failed native/current check
    // remains unavailable: it must never manufacture a known zero-read result.
    yield* entry.files.current(entry.root).pipe(Effect.mapError(() => denied()))
    yield* verifyCurrent(entry)
    entry.readRefusal = { reason, observedAt: Date.now() }
    return yield* new ToolFailure({ message: READ_REFUSED })
  }
  return `${entry.binding.projectScope.canonicalRoot.replace(/\/$/, "")}/${input.path}`
})

export const writeResource = Effect.fn("WorkToolPolicy.writeResource")(function* (context: Tool.Context, relative: string) {
  const handle = yield* Current
  if (!handle) return undefined
  const entry = entries.get(handle)
  if (!entry?.active || entry.admission.toolName !== "write" || entry.context.sessionID !== context.sessionID ||
    entry.context.toolCallID !== context.toolCallID || entry.context.assistantMessageID !== context.assistantMessageID ||
    entry.context.agent !== context.agent || !Schema.is(WorkWriteStageSchema.Relative)(relative)) return yield* denied()
  yield* verifyCurrent(entry)
  const matches = (rule: { kind: "file" | "tree"; path: string }) => relative === rule.path ||
    (rule.kind === "tree" && relative.startsWith(`${rule.path}/`))
  if (entry.binding.toolPolicy.fileScope.deny.some(matches) || !entry.binding.toolPolicy.fileScope.write.some(matches)) return yield* denied()
  return `${entry.binding.projectScope.canonicalRoot.replace(/\/$/, "")}/${relative}`
})

export const commandResource = Effect.fn("WorkToolPolicy.commandResource")(function* (
  context: Tool.Context, input: WorkCommandSchema.Input,
) {
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  if (!entry?.active || entry.admission.toolName !== "managed_command" ||
    entry.context.sessionID !== context.sessionID || entry.context.toolCallID !== context.toolCallID ||
    entry.context.assistantMessageID !== context.assistantMessageID || entry.context.agent !== context.agent ||
    Hash.sha256(CanonicalJson.stringify(input)) !== entry.inputHash) return yield* denied()
  yield* verifyCurrent(entry)
  const recipes = entry.binding.toolPolicy.commandRecipes?.filter((recipe) => recipe.logicalID === input.commandID)
  const recipe = recipes?.[0]
  if (!recipe || recipes?.length !== 1 || input.parameters.length !== recipe.parameters.length ||
    new Set(input.parameters.map((parameter) => parameter.key)).size !== input.parameters.length ||
    input.parameters.some((parameter) => !recipe.parameters.find((item) => item.key === parameter.key)?.choices.includes(parameter.value)))
    return yield* denied()
  return `command:${recipe.logicalID}`
})

export const command = Effect.fn("WorkToolPolicy.command")(function* (
  context: Tool.Context, input: WorkCommandSchema.Input, checkPermission: Effect.Effect<void, WorkFileCapability.Error>,
) {
  yield* commandResource(context, input)
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  if (!entry?.active || !entry.files.command) return yield* denied()
  const rows = yield* verifyCurrent(entry)
  const result = yield* entry.files.command(entry.root, { activityID: rows.attempt.activity_id,
    providerReceiptID: entry.admission.receiptId, providerAttemptID: entry.admission.providerAttemptId,
    admissionID: entry.admission.admissionId, toolCallID: entry.admission.toolCallId, ownerToken: entry.admission.ownerToken,
    sessionClaimToken: rows.attempt.execution_claim_token, definitionHash: entry.definitionHash, input, checkPermission,
  }).pipe(Effect.mapError(() => denied()))
  yield* verifyCurrent(entry)
  entry.commandObservation = result.observation
  return result.output
})

export const write = Effect.fn("WorkToolPolicy.write")(function* (context: Tool.Context, input: {
  readonly path: string; readonly content: string | WorkCommandSchema.OutputReference;
  readonly checkPermission: Effect.Effect<void, WorkFileCapability.Error>
}) {
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  if (!entry?.active || !entry.files.write || entry.admission.toolName !== "write" ||
    entry.context.sessionID !== context.sessionID || entry.context.toolCallID !== context.toolCallID ||
    entry.context.assistantMessageID !== context.assistantMessageID || entry.context.agent !== context.agent) return yield* denied()
  const rows = yield* verifyCurrent(entry)
  const proof = yield* Effect.serviceOption(LeafProof)
  if (Option.isNone(proof)) return yield* denied()
  const content = typeof input.content === "string" ? input.content : yield* Effect.gen(function* () {
    const reference = input.content
    if (typeof reference === "string" || !entry.files.commandOutput || reference.bytes > 51_200) return yield* denied()
    const terminal = yield* entry.db.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ToolEffectTable, and(eq(V2ToolEffectTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id),
        eq(V2ToolEffectTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id)))
      .where(and(eq(V2ToolEffectAdmissionTable.admission_id, reference.admissionID),
        eq(V2ToolEffectAdmissionTable.session_id, entry.context.sessionID))).get().pipe(Effect.orDie)
    if (!terminal) return yield* denied()
    const known = yield* proof.value.verify(terminal.id)
    if (known.toolID !== "managed_command" || known.workID !== entry.binding.workID) return yield* denied()
    const text = yield* entry.files.commandOutput(entry.root, reference).pipe(Effect.mapError(() => denied()))
    if (Buffer.byteLength(text) !== reference.bytes || Hash.sha256(text) !== reference.sha256) return yield* denied()
    entry.commandSource = reference
    return text
  })
  // Use actual provider order, not timestamps or random IDs. A refusal is not an observation
  // of a new target version; later replacement still requires an authenticated read/write.
  const candidates = yield* entry.db.all<{ id: string }>(sql`
    SELECT e.effect_id id FROM session_v2_tool_effect e
    JOIN session_v2_provider_turn_receipt r ON r.receipt_id=e.receipt_id
    JOIN json_each(r.outcome_artifact) j ON json_extract(j.value,'$.type')='tool-call'
      AND json_extract(j.value,'$.id')=e.tool_call_id
    WHERE e.session_id=${entry.binding.sessionID} AND e.state='settled' AND e.error_code IS NULL
    ORDER BY r.provider_turn_seq DESC,CAST(j.key AS INTEGER) DESC LIMIT 129`)
  if (candidates.length > 128) return yield* denied()
  let expected: WorkWriteStageSchema.Expected = { kind: "missing" }
  for (const candidate of candidates) {
    const known = yield* proof.value.verify(candidate.id)
    if (known.toolID === "managed_command" || (known.toolID === "read" && "outcome" in known) || known.relative !== input.path || (known.toolID === "write" && known.outcome !== "published")) continue
    if (known.fileIdentity === null) return yield* denied()
    expected = { kind: "observed", effectID: candidate.id, outcomeHash: known.outcomeHash,
      identity: known.fileIdentity, sha256: known.toolID === "read" ? known.observedHash : known.nextHash,
      bytes: known.toolID === "read" ? known.fileBytes : known.nextBytes }
    break
  }
  const result = yield* entry.files.write(entry.root, { relative: input.path, content, expected,
    activityID: rows.attempt.activity_id, providerReceiptID: entry.admission.receiptId,
    providerAttemptID: entry.admission.providerAttemptId, admissionID: entry.admission.admissionId,
    toolCallID: entry.admission.toolCallId, ownerToken: entry.admission.ownerToken,
    sessionClaimToken: rows.attempt.execution_claim_token, definitionHash: entry.definitionHash,
    checkPermission: input.checkPermission,
  }).pipe(Effect.mapError(() => denied()))
  yield* verifyCurrent(entry)
  entry.writeObservation = result.observation
  return { outcome: result.outcome, existed: expected.kind === "observed" }
})

/** Only a native response proving zero namespace publication can convert this one error
 * result into a known terminal. Tool result metadata and copied JSON grant nothing. */
export const isKnownRefusal = Effect.fn("WorkToolPolicy.isKnownRefusal")(function* (result: unknown) {
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  if (!entry?.active) return false
  yield* verifyCurrent(entry)
  if (entry.readRefusal && entry.admission.toolName === "read" && !entry.observation) {
    yield* entry.files.current(entry.root).pipe(Effect.mapError(() => denied()))
    yield* verifyCurrent(entry)
    return CanonicalJson.stringify(result) === CanonicalJson.stringify({ type: "error", value: READ_REFUSED })
  }
  if (!entry.writeObservation || !entry.files.describeWrite) return false
  const observed = entry.files.describeWrite(entry.root, entry.writeObservation)
  return observed?.outcome === "refused_before_publish" &&
    CanonicalJson.stringify(result) === CanonicalJson.stringify({ type: "error", value: WRITE_REFUSED })
})

export const read = Effect.fn("WorkToolPolicy.read")(function* (
  context: Tool.Context,
  input: { readonly path: string; readonly byteOffset?: number; readonly pageBytes?: number },
) {
  const handle = yield* Current
  if (!handle) return undefined
  const entry = entries.get(handle)
  if (!entry?.active || entry.context.sessionID !== context.sessionID || entry.context.agent !== context.agent ||
    entry.context.toolCallID !== context.toolCallID || entry.context.assistantMessageID !== context.assistantMessageID)
    return yield* denied()
  if (entry.readRefusal) return yield* denied()
  yield* verifyCurrent(entry)
  // Defaults belong to the original admitted Work entry. The provider's input hash
  // stays unchanged, and an omitted page cannot exceed either captured file budget.
  const result = yield* entry.files.read(entry.root, { relative: input.path, offset: input.byteOffset ?? 0,
    bytes: input.pageBytes ?? Math.min(51_200, entry.binding.toolPolicy.fileScope.maxReadBytes, entry.binding.toolPolicy.fileScope.maxHashBytes),
    scanLimit: Math.min(entry.binding.toolPolicy.fileScope.maxReadBytes, entry.binding.toolPolicy.fileScope.maxHashBytes),
  }).pipe(Effect.mapError(() => denied()))
  yield* verifyCurrent(entry)
  entry.observation = result.observation
  return { text: result.text, next: result.next }
})

/** Called by the host sealer, not an API decoder. Observation bytes and receipt provenance
 * come from this live canonical scope and the native helper's private WeakMap. */
export const describeKnownRead = Effect.fn("WorkToolPolicy.describeKnownRead")(function* (
  handle: Witness, outcomeHash: string,
) {
  const entry = entries.get(handle)
  if (!entry?.active || !Schema.is(WorkAuthoritySchema.Digest)(outcomeHash)) return yield* denied()
  const rows = yield* verifyCurrent(entry, { prepare: false })
  if (entry.readRefusal) {
    if (entry.observation || entry.admission.toolName !== "read" ||
      outcomeHash !== Hash.sha256(CanonicalJson.stringify({ type: "error", value: READ_REFUSED })) ||
      entry.readRefusal.observedAt < rows.admission.time_created || entry.readRefusal.observedAt > Date.now()) return yield* denied()
    return yield* Schema.decodeUnknownEffect(KnownReadRefusal, { onExcessProperty: "error" })({
      version: 1, toolID: "read", outcome: "refused_before_read", workID: entry.binding.workID, rootWorkID: entry.binding.rootWorkID,
      bindingHash: rows.work.binding_hash, profileHash: entry.binding.profile.hash, controlRevision: entry.controlRevision,
      sessionID: entry.binding.sessionID, inputID: entry.binding.inputID, activityID: rows.attempt.activity_id,
      receiptID: entry.admission.receiptId, attemptID: entry.admission.providerAttemptId, admissionID: entry.admission.admissionId,
      toolCallID: entry.context.toolCallID, assistantMessageID: entry.context.assistantMessageID, ownerToken: entry.admission.ownerToken,
      sessionClaimToken: rows.attempt.execution_claim_token, definitionHash: entry.definitionHash,
      registrationGeneration: entry.registrationGeneration, inputHash: entry.inputHash, outcomeHash,
      securityNamespaceID: rows.selection.security_namespace_id, locationKey: rows.selection.location_key,
      projectScopeKey: rows.selection.project_scope_key, namespaceBindingHash: rows.namespace.binding_hash,
      selectionID: rows.selection.selection_id, selectionHash: rows.selection.projection_hash,
      helperHash: entry.binding.projectScope.helperHash, rootIdentity: entry.binding.projectScope.rootIdentity,
      reason: entry.readRefusal.reason, observedAt: entry.readRefusal.observedAt, expiresAt: entry.binding.deadline,
    }).pipe(Effect.mapError(() => denied()))
  }
  if (!entry.observation) return yield* denied()
  const observed = entry.files.describe(entry.root, entry.observation)
  if (!observed || observed.workID !== entry.binding.workID || observed.controlRevision !== entry.controlRevision ||
    observed.bindingHash !== rows.work.binding_hash || observed.helperHash !== entry.binding.projectScope.helperHash ||
    observed.observedAt < rows.admission.time_created || observed.observedAt > Date.now() ||
    CanonicalJson.stringify(observed.rootIdentity) !== CanonicalJson.stringify(entry.binding.projectScope.rootIdentity)) return yield* denied()
  return yield* Schema.decodeUnknownEffect(KnownRead, { onExcessProperty: "error" })({
    version: 1, workID: entry.binding.workID, rootWorkID: entry.binding.rootWorkID,
    bindingHash: rows.work.binding_hash, profileHash: entry.binding.profile.hash, controlRevision: entry.controlRevision,
    sessionID: entry.binding.sessionID, inputID: entry.binding.inputID, activityID: rows.attempt.activity_id,
    receiptID: entry.admission.receiptId, attemptID: entry.admission.providerAttemptId,
    admissionID: entry.admission.admissionId, toolCallID: entry.context.toolCallID,
    assistantMessageID: entry.context.assistantMessageID, ownerToken: entry.admission.ownerToken,
    sessionClaimToken: rows.attempt.execution_claim_token,
    toolID: "read", definitionHash: entry.definitionHash, registrationGeneration: entry.registrationGeneration,
    inputHash: entry.inputHash, outcomeHash,
    securityNamespaceID: rows.selection.security_namespace_id, locationKey: rows.selection.location_key,
    projectScopeKey: rows.selection.project_scope_key, namespaceBindingHash: rows.namespace.binding_hash,
    selectionID: rows.selection.selection_id, selectionHash: rows.selection.projection_hash,
    helperHash: observed.helperHash, rootIdentity: observed.rootIdentity, fileIdentity: observed.fileIdentity,
    relative: observed.relative, offset: observed.offset, bytes: observed.bytes, fileBytes: observed.fileBytes,
    scannedBytes: observed.scannedBytes, observedHash: observed.observedHash, pageHash: observed.pageHash,
    observedAt: observed.observedAt, expiresAt: entry.binding.deadline, snapshot: observed.snapshot,
  }).pipe(Effect.mapError(() => denied()))
})

export const describeKnownWrite = Effect.fn("WorkToolPolicy.describeKnownWrite")(function* (handle: Witness, outcomeHash: string) {
  const entry = entries.get(handle)
  if (!entry?.active || !entry.writeObservation || !entry.files.describeWrite ||
    !Schema.is(WorkAuthoritySchema.Digest)(outcomeHash)) return yield* denied()
  const rows = yield* verifyCurrent(entry, { prepare: false })
  const observed = entry.files.describeWrite(entry.root, entry.writeObservation)
  if (!observed || observed.record.admissionID !== entry.admission.admissionId || observed.record.workID !== rows.work.work_id ||
    observed.record.bindingHash !== rows.work.binding_hash || observed.record.controlRevision !== entry.controlRevision ||
    observed.record.helperHash !== entry.binding.projectScope.helperHash || observed.observedAt < rows.admission.time_created ||
    observed.observedAt > Date.now() || (observed.outcome === "refused_before_publish" &&
      outcomeHash !== Hash.sha256(CanonicalJson.stringify({ type: "error", value: WRITE_REFUSED })))) return yield* denied()
  return yield* Schema.decodeUnknownEffect(KnownWrite, { onExcessProperty: "error" })({
    version: 1, toolID: "write", workID: entry.binding.workID, rootWorkID: entry.binding.rootWorkID,
    bindingHash: rows.work.binding_hash, profileHash: entry.binding.profile.hash, controlRevision: entry.controlRevision,
    sessionID: entry.binding.sessionID, inputID: entry.binding.inputID, activityID: rows.attempt.activity_id,
    receiptID: entry.admission.receiptId, attemptID: entry.admission.providerAttemptId, admissionID: entry.admission.admissionId,
    toolCallID: entry.context.toolCallID, assistantMessageID: entry.context.assistantMessageID,
    ownerToken: entry.admission.ownerToken, sessionClaimToken: rows.attempt.execution_claim_token,
    definitionHash: entry.definitionHash, registrationGeneration: entry.registrationGeneration, inputHash: entry.inputHash, outcomeHash,
    securityNamespaceID: rows.selection.security_namespace_id, locationKey: rows.selection.location_key,
    projectScopeKey: rows.selection.project_scope_key, namespaceBindingHash: rows.namespace.binding_hash,
    selectionID: rows.selection.selection_id, selectionHash: rows.selection.projection_hash,
    helperHash: observed.record.helperHash, rootIdentity: observed.record.rootIdentity, fileIdentity: observed.fileIdentity,
    relative: observed.record.relative, stageID: observed.record.stageID, stageRequestHash: observed.record.requestHash,
    expected: observed.record.expected, nextHash: observed.record.nextHash, nextBytes: observed.record.nextBytes,
    outcome: observed.outcome, observedAt: observed.observedAt, expiresAt: entry.binding.deadline,
    publication: "optimistic_namespace_publish",
  }).pipe(Effect.mapError(() => denied()))
})

export const describeKnownCommand = Effect.fn("WorkToolPolicy.describeKnownCommand")(function* (handle: Witness, outcomeHash: string) {
  const entry = entries.get(handle)
  if (!entry?.active || !entry.commandObservation || !entry.files.describeCommand ||
    !Schema.is(WorkAuthoritySchema.Digest)(outcomeHash)) return yield* denied()
  const rows = yield* verifyCurrent(entry, { prepare: false })
  const observed = entry.files.describeCommand(entry.root, entry.commandObservation)
  if (!observed || observed.record.state !== "settled" || observed.record.admissionID !== entry.admission.admissionId ||
    observed.record.workID !== rows.work.work_id || observed.record.bindingHash !== rows.work.binding_hash ||
    observed.record.controlRevision !== entry.controlRevision || observed.record.requestHash !== entry.inputHash ||
    observed.record.helperHash !== entry.binding.projectScope.helperHash || observed.observedAt < rows.admission.time_created ||
    observed.observedAt > Date.now()) return yield* denied()
  const { WorkCommand } = yield* Effect.promise(() => import("./work-command"))
  return yield* Schema.decodeUnknownEffect(KnownCommand, { onExcessProperty: "error" })({
    version: observed.supervision ? 2 : 1, ...(observed.supervision ? { supervision: observed.supervision } : {}),
    toolID: "managed_command", workID: entry.binding.workID, rootWorkID: entry.binding.rootWorkID,
    bindingHash: rows.work.binding_hash, profileHash: entry.binding.profile.hash, controlRevision: entry.controlRevision,
    sessionID: entry.binding.sessionID, inputID: entry.binding.inputID, activityID: rows.attempt.activity_id,
    receiptID: entry.admission.receiptId, attemptID: entry.admission.providerAttemptId, admissionID: entry.admission.admissionId,
    toolCallID: entry.context.toolCallID, assistantMessageID: entry.context.assistantMessageID,
    ownerToken: entry.admission.ownerToken, sessionClaimToken: rows.attempt.execution_claim_token,
    definitionHash: entry.definitionHash, registrationGeneration: entry.registrationGeneration, inputHash: entry.inputHash, outcomeHash,
    securityNamespaceID: rows.selection.security_namespace_id, locationKey: rows.selection.location_key,
    projectScopeKey: rows.selection.project_scope_key, namespaceBindingHash: rows.namespace.binding_hash,
    selectionID: rows.selection.selection_id, selectionHash: rows.selection.projection_hash,
    helperHash: observed.record.helperHash, rootIdentity: entry.binding.projectScope.rootIdentity,
    commandID: observed.record.commandID, recipeID: observed.record.recipeID, recipeRevision: observed.record.recipeRevision,
    recipeHash: observed.record.recipeHash, commandRequestHash: observed.record.requestHash,
    runtimeHash: observed.record.runtimeHash, commandResultHash: WorkCommand.resultHash(observed.record),
    observedAt: observed.observedAt, expiresAt: entry.binding.deadline,
  }).pipe(Effect.mapError(() => denied()))
})

export const currentTool = Effect.gen(function* () {
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  return entry?.active ? entry.admission.toolName : undefined
})

export const currentKind = Effect.gen(function* () {
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  return entry?.active ? entry.admission.effectKind : undefined
})

/** Called only after the existing tool receipt and tool-result projection are durable.
 * Cleanup failure retains custody without changing the already known business outcome. */
export const cleanupCurrent = Effect.fn("WorkToolPolicy.cleanupCurrent")(function* () {
  const handle = yield* Current
  const entry = handle ? entries.get(handle) : undefined
  if (!entry?.active) return
  if (entry.commandObservation && entry.files.describeCommand && entry.files.cleanupCommand) {
    const observed = entry.files.describeCommand(entry.root, entry.commandObservation)
    if (!observed || observed.record.outputs.length !== 0) return
    const proof = yield* Effect.serviceOption(LeafProof)
    if (Option.isNone(proof)) return yield* denied()
    const terminal = yield* entry.db.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
      .where(and(eq(V2ToolEffectTable.receipt_id, entry.admission.receiptId),
        eq(V2ToolEffectTable.tool_call_id, entry.context.toolCallID))).get().pipe(Effect.orDie)
    if (!terminal) return yield* denied()
    yield* proof.value.verify(terminal.id)
    yield* entry.files.cleanupCommand(entry.root, observed.record.admissionID).pipe(Effect.catchTag("WorkFileCapability.Error", () => Effect.void))
    return
  }
  if (!entry.writeObservation || !entry.files.cleanupWrite) return
  const proof = yield* Effect.serviceOption(LeafProof)
  if (Option.isNone(proof)) return yield* denied()
  const terminal = yield* entry.db.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
    .where(and(eq(V2ToolEffectTable.receipt_id, entry.admission.receiptId),
      eq(V2ToolEffectTable.tool_call_id, entry.context.toolCallID))).get().pipe(Effect.orDie)
  if (!terminal) return yield* denied()
  yield* proof.value.verify(terminal.id)
  yield* entry.files.cleanupWrite(entry.root, entry.writeObservation).pipe(Effect.catchTag("WorkFileCapability.Error", () => Effect.void))
  if (entry.commandSource && entry.files.cleanupCommand &&
    entry.files.describeWrite?.(entry.root, entry.writeObservation)?.outcome === "published")
    yield* entry.files.cleanupCommand(entry.root, entry.commandSource.admissionID, entry.commandSource).pipe(Effect.catchTag("WorkFileCapability.Error", () => Effect.void))
})

export const sealCurrent = Effect.fn("WorkToolPolicy.sealCurrent")(function* (outcomeHash: string) {
  const handle = yield* Current
  if (!handle) return undefined
  const proof = yield* Effect.serviceOption(LeafProof)
  if (Option.isNone(proof)) return yield* denied()
  return yield* proof.value.seal(handle, outcomeHash)
})

/** Runs in the existing ToolEffect admission transaction; no new quota row or dispatcher.
 * Every admitted call, including unknown calls, consumes the original root tool budget. */
export const requireAdmission = Effect.fn("WorkToolPolicy.requireAdmission")(function* (
  tx: WorkAuthority.Transaction, input: Parameters<V2ToolEffect.Interface["admit"]>[0],
) {
  const found = yield* WorkAuthority.lookupSession(tx, input.sessionId)
  if (found.kind === "ordinary") return
  if (found.kind !== "bound" || found.work.binding.schemaVersion !== "work-execution.v2") return yield* denied()
  const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
    workID: found.work.work_id, expectedRevision: found.work.control_revision,
  })
  const rows = yield* tx.select({ receipt: V2ProviderTurnReceiptTable, attempt: SessionProviderAttemptTable,
    owner: SessionProviderOwnerLeaseTable, session: SessionTable,
  }).from(V2ProviderTurnReceiptTable)
    .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ProviderTurnReceiptTable.provider_attempt_id))
    .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ProviderTurnReceiptTable.owner_token))
    .innerJoin(SessionTable, eq(SessionTable.id, V2ProviderTurnReceiptTable.session_id))
    .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId)).get()
  if (!rows || rows.receipt.session_id !== work.session_id || rows.attempt.session_id !== work.session_id ||
    rows.attempt.attempt_id !== input.providerAttemptId || rows.receipt.owner_token !== input.ownerToken ||
    rows.attempt.owner_token !== input.ownerToken || rows.owner.lease_expires_at <= Date.now() || rows.owner.released_at !== null ||
    rows.session.execution_claim_token === null || rows.attempt.execution_claim_token !== rows.session.execution_claim_token ||
    !["streaming", "settled"].includes(rows.receipt.state) || !["streaming", "settled"].includes(rows.attempt.state)) return yield* denied()
  const previous = yield* tx.select({ id: V2ToolEffectAdmissionTable.admission_id }).from(V2ToolEffectAdmissionTable)
    .where(and(eq(V2ToolEffectAdmissionTable.receipt_id, input.receiptId), eq(V2ToolEffectAdmissionTable.tool_call_id, input.toolCallId))).get()
  if (previous) return
  const root = yield* WorkAuthority.get(tx, work.root_work_id)
  if (!root || root.binding.schemaVersion !== "work-execution.v2") return yield* denied()
  const [used] = yield* tx.all<{ count: number }>(sql`SELECT count(*) count FROM session_v2_tool_effect_admission a
    JOIN work_execution w ON w.session_id=a.session_id WHERE w.root_work_id=${work.root_work_id}`)
  const [own] = yield* tx.all<{ count: number }>(sql`SELECT count(*) count FROM session_v2_tool_effect_admission
    WHERE session_id=${work.session_id}`)
  if (!used || !own || used.count >= root.binding.budget.maxToolCalls || own.count >= work.binding.budget.maxToolCalls)
    return yield* new WorkAuthoritySchema.Error({ code: "WORK_BUDGET_EXHAUSTED", message: "The Work tool admission budget is exhausted" })
})

/** Native asset/key checks belong outside SQL. Cold verification authenticates the ORIGINAL
 * result; it never re-executes a read. The bounded cache is rechecked by previous() in SQL. */
export const preparePrevious = Effect.fn("WorkToolPolicy.preparePrevious")(function* (db: Db, sessionID: string) {
  const found = yield* WorkAuthority.lookupSession(db, sessionID)
  if (found.kind === "ordinary") return
  if (found.kind !== "bound" || found.work.binding.schemaVersion !== "work-execution.v2") return yield* denied()
  const effects = yield* db.select({ id: V2ToolEffectTable.effect_id, tool: V2ToolEffectAdmissionTable.tool_name,
    admissionID: V2ToolEffectAdmissionTable.admission_id }).from(V2ToolEffectTable)
    .innerJoin(V2ToolEffectAdmissionTable, and(eq(V2ToolEffectAdmissionTable.receipt_id, V2ToolEffectTable.receipt_id),
      eq(V2ToolEffectAdmissionTable.tool_call_id, V2ToolEffectTable.tool_call_id)))
    .where(eq(V2ToolEffectTable.session_id, sessionID)).limit(129).all()
  if (effects.length > 128) return yield* denied()
  const { WorkKnownRecoveryV2 } = yield* Effect.promise(() => import("./work-known-recovery-v2"))
  const historical = yield* WorkKnownRecoveryV2.hasContinuation
  for (const effect of effects.filter((item) => item.tool === "task")) {
    if (!historical) yield* WorkChildAuthority.prepareTerminal(db, effect.admissionID)
  }
  if (!effects.some((item) => item.tool !== "task")) return
  const proof = yield* Effect.serviceOption(LeafProof)
  if (Option.isNone(proof)) return yield* denied()
  for (const effect of effects.filter((item) => item.tool !== "task")) yield* proof.value.verify(effect.id)
}, Effect.mapError(() => denied()))

/** Root unresolved-work barrier. It precedes seq allocation and is repeated before count
 * disclosure/final dispatch. Current preparing receipt is the sole allowed exception. */
export const previous = Effect.fn("WorkToolPolicy.previous")(function* (
  tx: WorkAuthority.Transaction, work: WorkAuthority.Work, currentReceiptID?: string,
) {
  if (work.binding.schemaVersion !== "work-execution.v2") return undefined
  const pending = yield* tx.all<{ id: string; kind: string }>(sql`
    SELECT c.acquisition_id id, 'count' kind FROM work_count_acquisition c JOIN work_execution w ON w.work_id=c.work_id
      WHERE w.root_work_id=${work.root_work_id} AND c.state IN ('sending','unknown','failed')
        AND (${currentReceiptID ?? null} IS NULL OR c.provider_receipt_id != ${currentReceiptID ?? null})
    UNION ALL SELECT r.reservation_id, 'provider' FROM work_dispatch_reservation r WHERE r.root_work_id=${work.root_work_id}
      AND r.state IN ('dispatching','unknown') AND (${currentReceiptID ?? null} IS NULL OR r.receipt_id != ${currentReceiptID ?? null})
    UNION ALL SELECT a.admission_id, 'tool' FROM session_v2_tool_effect_admission a JOIN work_execution w ON w.session_id=a.session_id
      LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id
      WHERE w.root_work_id=${work.root_work_id} AND e.effect_id IS NULL
  `)
  for (const item of pending) {
    if (item.kind !== "tool" || !(yield* WorkChildAuthority.permitsAwait(tx, work, item.id))) return yield* denied()
  }
  const prior = yield* tx.select().from(V2ProviderTurnReceiptTable)
    .where(and(eq(V2ProviderTurnReceiptTable.session_id, SessionSchema.ID.make(work.binding.sessionID)),
      currentReceiptID ? sql`${V2ProviderTurnReceiptTable.receipt_id} != ${currentReceiptID}` : undefined))
    .orderBy(asc(V2ProviderTurnReceiptTable.provider_turn_seq)).limit(33).all()
  if (prior.length > 32) return yield* denied()
  if (!prior.length) return undefined
  const proof = yield* Effect.serviceOption(LeafProof)
  const latest = prior.at(-1)!
  const digest: unknown[] = []
  for (const receipt of prior) {
    if (receipt.state !== "settled" || receipt.user_message_id !== work.input_id || receipt.activity_id !== latest.activity_id ||
      !receipt.outcome_artifact || receipt.outcome_hash !== Hash.sha256(CanonicalJson.stringify(receipt.outcome_artifact))) return yield* denied()
    const finish = receipt.outcome_artifact.filter((event) => typeof event === "object" && event !== null && "type" in event && event.type === "finish")
    if (finish.length !== 1 || finish[0] !== receipt.outcome_artifact.at(-1)) return yield* denied()
    const ending = Schema.decodeUnknownOption(Finish)(finish[0])
    if (Option.isNone(ending) || ending.value.reason !== "tool-calls") return yield* denied()
    const offered = receipt.outcome_artifact.flatMap((event) => {
      const call = Schema.decodeUnknownOption(ToolCall)(event)
      return Option.isSome(call) ? [call.value] : []
    })
    if (!offered.length || new Set(offered.map((call) => call.id)).size !== offered.length) return yield* denied()
    const terminals = yield* tx.select({ admission: V2ToolEffectAdmissionTable,
      effect: { id: V2ToolEffectTable.effect_id, kind: V2ToolEffectTable.effect_kind, state: V2ToolEffectTable.state,
        hash: V2ToolEffectTable.outcome_hash, error: V2ToolEffectTable.error_code, owner: V2ToolEffectTable.owner_token,
        grantID: V2ToolEffectTable.grant_receipt_id, grantOwner: V2ToolEffectTable.grant_owner_id,
        grantState: V2ToolEffectTable.grant_state, grantVersion: V2ToolEffectTable.grant_version },
    }).from(V2ToolEffectAdmissionTable).innerJoin(V2ToolEffectTable,
      and(eq(V2ToolEffectTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id), eq(V2ToolEffectTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id)))
      .where(eq(V2ToolEffectAdmissionTable.receipt_id, receipt.receipt_id)).orderBy(asc(V2ToolEffectAdmissionTable.tool_call_id)).limit(129).all()
    if (terminals.length !== offered.length || terminals.length > 128) return yield* denied()
    for (const terminal of terminals) {
      const call = offered.find((call) => call.id === terminal.admission.tool_call_id)
      if (!call || call.name !== terminal.admission.tool_name || terminal.admission.session_id !== work.session_id ||
        terminal.admission.provider_attempt_id !== receipt.provider_attempt_id || terminal.admission.owner_token !== receipt.owner_token ||
        terminal.effect.owner !== receipt.owner_token || terminal.effect.state !== "settled" ||
        terminal.effect.error !== null || (terminal.effect.grantID !== null && terminal.effect.grantState !== "settled")) return yield* denied()
      if (call.name === "task") {
        if (terminal.effect.kind !== "mutating") return yield* denied()
        const { WorkKnownRecoveryV2 } = yield* Effect.promise(() => import("./work-known-recovery-v2"))
        const original = { admissionID: terminal.admission.admission_id,
          inputHash: Hash.sha256(CanonicalJson.stringify(call.input)), outcomeHash: terminal.effect.hash }
        const historical = yield* WorkKnownRecoveryV2.historicalTask(tx, work, original)
        if (!historical) yield* WorkChildAuthority.requireTerminal(tx, work, original)
        digest.push({ admission: terminal.admission, effect: terminal.effect })
        continue
      }
      if (Option.isNone(proof)) return yield* denied()
      const observed = yield* proof.value.requireVerified(terminal.effect.id)
      if (terminal.effect.kind !== (observed.toolID === "read" ? "read_only" : "mutating") ||
        observed.toolID !== call.name || observed.admissionID !== terminal.admission.admission_id || observed.inputHash !== Hash.sha256(CanonicalJson.stringify(call.input)) ||
        observed.outcomeHash !== terminal.effect.hash) return yield* denied()
      digest.push({ admission: terminal.admission, effect: terminal.effect })
    }
    const [reservation] = yield* tx.all<{ state: string; actual_usage: string | null; charged_tokens: number }>(sql`
      SELECT state,actual_usage,charged_tokens FROM work_dispatch_reservation WHERE receipt_id=${receipt.receipt_id} AND work_id=${work.work_id}`)
    if (!reservation || reservation.state !== "settled" || !reservation.actual_usage || reservation.charged_tokens <= 0) return yield* denied()
  }
  return { receipt: latest, toolTerminalHash: Hash.sha256(CanonicalJson.stringify(["work-tool-terminal.v1", digest])) }
})

function verifyCurrent(entry: Omit<Entry, "root">, options?: { prepare: false }) {
  return Effect.gen(function* () {
    if (!entry.active) return yield* denied()
    const work = yield* WorkAuthority.get(entry.db, entry.binding.workID)
    if (!work || work.binding_hash !== Hash.sha256(CanonicalJson.stringify(entry.binding))) return yield* denied()
    // The original outcome sealer runs inside record()'s transaction. Its producer must
    // prepare before entering SQL; permission/native operation boundaries prepare here.
    if (options?.prepare !== false) {
      const { WorkExecutionProfile } = yield* Effect.promise(() => import("./work-execution-profile"))
      yield* WorkExecutionProfile.prepareSource(work, { fresh: true })
    }
    return yield* entry.db.transaction((tx) => Effect.gen(function* () {
      if (!entry.active) return yield* denied()
      const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
        workID: entry.binding.workID, expectedRevision: entry.controlRevision,
      })
      if (work.binding.schemaVersion !== "work-execution.v2" || work.binding_hash !== Hash.sha256(CanonicalJson.stringify(entry.binding)))
        return yield* denied()
      const { ToolRegistry } = yield* Effect.promise(() => import("../tool/registry"))
      const { ReadTool } = yield* Effect.promise(() => import("../tool/read"))
      const { WriteTool } = yield* Effect.promise(() => import("../tool/write"))
      const { ManagedCommandTool } = yield* Effect.promise(() => import("../tool/work-command"))
      const registered = ToolRegistry.inspect(entry.materialization, entry.admission.toolName)
      const native = registered && (entry.admission.toolName === "read" ? ReadTool.isNativeRead(registered.tool)
        : entry.admission.toolName === "write" ? WriteTool.isNativeWrite(registered.tool)
        : entry.admission.toolName === "managed_command" && ManagedCommandTool.isNativeCommand(registered.tool))
      if (!registered || !native || registered.generation !== entry.registrationGeneration ||
        Hash.sha256(CanonicalJson.stringify(registered.definition)) !== entry.definitionHash) return yield* denied()
      const rows = yield* tx.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
        attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, session: SessionTable,
        selection: SessionContextSelectionTable, namespace: SecurityNamespaceTable,
      }).from(V2ToolEffectAdmissionTable)
        .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
        .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
        .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
        .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
        .innerJoin(SessionContextSelectionTable, eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id))
        .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, SessionContextSelectionTable.security_namespace_id))
        .where(eq(V2ToolEffectAdmissionTable.admission_id, entry.admission.admissionId)).get()
      if (!rows || rows.admission.session_id !== work.session_id || rows.admission.receipt_id !== entry.admission.receiptId ||
        rows.admission.provider_attempt_id !== entry.admission.providerAttemptId || rows.admission.owner_token !== entry.admission.ownerToken ||
        rows.admission.tool_call_id !== entry.context.toolCallID || rows.admission.tool_name !== entry.admission.toolName ||
        rows.admission.effect_kind !== (entry.admission.toolName === "read" ? "read_only" : "mutating") ||
        rows.receipt.session_id !== work.session_id || rows.receipt.provider_attempt_id !== rows.attempt.attempt_id ||
        rows.receipt.owner_token !== rows.owner.owner_token || rows.attempt.owner_token !== rows.owner.owner_token ||
        rows.attempt.session_id !== work.session_id || rows.attempt.execution_claim_token !== rows.session.execution_claim_token ||
        rows.session.execution_claim_token === null || rows.owner.released_at !== null || rows.owner.lease_expires_at <= Date.now() ||
        !["streaming", "settled"].includes(rows.receipt.state) || !["streaming", "settled"].includes(rows.attempt.state) ||
        rows.session.directory !== entry.location.directory || rows.session.project_id !== entry.location.project.id ||
        rows.session.project_id !== entry.binding.projectScope.projectID ||
        rows.session.workspace_id !== null || !rows.session.v2_authority || rows.session.agent !== entry.binding.agentID ||
        rows.selection.session_id !== work.session_id || rows.selection.security_namespace_id !== entry.binding.scope.securityNamespaceID ||
        rows.selection.location_key !== entry.binding.projectScope.locationKey || rows.selection.project_scope_key !== entry.binding.scope.projectScopeKey ||
        rows.namespace.retired_at !== null || rows.namespace.binding_hash !== entry.binding.projectScope.namespaceBindingHash ||
        rows.receipt.prepared_turn?.context_selection_id !== rows.selection.selection_id ||
        rows.receipt.prepared_turn.context_projection_hash !== rows.selection.projection_hash ||
        rows.attempt.projection_hash !== rows.selection.projection_hash || Hash.sha256(rows.selection.projection) !== rows.selection.projection_hash)
        return yield* denied()
      const terminal = yield* tx.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
        .where(and(eq(V2ToolEffectTable.receipt_id, entry.admission.receiptId), eq(V2ToolEffectTable.tool_call_id, entry.admission.toolCallId))).get()
      if (terminal) return yield* denied()
      return { ...rows, work }
    }), { behavior: "immediate" })
  }).pipe(Effect.mapError(() => denied()))
}
