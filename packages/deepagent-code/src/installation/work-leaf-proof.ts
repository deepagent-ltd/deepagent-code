export * as WorkLeafProof from "./work-leaf-proof"

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { ToolOutput } from "@deepagent-code/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkDerivedAuthority } from "@deepagent-code/core/session/work-derived-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { WorkCommand } from "@deepagent-code/core/session/work-command"
import { WorkWriteStage } from "@deepagent-code/core/session/work-write-stage"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { SessionContextSelectionTable, SessionProviderAttemptTable } from "@deepagent-code/core/context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalTaskAuthority } from "../im/local-task-authority"
import { WorkFileHelper } from "./work-file-helper"
import { WorkLeafProofCache } from "./work-leaf-proof-cache"

const DOMAIN = "dac-work-native-leaf-outcome.v1"
const COMMAND_DOMAIN = "dac-work-native-command-outcome.v1"
const COMMAND_V2_DOMAIN = "dac-work-native-command-outcome.v2"
const WRITE_DOMAIN = "dac-work-native-write-outcome.v1"
export const MAX_PROOF_BYTES = 16_384
const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]+$/))
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  instanceID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  nonce: Hex.check(Schema.isLengthBetween(24, 24)),
  ciphertext: Hex.check(Schema.isMaxLength(MAX_PROOF_BYTES)),
  tag: Hex.check(Schema.isLengthBetween(32, 32)),
  mac: WorkAuthoritySchema.Digest,
})
const refused = () => new WorkAuthoritySchema.Error({ code: "WORK_RECOVERY_REQUIRED",
  message: "The original native read outcome cannot be verified" })
type Stage = "lifetime" | "installed-helper" | "source-current" | "SQL-current" | "verified-cache"
type Reason = "inactive" | "missing" | "capacity" | "asset" | "prepare" | "control" | "transaction" |
  "stored-proof" | "envelope" | "authentication" | "decode" | "time" | "work" | "storage" | "binding" |
  "capability" | "write-stage" | "command-record" | "effect" | "message" | "assistant" | "tool-call" | "tool-result"
const diagnostic = (stage: Stage, reason: Reason) =>
  Effect.logWarning(`work_leaf_proof_refused ${JSON.stringify({ stage, reason, code: "WORK_RECOVERY_REQUIRED" })}`)
    .pipe(Effect.catchCause(() => Effect.void))
const decline = (stage: Stage, reason: Reason) =>
  diagnostic(stage, reason).pipe(Effect.andThen(Effect.fail(refused())))

/** This service is installed only by the trusted host factory. The installation key stays in
 * this closure. No method signs caller JSON: seal accepts the canonical opaque witness and
 * obtains the native observation from the helper owner through WorkToolPolicy. */
export const layer = Layer.effect(WorkToolPolicy.LeafProof, Effect.gen(function* () {
  const database = yield* Database.Service
  const installation = yield* LocalTaskAuthority.readInstallation.pipe(Effect.mapError(() => refused()))
  const context = yield* Effect.context()
  const secret = Buffer.from(installation.secret, "hex")
  const key = createHmac("sha256", secret).update(`${DOMAIN}\0encryption\0${installation.instanceID}`).digest()
  const mac = (value: Omit<typeof Envelope.Type, "mac">) => createHmac("sha256", secret)
    .update(`${DOMAIN}\0authentication\0`).update(CanonicalJson.stringify(value)).digest("hex")
  const aad = Buffer.from(CanonicalJson.stringify([DOMAIN, installation.instanceID]))
  const writeKey = createHmac("sha256", secret).update(`${WRITE_DOMAIN}\0encryption\0${installation.instanceID}`).digest()
  const writeMac = (value: Omit<typeof Envelope.Type, "mac">) => createHmac("sha256", secret)
    .update(`${WRITE_DOMAIN}\0authentication\0`).update(CanonicalJson.stringify(value)).digest("hex")
  const writeAad = Buffer.from(CanonicalJson.stringify([WRITE_DOMAIN, installation.instanceID]))
  const commandKey = createHmac("sha256", secret).update(`${COMMAND_DOMAIN}\0encryption\0${installation.instanceID}`).digest()
  const commandMac = (value: Omit<typeof Envelope.Type, "mac">) => createHmac("sha256", secret)
    .update(`${COMMAND_DOMAIN}\0authentication\0`).update(CanonicalJson.stringify(value)).digest("hex")
  const commandAad = Buffer.from(CanonicalJson.stringify([COMMAND_DOMAIN, installation.instanceID]))
  const commandV2Key = createHmac("sha256", secret).update(`${COMMAND_V2_DOMAIN}\0encryption\0${installation.instanceID}`).digest()
  const commandV2Mac = (value: Omit<typeof Envelope.Type, "mac">) => createHmac("sha256", secret)
    .update(`${COMMAND_V2_DOMAIN}\0authentication\0`).update(CanonicalJson.stringify(value)).digest("hex")
  const commandV2Aad = Buffer.from(CanonicalJson.stringify([COMMAND_V2_DOMAIN, installation.instanceID]))
  const lifetime = { active: true }
  const recoveries = new WeakMap<WorkToolPolicy.VerifiedRecovery, WorkKnownRecoverySchema.Record>()
  const recoveryLive = new Set<WorkToolPolicy.VerifiedRecovery>()
  const verified = new Map<string, { proof: WorkToolPolicy.Known; sealed: string }>()
  const eventTerminals = new WorkLeafProofCache.Terminal<{ proof: WorkToolPolicy.Known; sealed: string }>()
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false; verified.clear(); eventTerminals.clear(); recoveryLive.clear(); secret.fill(0); key.fill(0); writeKey.fill(0); commandKey.fill(0); commandV2Key.fill(0) }))
  const checked = (proof: WorkToolPolicy.Known, effectID: string, sealed: string,
    historical?: { revision: number; mutation: LocalOperator.Mutation["Service"]; runtime: LocalOperator.Runtime["Service"] },
    storage = false, eventTerminal = false) => database.db.transaction((tx) => Effect.gen(function* () {
        if (!lifetime.active) return yield* decline("lifetime", "inactive")
        const column = proof.toolID === "read" ? V2ToolEffectTable.known_read_proof : proof.toolID === "write" ? V2ToolEffectTable.known_write_proof : V2ToolEffectTable.known_command_proof
        const [current] = yield* tx.all<{ proof: string }>(sql`SELECT ${column} proof FROM session_v2_tool_effect
          WHERE effect_id=${effectID} AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${MAX_PROOF_BYTES}`)
        if (!current || current.proof !== sealed) return yield* decline("SQL-current", "stored-proof")
        if (historical) yield* LocalOperator.requireMutation(tx).pipe(
          Effect.provideService(LocalOperator.Runtime, historical.runtime),
          Effect.provideService(LocalOperator.Mutation, historical.mutation))
        if (storage && !historical) return yield* decline("SQL-current", "storage")
        const row = yield* WorkAuthority.get(tx, proof.workID)
        if (!row) return yield* decline("SQL-current", "work")
        const control = { workID: proof.workID, expectedRevision: historical?.revision ?? row.control_revision }
        if (storage && (proof.toolID === "read" || row.outcome === "unknown" || row.admission_state !== "ready" || row.parent_work_id ||
          !(row.outcome === "succeeded" || row.outcome === "failed" || row.control_state === "cancelled"))) return yield* decline("SQL-current", "storage")
        const work = yield* (eventTerminal ? WorkDerivedAuthority.requireEventTerminalProofControl(tx, { workID: proof.workID,
          bindingHash: proof.bindingHash, receiptID: proof.receiptID, observedRevision: proof.controlRevision })
          : storage ? Effect.succeed(row) : !historical && row.parent_work_id && row.outcome === "succeeded"
          ? WorkDerivedAuthority.requireTerminalProofControl(tx, control)
          : WorkAuthority.requireCurrentControlInTransaction(tx, control)).pipe(
            Effect.tapError(() => diagnostic("SQL-current", "control")))
        if (!historical && !storage && !eventTerminal && proof.controlRevision !== work.control_revision) {
          const { WorkKnownRecovery } = yield* Effect.promise(() => import("@deepagent-code/core/session/work-known-recovery"))
          yield* WorkKnownRecovery.requireBridge(tx, work, { tool: { effectID,
            proofHash: Hash.sha256(sealed), outcomeHash: proof.outcomeHash, controlRevision: proof.controlRevision } })
        }
        if (work.binding.schemaVersion !== "work-execution.v2" || work.binding_hash !== proof.bindingHash ||
          work.root_work_id !== proof.rootWorkID || work.session_id !== proof.sessionID || work.input_id !== proof.inputID ||
          work.binding.profile.hash !== proof.profileHash || work.binding.deadline !== proof.expiresAt ||
          work.binding.projectScope.helperHash !== proof.helperHash ||
          CanonicalJson.stringify(work.binding.projectScope.rootIdentity) !== CanonicalJson.stringify(proof.rootIdentity)) return yield* decline("SQL-current", "binding")
        const capability = work.binding.toolPolicy.capabilities.find((item) => item.toolID === proof.toolID)
        if (!capability?.operations.includes(proof.toolID === "managed_command" ? "run" : proof.toolID) || capability.definitionHash !== proof.definitionHash) return yield* decline("SQL-current", "capability")
        if (proof.toolID === "write") {
          const stage = yield* WorkWriteStage.get(tx, proof.admissionID)
          if (!stage || stage.stageID !== proof.stageID || stage.requestHash !== proof.stageRequestHash ||
            stage.workID !== proof.workID || stage.rootWorkID !== proof.rootWorkID || stage.sessionID !== proof.sessionID ||
            stage.inputID !== proof.inputID || stage.bindingHash !== proof.bindingHash || stage.controlRevision !== proof.controlRevision ||
            stage.providerReceiptID !== proof.receiptID || stage.providerAttemptID !== proof.attemptID ||
            stage.ownerToken !== proof.ownerToken || stage.sessionClaimToken !== proof.sessionClaimToken ||
            stage.definitionHash !== proof.definitionHash || stage.helperHash !== proof.helperHash || stage.relative !== proof.relative ||
            stage.nextHash !== proof.nextHash || stage.nextBytes !== proof.nextBytes ||
            CanonicalJson.stringify(stage.expected) !== CanonicalJson.stringify(proof.expected) ||
            stage.state !== (proof.outcome === "published" ? "published" : "refused") ||
            (proof.outcome === "published" ? proof.fileIdentity === null : proof.fileIdentity !== null)) return yield* decline("SQL-current", "write-stage")
        }
        if (proof.toolID === "managed_command") {
          const command = yield* WorkCommand.get(tx, proof.admissionID)
          const recipe = work.binding.toolPolicy.commandRecipes?.find((item) => item.logicalID === proof.recipeID)
          if (!command || !recipe || command.state !== "settled" || command.commandID !== proof.commandID ||
            command.requestHash !== proof.commandRequestHash || command.requestHash !== proof.inputHash ||
            command.workID !== proof.workID || command.rootWorkID !== proof.rootWorkID || command.sessionID !== proof.sessionID ||
            command.inputID !== proof.inputID || command.bindingHash !== proof.bindingHash || command.controlRevision !== proof.controlRevision ||
            command.providerReceiptID !== proof.receiptID || command.providerAttemptID !== proof.attemptID ||
            command.ownerToken !== proof.ownerToken || command.sessionClaimToken !== proof.sessionClaimToken ||
            command.helperHash !== proof.helperHash || command.recipeHash !== proof.recipeHash ||
            recipe.revision !== proof.recipeRevision || Hash.sha256(CanonicalJson.stringify(recipe)) !== proof.recipeHash ||
            recipe.executable.sha256 !== proof.runtimeHash || command.runtimeHash !== proof.runtimeHash ||
            WorkCommand.resultHash(command) !== proof.commandResultHash) return yield* decline("SQL-current", "command-record")
          if ((recipe.schemaVersion === "work-command-recipe.v1" || recipe.schemaVersion === "work-command-recipe.mac-x64.v1") && proof.version !== 1)
            return yield* decline("SQL-current", "command-record")
          if (recipe.schemaVersion === "work-command-recipe.v2" && (proof.version !== 2 ||
            proof.supervision.target !== recipe.executable.platform || command.processIncarnation !== proof.supervision.nonce ||
            command.processID !== proof.supervision.rootPID ||
            Hash.sha256(CanonicalJson.stringify(recipe.sandbox)) !== proof.supervision.isolationHash)) return yield* decline("SQL-current", "command-record")
        }
        const rows = yield* tx.select({
          effect: { id: V2ToolEffectTable.effect_id, session: V2ToolEffectTable.session_id, receipt: V2ToolEffectTable.receipt_id,
            attempt: V2ToolEffectTable.provider_attempt_id, call: V2ToolEffectTable.tool_call_id, name: V2ToolEffectTable.tool_name,
            kind: V2ToolEffectTable.effect_kind, state: V2ToolEffectTable.state, hash: V2ToolEffectTable.outcome_hash,
            owner: V2ToolEffectTable.owner_token, error: V2ToolEffectTable.error_code, grant: V2ToolEffectTable.grant_state,
            grantReceipt: V2ToolEffectTable.grant_receipt_id, grantOwner: V2ToolEffectTable.grant_owner_id,
            grantVersion: V2ToolEffectTable.grant_version },
          admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable, attempt: SessionProviderAttemptTable,
          selection: SessionContextSelectionTable, namespace: SecurityNamespaceTable, session: SessionTable,
        }).from(V2ToolEffectTable)
          .innerJoin(V2ToolEffectAdmissionTable, and(eq(V2ToolEffectAdmissionTable.receipt_id, V2ToolEffectTable.receipt_id),
            eq(V2ToolEffectAdmissionTable.tool_call_id, V2ToolEffectTable.tool_call_id)))
          .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectTable.receipt_id))
          .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectTable.provider_attempt_id))
          .innerJoin(SessionContextSelectionTable, eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id))
          .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, SessionContextSelectionTable.security_namespace_id))
          .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectTable.session_id))
          .where(eq(V2ToolEffectTable.effect_id, effectID)).get()
        if (!rows) return yield* decline("SQL-current", "effect")
        // Managed Work proves its scoped permission through the original Native MAC
        // and derived/admission chain. It does not produce an ordinary tool grant.
        const grant = rows.effect.grant === null && rows.effect.grantReceipt === null && rows.effect.grantOwner === null && rows.effect.grantVersion === null ||
          rows.effect.grant === "settled" && !!rows.effect.grantReceipt?.trim() && !!rows.effect.grantOwner?.trim() &&
          rows.effect.grantVersion !== null && Number.isSafeInteger(rows.effect.grantVersion) && rows.effect.grantVersion >= 0
        if (eventTerminal && (!grant || proof.observedAt >= proof.expiresAt) || rows.effect.kind !== (proof.toolID === "read" ? "read_only" : "mutating") || rows.effect.state !== "settled" || rows.effect.error !== null ||
          rows.effect.hash !== proof.outcomeHash || rows.effect.name !== proof.toolID || rows.effect.call !== proof.toolCallID ||
          rows.effect.session !== proof.sessionID || rows.effect.receipt !== proof.receiptID || rows.effect.attempt !== proof.attemptID ||
          rows.effect.owner !== proof.ownerToken || rows.admission.admission_id !== proof.admissionID ||
          rows.admission.owner_token !== proof.ownerToken || rows.admission.session_id !== proof.sessionID ||
          rows.admission.provider_attempt_id !== proof.attemptID || rows.admission.time_created > proof.observedAt ||
          rows.receipt.state !== "settled" || rows.attempt.state !== "settled" || rows.receipt.session_id !== proof.sessionID ||
          rows.receipt.provider_attempt_id !== proof.attemptID || rows.receipt.owner_token !== proof.ownerToken ||
          rows.attempt.owner_token !== proof.ownerToken || rows.attempt.execution_claim_token !== proof.sessionClaimToken ||
          rows.attempt.activity_id !== proof.activityID || rows.selection.selection_id !== proof.selectionID ||
          rows.selection.projection_hash !== proof.selectionHash || rows.attempt.projection_hash !== proof.selectionHash ||
          rows.receipt.prepared_turn?.context_selection_id !== proof.selectionID ||
          rows.receipt.prepared_turn.context_projection_hash !== proof.selectionHash ||
          rows.selection.security_namespace_id !== proof.securityNamespaceID || rows.selection.location_key !== proof.locationKey ||
          rows.selection.project_scope_key !== proof.projectScopeKey || (!eventTerminal && rows.namespace.retired_at !== null) ||
          rows.namespace.binding_hash !== proof.namespaceBindingHash || rows.session.directory !== work.binding.location.directory ||
          rows.session.project_id !== work.binding.projectScope.projectID || rows.session.workspace_id !== null ||
          Hash.sha256(rows.selection.projection) !== proof.selectionHash) return yield* decline("SQL-current", "effect")
        const message = yield* tx.select().from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make(proof.assistantMessageID))).get()
        if (!message || message.session_id !== proof.sessionID || message.type !== "assistant") return yield* decline("SQL-current", "message")
        const assistant = Schema.decodeUnknownOption(SessionMessage.Assistant)({ ...message.data, id: message.id, type: message.type })
        if (Option.isNone(assistant)) return yield* decline("SQL-current", "assistant")
        const calls = assistant.value.content.filter((item) => item.type === "tool" && item.id === proof.toolCallID)
        const call = calls[0]
        if (calls.length !== 1 || !call || call.type !== "tool" || call.name !== proof.toolID ||
          Hash.sha256(CanonicalJson.stringify(call.state.input)) !== proof.inputHash) return yield* decline("SQL-current", "tool-call")
        if ((proof.toolID === "read" && "outcome" in proof) || (proof.toolID === "write" && proof.outcome === "refused_before_publish")) {
          const result = { type: "error", value: proof.toolID === "read" ? WorkToolPolicy.READ_REFUSED : WorkToolPolicy.WRITE_REFUSED }
          if (proof.toolID === "read" && (work.binding.schemaVersion !== "work-execution.v2" ||
            WorkToolPolicy.readRefusalReason(call.state.input, work.binding) !== proof.reason)) return yield* decline("SQL-current", "tool-result")
          if (call.state.status !== "error" || call.state.result === undefined ||
            CanonicalJson.stringify(call.state.result) !== CanonicalJson.stringify(result) ||
            Hash.sha256(CanonicalJson.stringify(result)) !== proof.outcomeHash) return yield* decline("SQL-current", "tool-result")
        } else if (call.state.status !== "completed" ||
          Hash.sha256(CanonicalJson.stringify(ToolOutput.toResultValue(ToolOutput.make(call.state.structured, call.state.content)))) !== proof.outcomeHash ||
          (call.state.result !== undefined && Hash.sha256(CanonicalJson.stringify(call.state.result)) !== proof.outcomeHash)) return yield* decline("SQL-current", "tool-result")
        // The proof is never returned with public ToolEffect/Session data; only this internal
        // reader returns a typed authenticated view to canonical predecessor validation.
        return proof
      }), { behavior: "immediate" }).pipe(Effect.tapError(() => diagnostic("SQL-current", "transaction")),
        Effect.mapError(() => refused()), Effect.provide(context))
  const verify = (effectID: string, historical?: {
    revision: number; mutation: LocalOperator.Mutation["Service"]; runtime: LocalOperator.Runtime["Service"]
  }, storage = false, eventTerminal = false) => Effect.gen(function* () {
      if (!lifetime.active) return yield* decline("lifetime", "inactive")
      // Bound SQL materialization BEFORE decoding an untrusted stored proof. A corrupt row
      // cannot allocate a multi-megabyte JSON/blob just to discover that it exceeds the cap.
      const [stored] = yield* database.db.all<{ proof: string; kind: "read" | "write" | "managed_command" }>(sql`
        SELECT CASE tool_name WHEN 'read' THEN known_read_proof WHEN 'write' THEN known_write_proof ELSE known_command_proof END proof,tool_name kind
        FROM session_v2_tool_effect
        WHERE effect_id=${effectID} AND state='settled' AND error_code IS NULL
          AND ((effect_kind='read_only' AND tool_name='read' AND known_command_proof IS NULL AND known_write_proof IS NULL AND typeof(known_read_proof)='text'
            AND length(CAST(known_read_proof AS BLOB)) BETWEEN 1 AND ${MAX_PROOF_BYTES})
          OR (effect_kind='mutating' AND tool_name='write' AND known_command_proof IS NULL AND known_read_proof IS NULL AND typeof(known_write_proof)='text'
            AND length(CAST(known_write_proof AS BLOB)) BETWEEN 1 AND ${MAX_PROOF_BYTES})
          OR (effect_kind='mutating' AND tool_name='managed_command' AND known_read_proof IS NULL AND known_write_proof IS NULL
            AND typeof(known_command_proof)='text' AND length(CAST(known_command_proof AS BLOB)) BETWEEN 1 AND ${MAX_PROOF_BYTES}))
      `).pipe(Effect.mapError(() => refused()))
      if (!stored) return yield* decline("SQL-current", "stored-proof")
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope), { onExcessProperty: "error" })(stored.proof)
      if (Option.isNone(decoded) || decoded.value.instanceID !== installation.instanceID ||
        CanonicalJson.stringify(decoded.value) !== stored.proof) return yield* decline("SQL-current", "envelope")
      const envelope = decoded.value
      const data = { version: envelope.version, instanceID: envelope.instanceID, nonce: envelope.nonce,
        ciphertext: envelope.ciphertext, tag: envelope.tag }
      const commandV2 = stored.kind === "managed_command" && timingSafeEqual(Buffer.from(commandV2Mac(data), "hex"), Buffer.from(envelope.mac, "hex"))
      if (!commandV2 && !timingSafeEqual(Buffer.from(stored.kind === "read" ? mac(data) : stored.kind === "write" ? writeMac(data) : commandMac(data), "hex"), Buffer.from(envelope.mac, "hex"))) return yield* decline("SQL-current", "authentication")
      const proof = yield* Effect.try({ try: () => {
        const decipher = createDecipheriv("aes-256-gcm", stored.kind === "read" ? key : stored.kind === "write" ? writeKey : commandV2 ? commandV2Key : commandKey, Buffer.from(envelope.nonce, "hex"))
        decipher.setAAD(stored.kind === "read" ? aad : stored.kind === "write" ? writeAad : commandV2 ? commandV2Aad : commandAad)
        decipher.setAuthTag(Buffer.from(envelope.tag, "hex"))
        const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "hex")), decipher.final()])
        const text = new TextDecoder("utf-8", { fatal: true }).decode(plain)
        const value = stored.kind === "read"
          ? Schema.decodeUnknownSync(Schema.fromJsonString(WorkToolPolicy.ReadKnown), { onExcessProperty: "error" })(text)
          : stored.kind === "write" ? Schema.decodeUnknownSync(Schema.fromJsonString(WorkToolPolicy.KnownWrite), { onExcessProperty: "error" })(text)
          : Schema.decodeUnknownSync(Schema.fromJsonString(WorkToolPolicy.KnownCommand), { onExcessProperty: "error" })(text)
        if (CanonicalJson.stringify(value) !== text) throw refused()
        if (value.toolID === "managed_command" && (value.version === 2) !== commandV2) throw refused()
        return value
      }, catch: () => refused() }).pipe(Effect.tapError(() => diagnostic("SQL-current", "decode")))
      if ((!storage && !eventTerminal && proof.expiresAt <= Date.now()) || proof.observedAt > Date.now()) return yield* decline("SQL-current", "time")
      // Native inventory/file IO is outside the transaction. This is not a file re-read and
      // cannot recreate a missing historical result. Source/current control are checked below.
      if (!(proof.toolID === "read" && "outcome" in proof))
        yield* WorkFileHelper.requireInstalled(proof.helperHash).pipe(Effect.tapError(() => diagnostic("installed-helper", "asset")), Effect.mapError(() => refused()))
      if (proof.toolID === "managed_command") {
        const { NativeInstallation } = yield* Effect.promise(() => import("./native-installation"))
        const { WorkCommandRuntime } = yield* Effect.promise(() => import("./work-command-runtime"))
        const work = yield* WorkAuthority.get(database.db, proof.workID)
        const recipe = work?.binding.schemaVersion === "work-execution.v2"
          ? work.binding.toolPolicy.commandRecipes?.find((item) => item.logicalID === proof.recipeID) : undefined
        if (!recipe || Hash.sha256(CanonicalJson.stringify(recipe)) !== proof.recipeHash) return yield* refused()
        const installed = yield* NativeInstallation.current().pipe(Effect.mapError(() => refused()))
        if (recipe.schemaVersion === "work-command-recipe.v1" || recipe.schemaVersion === "work-command-recipe.mac-x64.v1") {
          if (proof.version !== 1) return yield* refused()
          yield* Effect.tryPromise({ try: async () => {
            if (!eventTerminal) {
              await WorkCommandRuntime.verifiedMacRecipeRuntime(installed, recipe)
              return
            }
            // A signed reinstallation can change the image FileID. Already-settled
            // event accounting keeps that original identity in the MAC-bound recipe
            // and checks current signed contents; it produces no execution witness.
            const runtime = recipe.schemaVersion === "work-command-recipe.mac-x64.v1"
              ? await WorkCommandRuntime.verifiedMacX64Runtime(installed)
              : await WorkCommandRuntime.verifiedRuntime(installed)
            if (runtime.executable.assetPath !== recipe.executable.assetPath || runtime.executable.platform !== recipe.executable.platform ||
              runtime.executable.sha256 !== recipe.executable.sha256 || runtime.executable.bytes !== recipe.executable.bytes) throw refused()
          }, catch: () => refused() })
        }
        if (recipe.schemaVersion === "work-command-recipe.v2") {
          const { NativeWorkProcessSupervisor } = yield* Effect.promise(() => import("./work-process-supervisor"))
          const actual = yield* NativeWorkProcessSupervisor.inspectRuntime(installed).pipe(Effect.mapError(() => refused()))
          if (proof.version !== 2 || proof.supervision.supervisorHash !== actual.supervisorHash ||
            CanonicalJson.stringify(actual.executable) !== CanonicalJson.stringify(recipe.executable)) return yield* refused()
        }
        if (recipe.schemaVersion !== "work-command-recipe.v1" && recipe.schemaVersion !== "work-command-recipe.mac-x64.v1" &&
          recipe.schemaVersion !== "work-command-recipe.v2") return yield* refused()
      }
      const work = yield* WorkAuthority.get(database.db, proof.workID)
      if (!work || work.binding_hash !== proof.bindingHash) return yield* decline("SQL-current", "work")
      const { WorkExecutionProfile } = yield* Effect.promise(() => import("@deepagent-code/core/session/work-execution-profile"))
      if (!storage && !eventTerminal) yield* WorkExecutionProfile.prepareSource(work, { fresh: true }).pipe(
        Effect.tapError(() => diagnostic("source-current", "prepare")), Effect.mapError(() => refused()))
      const known = yield* checked(proof, effectID, stored.proof, historical, storage, eventTerminal)
      if (eventTerminal) {
        if (!eventTerminals.set(known.workID, effectID, { proof: known, sealed: stored.proof })) return yield* refused()
      }
      if (!historical && !storage && !eventTerminal) {
        if (!verified.has(effectID) && verified.size >= 128) return yield* decline("verified-cache", "capacity")
        verified.set(effectID, { proof: known, sealed: stored.proof })
      }
      return known
    }).pipe(Effect.provide(context))
  return WorkToolPolicy.LeafProof.of({
    verifyRecovery: (record, storedMac) => Effect.gen(function* () {
      if (!lifetime.active || record.instanceID !== installation.instanceID || recoveryLive.size >= 32 ||
        Option.isNone(Schema.decodeUnknownOption(WorkKnownRecoverySchema.Record, { onExcessProperty: "error" })(record)) ||
        !Schema.is(WorkKnownRecoverySchema.Digest)(storedMac)) return yield* refused()
      const text = CanonicalJson.stringify(record)
      if (Buffer.byteLength(text) > WorkKnownRecoverySchema.MAX_RECORD_BYTES) return yield* refused()
      const actual = createHmac("sha256", secret).update("dac-work-known-recovery.v1\0")
        .update(CanonicalJson.stringify([installation.instanceID, record])).digest("hex")
      if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(storedMac, "hex"))) return yield* refused()
      const value = Object.freeze(Object.create(null)) as WorkToolPolicy.VerifiedRecovery
      recoveries.set(value, record)
      recoveryLive.add(value)
      return value
    }),
    inspectRecovery: (value) => {
      if (!lifetime.active || !recoveryLive.delete(value)) return undefined
      const record = recoveries.get(value)
      recoveries.delete(value)
      return record
    },
    seal: (witness, outcomeHash) => Effect.gen(function* () {
      if (!lifetime.active) return yield* refused()
      const kind = yield* WorkToolPolicy.currentTool
      const proof = kind === "managed_command" ? yield* WorkToolPolicy.describeKnownCommand(witness, outcomeHash)
        : kind === "write" ? yield* WorkToolPolicy.describeKnownWrite(witness, outcomeHash)
        : yield* WorkToolPolicy.describeKnownRead(witness, outcomeHash)
      const plaintext = Buffer.from(CanonicalJson.stringify(proof))
      // Hex encoding is deliberate and bounded by the complete serialized envelope check.
      if (plaintext.length > 7_500) return yield* refused()
      return yield* Effect.try({ try: () => {
        const nonce = randomBytes(12)
        const commandV2 = proof.toolID === "managed_command" && proof.version === 2
        const cipher = createCipheriv("aes-256-gcm", proof.toolID === "read" ? key : proof.toolID === "write" ? writeKey : commandV2 ? commandV2Key : commandKey, nonce)
        cipher.setAAD(proof.toolID === "read" ? aad : proof.toolID === "write" ? writeAad : commandV2 ? commandV2Aad : commandAad)
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
        const data = { version: 1 as const, instanceID: installation.instanceID, nonce: nonce.toString("hex"),
          ciphertext: encrypted.toString("hex"), tag: cipher.getAuthTag().toString("hex") }
        const result = CanonicalJson.stringify({ ...data, mac: proof.toolID === "read" ? mac(data) : proof.toolID === "write" ? writeMac(data) : commandV2 ? commandV2Mac(data) : commandMac(data) })
        if (Buffer.byteLength(result) > MAX_PROOF_BYTES) throw refused()
        return result
      }, catch: () => refused() })
    }).pipe(Effect.provide(context)),
    requireVerified: (effectID) => Effect.suspend(() => {
      const entry = verified.get(effectID)
      if (!lifetime.active) return decline("lifetime", "inactive")
      return entry ? checked(entry.proof, effectID, entry.sealed) : decline("verified-cache", "missing")
    }),
    verify: (effectID) => verify(effectID),
    // Known DAG accounting has an independent cache and purpose. It does not enter the
    // execution cache, refresh a source, read a file or authorize another provider turn.
    authenticateEventTerminal: (effectID) => verify(effectID, undefined, false, true),
    requireEventTerminal: (effectID) => Effect.suspend(() => {
      const entry = eventTerminals.get(effectID)
      return entry && lifetime.active ? checked(entry.proof, effectID, entry.sealed, undefined, false, true) : Effect.fail(refused())
    }),
    releaseEventTerminal: (workID) => Effect.sync(() => eventTerminals.release(workID)),
    authenticateHistorical: (effectID, revision) => Effect.gen(function* () {
      const mutation = yield* Effect.serviceOption(LocalOperator.Mutation)
      const runtime = yield* Effect.serviceOption(LocalOperator.Runtime)
      if (Option.isNone(mutation) || Option.isNone(runtime)) return yield* refused()
      return yield* verify(effectID, { revision, mutation: mutation.value, runtime: runtime.value })
    }),
    authenticateStorage: (effectID) => Effect.gen(function* () {
      const mutation = yield* Effect.serviceOption(LocalOperator.Mutation)
      const runtime = yield* Effect.serviceOption(LocalOperator.Runtime)
      if (Option.isNone(mutation) || Option.isNone(runtime)) return yield* refused()
      const known = yield* verify(effectID, { revision: 0, mutation: mutation.value, runtime: runtime.value }, true)
      if (known.toolID === "read") return yield* refused()
      return known
    }),
  })
}))
