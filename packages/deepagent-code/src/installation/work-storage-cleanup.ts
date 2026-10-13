export * as NativeWorkStorageCleanup from "./work-storage-cleanup"

import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Cause, Context, Effect, Option, Schema, Scope } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import {
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { WorkCommand } from "@deepagent-code/core/session/work-command"
import { WorkWriteStage } from "@deepagent-code/core/session/work-write-stage"
import { WorkKnownRecovery } from "@deepagent-code/core/session/work-known-recovery"
import { WorkKnownRecoveryTable } from "@deepagent-code/core/session/work-known-recovery.sql"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { WorkStorageCleanup } from "@deepagent-code/core/session/work-storage-cleanup"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows.schema"
import { WorkStorageCleanupWindowsWriteSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows-write.schema"
import { V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { LocalTaskAuthority } from "../im/local-task-authority"
import { NativeInstallation } from "./native-installation"
import { LinuxWorkWritePolicy } from "./linux-work-write-policy"
import { WindowsWorkWriteCleanup } from "./windows-work-write-cleanup"
import { WindowsKnownCommandCleanup } from "./windows-known-command-cleanup"

const Snapshot = Schema.Struct({
  dataIdentity: WorkStorageCleanupSchema.Identity,
  baseIdentity: WorkStorageCleanupSchema.Identity,
  containerIdentity: WorkStorageCleanupSchema.Identity,
  files: Schema.Array(WorkStorageCleanupSchema.File).check(Schema.isMaxLength(288)),
  directories: Schema.Array(WorkStorageCleanupSchema.Directory).check(Schema.isMaxLength(4610)),
  linuxWriteProfile: Schema.optional(LinuxWorkWritePolicy.Description),
})
const Completed = Schema.Struct({ proof: WorkStorageCleanupSchema.Proof, mac: WorkStorageCleanupSchema.Digest })
const failure = WorkStorageCleanup.failure
const hash = WorkStorageCleanup.hash
type Custody =
  | NonNullable<Effect.Success<ReturnType<typeof WorkWriteStage.get>>>
  | NonNullable<Effect.Success<ReturnType<typeof WorkCommand.get>>>
type TerminalStorage = {
  purpose: "known_windows_command_storage.v1"
  recoveryID: string
  instanceID: string
  operatorID: string
  workID: string
  rootWorkID: string
  sessionID: string
  inputID: string
  bindingHash: string
  controlRevision: number
  evidence: {
    sourceRecordHash: string
    tools: { admissionID: string; effectID: string; proofHash: string; outcomeHash: string }[]
  }
}
type Entry = {
  kind: "write" | "command"
  admissionID: string
  producer?: WorkToolPolicy.Witness
  manifest?: WorkStorageCleanupWindowsSchema.StoredManifest
  commandJournal?: WorkStorageCleanupWindowsSchema.Journal
  windowsCommand?: Effect.Success<ReturnType<typeof WindowsKnownCommandCleanup.prepare>>
  windows?: Effect.Success<ReturnType<typeof WindowsWorkWriteCleanup.prepare>>
  custody: Custody
  request?: WorkStorageCleanupSchema.Request
  recovery?: WorkKnownRecoverySchema.Record | TerminalStorage
  terminal?: true
  known?: WorkToolPolicy.KnownWrite | WorkToolPolicy.KnownCommand
  operator?: { instanceID: string; operatorID: string; revision: number }
  effectID?: string
}
const jobs = new Map<string, { planHash: string; pending: Promise<typeof Completed.Type> }>()

/** A scoped factory in the original Host Root. The only two producers are the current
 * native tool frame and an explicitly authenticated, actually empty legacy write. */
const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const global = yield* Effect.serviceOption(Global.Service)
  const dataDirectory = Option.isSome(global) ? global.value.data : Global.Path.data
  const execution = yield* Effect.serviceOption(SessionExecution.Service)
  const installed = yield* Effect.serviceOption(WorkExecutionProfile.Services)
  const runtime = yield* Effect.serviceOption(LocalOperator.Runtime)
  const mutation = yield* Effect.serviceOption(LocalOperator.Mutation)
  const context = yield* Effect.context<Scope.Scope>()
  const installation = yield* LocalTaskAuthority.readInstallation.pipe(
    diagnostic("installation"),
    Effect.mapError(() => failure("STORAGE_UNAVAILABLE")),
  )
  const secret = Buffer.from(installation.secret, "hex")
  const entries = new WeakMap<WorkStorageCleanup.Prepared, Entry>()
  const lifetime = { active: true }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      lifetime.active = false
      secret.fill(0)
    }),
  )
  const mac = (domain: string, value: unknown) =>
    createHmac("sha256", secret)
      .update(`${domain}\0`)
      .update(CanonicalJson.stringify([installation.instanceID, value]))
      .digest("hex")
  const verify = (domain: string, value: unknown, stored: string) =>
    Effect.sync(() => {
      if (
        !lifetime.active ||
        !Schema.is(WorkStorageCleanupSchema.Digest)(stored) ||
        !timingSafeEqual(Buffer.from(mac(domain, value), "hex"), Buffer.from(stored, "hex"))
      )
        throw failure("STORAGE_INVALID")
    }).pipe(Effect.catchDefect(() => Effect.fail(failure("STORAGE_INVALID"))))
  const operatorCurrent = (tx: WorkAuthority.Transaction) => {
    if (Option.isNone(runtime) || Option.isNone(mutation)) return Effect.fail(failure("STORAGE_AUTH_REQUIRED"))
    return LocalOperator.requireMutation(tx).pipe(
      Effect.provideService(LocalOperator.Runtime, runtime.value),
      Effect.provideService(LocalOperator.Mutation, mutation.value),
      preserve,
    )
  }
  const verifyRecovery = (record: WorkKnownRecoverySchema.Record, stored: string) =>
    verify("dac-work-known-recovery.v1", record, stored).pipe(
      Effect.mapError(() => WorkKnownRecovery.failure("RECOVERY_INVALID_RECORD")),
    )
  const reserve = (entry: Entry) =>
    Effect.gen(function* () {
      if (!lifetime.active) return yield* failure("STORAGE_UNAVAILABLE")
      const witness = Object.freeze(Object.create(null)) as WorkStorageCleanup.Prepared
      entries.set(witness, entry)
      yield* Effect.addFinalizer(() => Effect.sync(() => entries.delete(witness)))
      return witness
    })
  const custody = (kind: "write" | "command", admissionID: string) =>
    Effect.gen(function* () {
      const record =
        kind === "write"
          ? yield* WorkWriteStage.get(database.db, admissionID)
          : yield* WorkCommand.get(database.db, admissionID)
      return record
    })
  const observe = (entry: Entry, work: WorkAuthority.Work, legacy = false) =>
    Effect.gen(function* () {
      if (
        work.binding.schemaVersion !== "work-execution.v2" ||
        work.binding.projectScope.rootIdentity.kind !== "posix" ||
        entry.custody.instanceID !== installation.instanceID ||
        entry.custody.bindingHash !== work.binding_hash ||
        entry.custody.workID !== work.work_id ||
        entry.custody.rootWorkID !== work.root_work_id ||
        entry.custody.sessionID !== work.session_id ||
        entry.custody.inputID !== work.input_id
      )
        return yield* failure("STORAGE_INVALID")
      const stage = "stageID" in entry.custody ? entry.custody : undefined
      const command = "commandID" in entry.custody ? entry.custody : undefined
      const identity = stage?.stageIdentity ?? command?.workspaceIdentity
      if (!identity || identity.kind !== "posix") return yield* failure("STORAGE_UNSUPPORTED")
      const recipe =
        command && work.binding.toolPolicy.commandRecipes?.find((item) => item.logicalID === command.recipeID)
      if (command && (!recipe || command.state !== "prepared" || command.snapshotHash === null))
        return yield* failure("STORAGE_UNSUPPORTED")
      if (
        stage &&
        (legacy ? stage.state !== "published" || stage.expected.kind !== "missing" : stage.state !== "prepared")
      )
        return yield* failure("STORAGE_UNSUPPORTED")
      const data = yield* Effect.tryPromise({
        try: () => privateData(dataDirectory),
        catch: () => failure("STORAGE_UNKNOWN"),
      })
      const basename = stage?.basename ?? command!.workspaceBasename
      const asset = yield* verifiedAsset
      const observed = yield* run(
        asset,
        {
          op: "inspect",
          version: 1,
          namespace: {
            data: dataDirectory,
            dataIdentity: data,
            project: work.binding.projectScope.canonicalRoot,
            projectIdentity: work.binding.projectScope.rootIdentity,
            base: stage ? "work-write-stage" : "work-command-stage",
            baseIdentity: null,
            basename,
            containerIdentity: identity,
          },
          allowed: stage ? (legacy ? [] : ["payload"]) : [...recipe!.inputs, ...recipe!.outputs],
          deadlineMs: Date.now() + 30000,
        },
        Snapshot,
      )
      if (stage && process.platform === "linux") {
        if (!observed.linuxWriteProfile) return yield* failure("STORAGE_UNSUPPORTED")
        const installed = yield* NativeInstallation.current()
        const inventory = yield* NativeInstallation.inventory(installed)
        const helper = inventory.find(
          (item) => item.path === `packages/work-file-helper/bin/linux-${process.arch}/deepagent-work-file-helper`,
        )
        if (!helper || helper.sha256 !== work.binding.projectScope.helperHash) return yield* failure("STORAGE_INVALID")
        yield* LinuxWorkWritePolicy.check(
          {
            helper: path.join(yield* NativeInstallation.assetDirectory(installed), "deepagent-work-file-helper"),
            helperSHA256: helper.sha256,
            project: work.binding.projectScope.canonicalRoot,
            data: dataDirectory,
            projectIdentity: work.binding.projectScope.rootIdentity,
          },
          observed.linuxWriteProfile,
        ).pipe(Effect.mapError(() => failure("STORAGE_INVALID")))
      }
      if (
        stage &&
        !legacy &&
        (observed.files.length !== 1 ||
          observed.files[0]!.sha256 !== stage.nextHash ||
          observed.files[0]!.bytes !== stage.nextBytes)
      )
        return yield* failure("STORAGE_INVALID")
      const value = yield* decode(WorkStorageCleanupSchema.Manifest, {
        version: 1,
        admissionID: entry.admissionID,
        kind: entry.kind,
        captureKind: legacy ? "known_empty_legacy" : "native_live",
        instanceID: installation.instanceID,
        workID: work.work_id,
        rootWorkID: work.root_work_id,
        sessionID: work.session_id,
        inputID: work.input_id,
        activityID: entry.custody.activityID,
        providerReceiptID: entry.custody.providerReceiptID,
        providerAttemptID: entry.custody.providerAttemptID,
        toolCallID: entry.custody.toolCallID,
        ownerToken: entry.custody.ownerToken,
        sessionClaimToken: entry.custody.sessionClaimToken,
        bindingHash: work.binding_hash,
        controlRevision: entry.custody.controlRevision,
        custodyID: stage?.stageID ?? command!.commandID,
        sourceRequestHash: entry.custody.requestHash,
        helperHash: entry.custody.helperHash,
        snapshotHash: command?.snapshotHash ?? null,
        project: work.binding.projectScope.canonicalRoot,
        projectIdentity: work.binding.projectScope.rootIdentity,
        data: dataDirectory,
        dataIdentity: observed.dataIdentity,
        baseIdentity: observed.baseIdentity,
        containerIdentity: observed.containerIdentity,
        basename,
        files: observed.files,
        directories: observed.directories,
        createdAt: Date.now(),
      })
      entry.manifest = value
      return value
    })
  const currentFacts = (tx: WorkAuthority.Transaction, entry: Entry, row?: WorkStorageCleanup.Row) =>
    Effect.gen(function* () {
      if (
        !lifetime.active ||
        !entry.request ||
        (!entry.recovery && !entry.terminal) ||
        !entry.known ||
        !entry.operator ||
        !entry.effectID ||
        Option.isNone(execution) ||
        (yield* execution.value.active).has(SessionSchema.ID.make(entry.custody.sessionID))
      )
        return yield* failure("STORAGE_UNKNOWN")
      const operator = yield* operatorCurrent(tx)
      const work = yield* WorkAuthority.get(tx, entry.custody.workID)
      const session = yield* tx
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(entry.custody.sessionID)))
        .get()
      const stored =
        entry.kind === "write"
          ? yield* WorkWriteStage.get(tx, entry.admissionID)
          : yield* WorkCommand.get(tx, entry.admissionID)
      const effect = yield* tx
        .select()
        .from(V2ToolEffectTable)
        .where(eq(V2ToolEffectTable.effect_id, entry.effectID))
        .get()
      const recovery = entry.terminal
        ? (() => {
            if (
              !work ||
              !effect ||
              !stored ||
              !("commandID" in stored) ||
              stored.version !== 2 ||
              !effect.known_command_proof ||
              entry.request!.recoveryID !== terminalRecoveryID(entry.admissionID) ||
              stored.state !== "settled" ||
              stored.outcome !== "exited" ||
              !stored.stopConfirmed ||
              entry.known!.toolID !== "managed_command" ||
              entry.known!.version !== 2
            )
              return undefined
            const value: TerminalStorage = {
              purpose: "known_windows_command_storage.v1",
              recoveryID: entry.request!.recoveryID,
              instanceID: operator.instance_id,
              operatorID: operator.operator_id,
              workID: work.work_id,
              rootWorkID: work.root_work_id,
              sessionID: work.session_id,
              inputID: work.input_id,
              bindingHash: work.binding_hash,
              controlRevision: entry.known!.controlRevision,
              evidence: {
                sourceRecordHash: work.source_record_hash,
                tools: [
                  {
                    admissionID: entry.admissionID,
                    effectID: effect.effect_id,
                    proofHash: Hash.sha256(effect.known_command_proof),
                    outcomeHash: effect.outcome_hash,
                  },
                ],
              },
            }
            return value
          })()
        : yield* WorkKnownRecovery.read(
            tx,
            eq(WorkKnownRecoveryTable.recovery_id, entry.request.recoveryID),
            verifyRecovery,
          )
      const pending = yield* tx.all<{ count: number }>(sql`SELECT
      (SELECT count(*) FROM session_provider_attempt WHERE session_id=${entry.custody.sessionID} AND (state NOT IN ('settled','failed') OR (${entry.terminal ? 1 : 0} AND state!='settled')))+
      (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id=${entry.custody.sessionID} AND (state NOT IN ('settled','failed') OR (${entry.terminal ? 1 : 0} AND state!='settled')))+
      (SELECT count(*) FROM session_v2_tool_effect_admission a WHERE a.session_id=${entry.custody.sessionID}
        AND NOT EXISTS(SELECT 1 FROM session_v2_tool_effect e WHERE e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id
          AND e.state='settled' AND e.error_code IS NULL)) count`)
      const owner = yield* tx
        .select({ token: SessionProviderOwnerLeaseTable.owner_token })
        .from(SessionProviderOwnerLeaseTable)
        .innerJoin(
          SessionProviderAttemptTable,
          eq(SessionProviderAttemptTable.owner_token, SessionProviderOwnerLeaseTable.owner_token),
        )
        .where(
          and(
            eq(SessionProviderAttemptTable.session_id, SessionSchema.ID.make(entry.custody.sessionID)),
            sql`${SessionProviderOwnerLeaseTable.released_at} IS NULL`,
            sql`${SessionProviderOwnerLeaseTable.lease_expires_at}>${Date.now()}`,
          ),
        )
        .get()
      if (
        !recovery ||
        (entry.recovery && hash(recovery) !== hash(entry.recovery)) ||
        !work ||
        work.binding.schemaVersion !== "work-execution.v2" ||
        work.parent_work_id ||
        work.outcome === "unknown" ||
        work.admission_state !== "ready" ||
        !(work.outcome === "succeeded" || work.outcome === "failed" || work.control_state === "cancelled") ||
        work.binding_hash !== entry.custody.bindingHash ||
        work.binding_hash !== recovery.bindingHash ||
        work.root_work_id !== recovery.rootWorkID ||
        work.session_id !== recovery.sessionID ||
        work.input_id !== recovery.inputID ||
        work.source_record_hash !== recovery.evidence.sourceRecordHash ||
        work.binding.scope.actorID !== operator.operator_id ||
        operator.instance_id !== entry.operator.instanceID ||
        operator.operator_id !== entry.operator.operatorID ||
        operator.revision !== entry.operator.revision ||
        !session ||
        session.execution_claim_token !== null ||
        session.directory !== work.binding.location.directory ||
        session.project_id !== work.binding.projectScope.projectID ||
        session.workspace_id !== null ||
        owner ||
        pending[0]?.count !== 0 ||
        !stored ||
        !effect ||
        effect.state !== "settled" ||
        effect.error_code !== null ||
        effect.outcome_hash !== entry.known.outcomeHash ||
        effect.session_id !== entry.known.sessionID ||
        effect.receipt_id !== entry.known.receiptID ||
        effect.provider_attempt_id !== entry.known.attemptID ||
        effect.tool_call_id !== entry.known.toolCallID ||
        effect.owner_token !== entry.known.ownerToken ||
        effect.tool_name !== entry.known.toolID ||
        effect.effect_kind !== "mutating"
      )
        return yield* failure("STORAGE_UNKNOWN")
      const evidence = recovery.evidence.tools.find(
        (item) => item.admissionID === entry.admissionID && item.effectID === entry.effectID,
      )
      const sealed = entry.kind === "write" ? effect.known_write_proof : effect.known_command_proof
      if (
        !evidence ||
        !sealed ||
        Hash.sha256(sealed) !== evidence.proofHash ||
        evidence.outcomeHash !== effect.outcome_hash ||
        (row?.phase !== "released" &&
          (hash(stored) !== hash(entry.custody) ||
            stored.releasedAt !== null ||
            stored.revision !== entry.request.expectedCustodyRevision)) ||
        (row?.phase === "released" && (stored.releasedAt === null || row.released_bytes <= 0))
      )
        return yield* failure("STORAGE_CONFLICT")
      return { work, stored, effect, evidence, recovery }
    }).pipe(Effect.provide(context))
  const authority = WorkStorageCleanup.Authority.of({
    prepareManifest: (input) =>
      Effect.gen(function* () {
        const producer = yield* WorkToolPolicy.storageProducer(input.kind, input.admissionID)
        const record = yield* custody(input.kind, input.admissionID)
        if (!record || record.releasedAt !== null) return yield* failure("STORAGE_UNKNOWN")
        const work = yield* WorkAuthority.get(database.db, record.workID)
        if (!work) return yield* failure("STORAGE_INVALID")
        const entry: Entry = { ...input, producer, custody: record }
        yield* observe(entry, work)
        // Independent Native inspection may outlive the short source proof. Refresh
        // the same canonical producer before SQL consumes its captured authority.
        if ((yield* WorkToolPolicy.storageProducer(input.kind, input.admissionID)) !== producer)
          return yield* failure("STORAGE_CONFLICT")
        return yield* reserve(entry)
      }).pipe(preserve),
    manifest: (tx, witness) =>
      Effect.gen(function* () {
        const entry = entries.get(witness)
        if (!entry?.manifest) return yield* failure("STORAGE_INVALID")
        if (entry.producer) {
          const actual = yield* WorkToolPolicy.requireStorageProducer(tx, entry.producer, entry.kind, entry.admissionID)
          const stored =
            entry.kind === "write"
              ? yield* WorkWriteStage.get(tx, entry.admissionID)
              : yield* WorkCommand.get(tx, entry.admissionID)
          if (
            !stored ||
            hash(stored) !== hash(entry.custody) ||
            actual.work.binding_hash !== entry.manifest.bindingHash
          )
            return yield* failure("STORAGE_CONFLICT")
        }
        if (!entry.producer) {
          yield* currentFacts(tx, entry)
          if (entry.manifest.captureKind !== "known_empty_legacy") return yield* failure("STORAGE_INVALID")
        }
        return { value: entry.manifest, mac: mac("dac-work-storage-manifest.v1", entry.manifest) }
      }).pipe(Effect.provide(context), preserve),
    prepare: (request, row) =>
      Effect.gen(function* () {
        if (Option.isNone(runtime) || Option.isNone(mutation)) return yield* failure("STORAGE_AUTH_REQUIRED")
        if (!row)
          yield* refuseUncapturedCommand(request).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(LocalOperator.Runtime, runtime.value),
            Effect.provideService(LocalOperator.Mutation, mutation.value),
          )
        const { ProductionWorkExecution } = yield* Effect.promise(() => import("./work-execution-profile"))
        const production = yield* Effect.serviceOption(ProductionWorkExecution.Service)
        const leaf = Option.isSome(installed)
          ? installed.value.leafProof
          : Option.isSome(production)
            ? production.value.leafProof
            : undefined
        if (!leaf?.authenticateStorage || Option.isNone(runtime) || Option.isNone(mutation)) {
          yield* diagnostic("services")(Effect.fail(failure("STORAGE_UNAVAILABLE")))
          return yield* failure("STORAGE_UNAVAILABLE")
        }
        const terminal = request.recoveryID.startsWith("wstorage_terminal_")
        if (
          terminal &&
          (request.recoveryID !== terminalRecoveryID(request.admissionID) ||
            row?.manifest.version !== 2 ||
            row.manifest.kind !== "command")
        )
          return yield* failure("STORAGE_INVALID")
        const recovery = terminal
          ? undefined
          : yield* WorkKnownRecovery.read(
              database.db,
              eq(WorkKnownRecoveryTable.recovery_id, request.recoveryID),
              verifyRecovery,
            )
        if (!terminal && (!recovery || recovery.instanceID !== installation.instanceID))
          return yield* failure("STORAGE_INVALID")
        const evidence = terminal
          ? yield* database.db.all<{ effectID: string }>(sql`SELECT e.effect_id effectID
        FROM session_v2_tool_effect_admission a JOIN session_v2_tool_effect e
          ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id
        WHERE a.admission_id=${request.admissionID} AND e.tool_name='managed_command' AND e.effect_kind='mutating'
          AND e.state='settled' AND e.error_code IS NULL
          AND length(CAST(e.known_command_proof AS BLOB)) BETWEEN 1 AND 16384 LIMIT 2`)
          : recovery!.evidence.tools.filter((item) => item.admissionID === request.admissionID)
        if (evidence.length !== 1) return yield* failure("STORAGE_UNSUPPORTED")
        const known = yield* leaf
          .authenticateStorage(evidence[0]!.effectID)
          .pipe(
            diagnostic("authenticate_known"),
            Effect.provideService(LocalOperator.Runtime, runtime.value),
            Effect.provideService(LocalOperator.Mutation, mutation.value),
          )
        const kind = known.toolID === "write" ? ("write" as const) : ("command" as const)
        const record = yield* custody(kind, request.admissionID)
        if (
          !record ||
          known.admissionID !== request.admissionID ||
          (terminal && (!("commandID" in record) || record.version !== 2)) ||
          (recovery && (known.workID !== recovery.workID || known.bindingHash !== recovery.bindingHash)) ||
          ("commandID" in record &&
            (record.state !== "settled" || !record.stopConfirmed || record.outcome !== "exited")) ||
          ("stageID" in record && !["published", "refused"].includes(record.state))
        )
          return yield* failure("STORAGE_UNKNOWN")
        const operator = yield* database.db.transaction((tx) => operatorCurrent(tx)).pipe(diagnostic("operator"))
        const entry: Entry = {
          kind,
          admissionID: request.admissionID,
          custody: record,
          request,
          recovery,
          known,
          ...(terminal ? { terminal: true as const } : {}),
          effectID: evidence[0]!.effectID,
          operator: { instanceID: operator.instance_id, operatorID: operator.operator_id, revision: operator.revision },
        }
        const facts = yield* database.db
          .transaction((tx) => currentFacts(tx, entry, row))
          .pipe(diagnostic("current_facts"))
        entry.recovery = facts.recovery
        if (row) {
          yield* verify(
            row.manifest.version === 2
              ? row.manifest.kind === "write"
                ? "dac-work-windows-write-manifest.v2"
                : "dac-work-windows-command-manifest.v2"
              : "dac-work-storage-manifest.v1",
            row.manifest,
            row.manifest_mac,
          )
          if (
            row.manifest.kind !== kind ||
            row.manifest.workID !== known.workID ||
            row.manifest.bindingHash !== known.bindingHash ||
            row.manifest.data !== dataDirectory ||
            row.manifest.project !== facts.work.binding.location.directory ||
            row.manifest.custodyID !== ("stageID" in record ? record.stageID : record.commandID) ||
            row.manifest.sourceRequestHash !== record.requestHash ||
            row.manifest.helperHash !== known.helperHash ||
            row.manifest.controlRevision !== known.controlRevision
          )
            return yield* failure("STORAGE_INVALID")
          entry.manifest = row.manifest
          if (row.manifest.version === 2 && row.manifest.kind === "command") {
            if (
              !Schema.is(WorkStorageCleanupWindowsSchema.Manifest)(row.manifest) ||
              !("commandID" in record) ||
              record.version !== 2 ||
              known.toolID !== "managed_command" ||
              known.version !== 2 ||
              facts.work.binding.schemaVersion !== "work-execution.v2" ||
              facts.work.binding.projectScope.rootIdentity.kind !== "windows" ||
              row.manifest.target !== record.target ||
              known.supervision.target !== record.target ||
              known.supervision.nonce !== record.processIncarnation ||
              hash(row.manifest.containerIdentity) !== hash(record.workspaceIdentity) ||
              hash(row.manifest.projectIdentity) !== hash(known.rootIdentity) ||
              row.manifest.snapshotHash !== record.snapshotHash ||
              row.manifest.basename !== record.workspaceBasename
            )
              return yield* failure("STORAGE_INVALID")
            const recipe = facts.work.binding.toolPolicy.commandRecipes?.find(
              (item) => item.logicalID === record.recipeID,
            )
            if (
              !recipe ||
              recipe.schemaVersion !== "work-command-recipe.v2" ||
              recipe.executable.platform !== record.target ||
              recipe.revision !== record.recipeRevision ||
              hash(recipe) !== record.recipeHash ||
              record.outputs.length !== recipe.outputs.length ||
              record.outputs.some(
                (item) =>
                  !recipe.outputs.includes(item.relative) ||
                  item.identity.kind !== "windows" ||
                  !row.manifest.files.some(
                    (file) => file.relative === item.relative && hash(file.identity) === hash(item.identity),
                  ),
              )
            )
              return yield* failure("STORAGE_INVALID")
            const files = [
              ...row.manifest.files.filter((file) => recipe.inputs.includes(file.relative)),
              ...record.outputs.map((file) => ({
                relative: file.relative,
                identity: file.identity,
                bytes: file.bytes,
                sha256: file.sha256,
              })),
            ]
            const requestHash = hash({
              domain: "dac-work-windows-command-cleanup.v2",
              ...entry.operator,
              request: entry.request,
            })
            const journal =
              row.journal ??
              (yield* decode(WorkStorageCleanupWindowsSchema.Journal, {
                version: 2,
                target: row.manifest.target,
                security: row.manifest.security,
                cleanupID: `wcleanup_${requestHash}`,
                request: entry.request,
                requestHash,
                instanceID: entry.operator!.instanceID,
                operatorID: entry.operator!.operatorID,
                operatorRevision: entry.operator!.revision,
                manifestHash: row.manifest_hash,
                custodyRecordHash: hash(record),
                recoveryRecordHash: hash(facts.recovery),
                effectID: entry.effectID,
                effectHash: hash(facts.effect),
                proofHash: facts.evidence.proofHash,
                knownHash: hash(entry.known),
                quarantine: `cleanup_${requestHash.slice(0, 32)}`,
                files,
                directories: row.manifest.directories,
                createdAt: Date.now(),
              }))
            if (
              !Schema.is(WorkStorageCleanupWindowsSchema.Journal)(journal) ||
              journal.cleanupID !== `wcleanup_${requestHash}` ||
              journal.manifestHash !== row.manifest_hash ||
              journal.requestHash !== requestHash ||
              hash(journal.files) !== hash(files) ||
              hash(journal.directories) !== hash(row.manifest.directories) ||
              hash(journal.security) !== hash(row.manifest.security) ||
              journal.target !== row.manifest.target ||
              journal.quarantine !== `cleanup_${requestHash.slice(0, 32)}` ||
              hash(journal.request) !== hash(entry.request) ||
              journal.instanceID !== entry.operator!.instanceID ||
              journal.operatorID !== entry.operator!.operatorID ||
              journal.operatorRevision !== entry.operator!.revision ||
              journal.recoveryRecordHash !== hash(facts.recovery) ||
              journal.knownHash !== hash(entry.known) ||
              journal.effectHash !== hash(facts.effect) ||
              journal.proofHash !== facts.evidence.proofHash ||
              (row.phase !== "released" && journal.custodyRecordHash !== hash(record))
            )
              return yield* failure("STORAGE_CONFLICT")
            if (row.journal) yield* verify("dac-work-windows-command-journal.v2", journal, row.journal_mac!)
            entry.commandJournal = journal
            if (row.phase === "released") yield* WindowsKnownCommandCleanup.requireAvailable(row.manifest.helperHash)
            if (row.phase !== "released")
              entry.windowsCommand = yield* WindowsKnownCommandCleanup.prepare(
                row.manifest,
                journal,
                { nonce: known.supervision.nonce, inputs: recipe.inputs, outputs: recipe.outputs },
                mac("dac-work-windows-command-job.v2", [journal.cleanupID, hash(journal)]),
              ).pipe(diagnostic("native_prepare"))
          }
          if (row.manifest.version === 2 && row.manifest.kind === "write") {
            if (
              !Schema.is(WorkStorageCleanupWindowsWriteSchema.Manifest)(row.manifest) ||
              !("stageID" in record) ||
              facts.work.binding.schemaVersion !== "work-execution.v2" ||
              facts.work.binding.projectScope.rootIdentity.kind !== "windows" ||
              (record.state !== "refused" && row.manifest.stagePhase !== "prepared_payload") ||
              hash(row.manifest.containerIdentity) !== hash(record.stageIdentity) ||
              hash(row.manifest.projectIdentity) !== hash(record.rootIdentity)
            )
              return yield* failure("STORAGE_INVALID")
            if (row.phase === "released") yield* WindowsWorkWriteCleanup.requireAvailable(row.manifest.helperHash)
            if (row.phase !== "released")
              entry.windows = yield* WindowsWorkWriteCleanup.prepare(
                row.manifest,
                record.state === "published" ? [] : row.manifest.files,
              )
          }
        }
        if (!row) {
          if (kind !== "write") return yield* failure("STORAGE_UNSUPPORTED")
          yield* observe(entry, facts.work, true)
        }
        return yield* reserve(entry)
      }).pipe(Effect.provide(context), preserve),
    current: (tx, witness, row) =>
      Effect.gen(function* () {
        const entry = entries.get(witness)
        if (!entry?.manifest || !entry.request || !entry.operator || !entry.known)
          return yield* failure("STORAGE_INVALID")
        const facts = yield* currentFacts(tx, entry, row)
        if (hash(entry.manifest) !== row.manifest_hash) return yield* failure("STORAGE_CONFLICT")
        if (row.manifest.version === 2 && row.manifest.kind === "command") {
          const journal = entry.commandJournal
          if (
            !journal ||
            !("commandID" in facts.stored) ||
            facts.stored.version !== 2 ||
            (row.phase !== "released" && !entry.windowsCommand?.isCurrent()) ||
            (row.journal && hash(row.journal) !== hash(journal)) ||
            hash(journal.request) !== hash(entry.request) ||
            journal.recoveryRecordHash !== hash(facts.recovery) ||
            journal.knownHash !== hash(entry.known) ||
            journal.effectHash !== hash(facts.effect) ||
            journal.proofHash !== facts.evidence.proofHash ||
            (row.phase !== "released" && journal.custodyRecordHash !== hash(facts.stored))
          )
            return yield* failure("STORAGE_CONFLICT")
          return { journal, mac: mac("dac-work-windows-command-journal.v2", journal) }
        }
        if (row.manifest.version === 2 && row.manifest.kind === "write") {
          if (
            entry.manifest.version !== 2 ||
            !("stageID" in facts.stored) ||
            (row.phase !== "released" && !entry.windows?.isCurrent())
          )
            return yield* failure("STORAGE_UNSUPPORTED")
          if (row.journal) {
            if (!Schema.is(WorkStorageCleanupWindowsWriteSchema.Journal)(row.journal))
              return yield* failure("STORAGE_INVALID")
            yield* verify("dac-work-windows-write-journal.v2", row.journal, row.journal_mac!)
            if (
              hash(row.journal.request) !== hash(entry.request) ||
              row.journal.instanceID !== entry.operator.instanceID ||
              row.journal.operatorID !== entry.operator.operatorID ||
              row.journal.operatorRevision !== entry.operator.revision ||
              row.journal.recoveryRecordHash !== hash(facts.recovery) ||
              row.journal.knownHash !== hash(entry.known) ||
              row.journal.effectHash !== hash(facts.effect) ||
              row.journal.proofHash !== facts.evidence.proofHash ||
              (row.phase !== "released" && row.journal.custodyRecordHash !== hash(facts.stored))
            )
              return yield* failure("STORAGE_CONFLICT")
            return { journal: row.journal, mac: row.journal_mac! }
          }
          const requestHash = hash({
            domain: "dac-work-windows-write-cleanup.v2",
            ...entry.operator,
            request: entry.request,
          })
          const journal = yield* decode(WorkStorageCleanupWindowsWriteSchema.Journal, {
            version: 2,
            target: row.manifest.target,
            purpose: "work_write",
            cleanupID: `wcleanup_${requestHash}`,
            request: entry.request,
            requestHash,
            instanceID: entry.operator.instanceID,
            operatorID: entry.operator.operatorID,
            operatorRevision: entry.operator.revision,
            manifestHash: row.manifest_hash,
            custodyRecordHash: hash(facts.stored),
            recoveryRecordHash: hash(facts.recovery),
            effectID: entry.effectID,
            effectHash: hash(facts.effect),
            proofHash: facts.evidence.proofHash,
            knownHash: hash(entry.known),
            quarantine: `cleanup_${requestHash.slice(0, 32)}`,
            files: facts.stored.state === "published" ? [] : row.manifest.files,
            directories: row.manifest.directories,
            createdAt: Date.now(),
          })
          return { journal, mac: mac("dac-work-windows-write-journal.v2", journal) }
        }
        if (entry.manifest.version !== 1) return yield* failure("STORAGE_UNSUPPORTED")
        if (row.journal) {
          yield* verify("dac-work-storage-journal.v1", row.journal, row.journal_mac!)
          if (
            hash(row.journal.request) !== hash(entry.request) ||
            row.journal.instanceID !== entry.operator.instanceID ||
            row.journal.operatorID !== entry.operator.operatorID ||
            row.journal.operatorRevision !== entry.operator.revision ||
            row.journal.recoveryRecordHash !== hash(facts.recovery) ||
            row.journal.knownHash !== hash(entry.known) ||
            row.journal.effectHash !== hash(facts.effect) ||
            row.journal.proofHash !== facts.evidence.proofHash ||
            (row.phase !== "released" && row.journal.custodyRecordHash !== hash(facts.stored))
          )
            return yield* failure("STORAGE_CONFLICT")
          return { journal: row.journal, mac: row.journal_mac! }
        }
        const requestHash = hash({ domain: "dac-work-storage-cleanup.v1", ...entry.operator, request: entry.request })
        const cleanupID = `wcleanup_${requestHash}`
        const stage = "stageID" in facts.stored ? facts.stored : undefined
        const command = "commandID" in facts.stored ? facts.stored : undefined
        const recipe =
          command && facts.work.binding.schemaVersion === "work-execution.v2"
            ? facts.work.binding.toolPolicy.commandRecipes?.find((item) => item.logicalID === command.recipeID)
            : undefined
        if (
          command &&
          (!recipe ||
            entry.manifest.captureKind !== "native_live" ||
            entry.manifest.snapshotHash !== command.snapshotHash ||
            command.outputs.length !== recipe.outputs.length ||
            command.outputs.some((item) => !recipe.outputs.includes(item.relative)))
        )
          return yield* failure("STORAGE_UNSUPPORTED")
        const files = command
          ? [...entry.manifest.files.filter((item) => recipe!.inputs.includes(item.relative)), ...command.outputs]
          : stage!.state === "published"
            ? stage!.expected.kind === "missing"
              ? []
              : [
                  {
                    relative: "payload",
                    identity: stage!.expected.identity,
                    sha256: stage!.expected.sha256,
                    bytes: stage!.expected.bytes,
                  },
                ]
            : entry.manifest.files
        const journal = yield* decode(WorkStorageCleanupSchema.Journal, {
          version: 1,
          cleanupID,
          request: entry.request,
          requestHash,
          instanceID: entry.operator.instanceID,
          operatorID: entry.operator.operatorID,
          operatorRevision: entry.operator.revision,
          manifestHash: row.manifest_hash,
          custodyRecordHash: hash(facts.stored),
          recoveryRecordHash: hash(facts.recovery),
          effectID: entry.effectID,
          effectHash: hash(facts.effect),
          proofHash: facts.evidence.proofHash,
          knownHash: hash(entry.known),
          quarantine: `cleanup_${requestHash.slice(0, 32)}`,
          files,
          directories: entry.manifest.directories,
          createdAt: Date.now(),
        })
        return { journal, mac: mac("dac-work-storage-journal.v1", journal) }
      }).pipe(Effect.provide(context), preserve),
    execute: (witness, row) =>
      Effect.gen(function* () {
        const entry = entries.get(witness)
        if (!entry || !row.journal || !entry.manifest) return yield* failure("STORAGE_INVALID")
        yield* database.db.transaction((tx) => currentFacts(tx, entry, row))
        if (row.manifest.version === 2 && row.manifest.kind === "command") {
          if (
            !entry.windowsCommand ||
            !Schema.is(WorkStorageCleanupWindowsSchema.Journal)(row.journal) ||
            entry.known?.toolID !== "managed_command" ||
            entry.known.version !== 2
          )
            return yield* failure("STORAGE_UNSUPPORTED")
          const retired = yield* entry.windowsCommand.collect
          const proof = yield* decode(WorkStorageCleanupWindowsSchema.Proof, {
            version: 2,
            target: row.manifest.target,
            cleanupID: row.cleanup_id,
            manifestHash: row.manifest_hash,
            planHash: row.journal_hash,
            dataIdentity: row.manifest.dataIdentity,
            baseIdentity: row.manifest.baseIdentity,
            containerIdentity: row.manifest.containerIdentity,
            quarantine: row.journal.quarantine,
            state: "empty_verified",
            files: row.journal.files.length,
            observedAt: Date.now(),
            ...retired,
            jobRetired: entry.known.supervision.treeEmpty,
            appContainerRetired: true,
            aclRestored: true,
          })
          return { proof, mac: mac("dac-work-windows-command-empty.v2", proof) }
        }
        if (row.manifest.version === 2 && row.manifest.kind === "write") {
          if (!entry.windows || !Schema.is(WorkStorageCleanupWindowsWriteSchema.Journal)(row.journal))
            return yield* failure("STORAGE_UNSUPPORTED")
          const retired = yield* entry.windows.collect
          const proof = yield* decode(WorkStorageCleanupWindowsWriteSchema.Proof, {
            version: 2,
            target: row.manifest.target,
            purpose: "work_write",
            cleanupID: row.cleanup_id,
            manifestHash: row.manifest_hash,
            planHash: row.journal_hash,
            dataIdentity: row.manifest.dataIdentity,
            baseIdentity: row.manifest.baseIdentity,
            containerIdentity: row.manifest.containerIdentity,
            quarantine: row.journal.quarantine,
            state: "empty_verified",
            files: row.journal.files.length,
            observedAt: Date.now(),
            ...retired,
          })
          return { proof, mac: mac("dac-work-windows-write-empty.v2", proof) }
        }
        if (row.journal.version !== 1 || entry.manifest.version !== 1) return yield* failure("STORAGE_UNSUPPORTED")
        const asset = yield* verifiedAsset
        const planHash = row.journal_hash!
        const jobKey = mac("dac-work-storage-job.v1", [row.cleanup_id, planHash])
        const payload = {
          op: "cleanup",
          version: 1,
          namespace: {
            data: row.manifest.data,
            dataIdentity: row.manifest.dataIdentity,
            project: row.manifest.project,
            projectIdentity: row.manifest.projectIdentity,
            base: row.kind === "write" ? "work-write-stage" : "work-command-stage",
            baseIdentity: row.manifest.baseIdentity,
            basename: row.manifest.basename,
            containerIdentity: row.manifest.containerIdentity,
          },
          cleanupID: row.cleanup_id,
          manifestHash: row.manifest_hash,
          planHash,
          quarantine: row.journal.quarantine,
          files: row.journal.files,
          directories: row.journal.directories,
          jobKey,
          deadlineMs: Date.now() + 30000,
        }
        const existing = jobs.get(row.cleanup_id!)
        if (existing && existing.planHash !== planHash) return yield* failure("STORAGE_CONFLICT")
        if (existing)
          return yield* Effect.tryPromise({ try: () => existing.pending, catch: () => failure("STORAGE_UNKNOWN") })
        const controller = new AbortController()
        const pending = invoke(asset, payload, Completed, controller.signal)
        jobs.set(row.cleanup_id!, { planHash, pending })
        return yield* Effect.tryPromise({
          try: (signal) => {
            signal.addEventListener("abort", () => controller.abort(), { once: true })
            return pending
          },
          catch: () => failure("STORAGE_UNKNOWN"),
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              await pending.catch(() => undefined)
              jobs.delete(row.cleanup_id!)
            }),
          ),
        )
      }).pipe(Effect.provide(context), preserve),
    verifyManifest: (value, stored) =>
      value.version === 1
        ? verify("dac-work-storage-manifest.v1", value, stored)
        : Schema.is(WorkStorageCleanupWindowsWriteSchema.Manifest)(value)
          ? verify("dac-work-windows-write-manifest.v2", value, stored)
          : Schema.is(WorkStorageCleanupWindowsSchema.Manifest)(value)
            ? verify("dac-work-windows-command-manifest.v2", value, stored)
            : Effect.fail(failure("STORAGE_UNSUPPORTED")),
    verifyJournal: (value, stored) =>
      value.version === 1
        ? verify("dac-work-storage-journal.v1", value, stored)
        : Schema.is(WorkStorageCleanupWindowsWriteSchema.Journal)(value)
          ? verify("dac-work-windows-write-journal.v2", value, stored)
          : Schema.is(WorkStorageCleanupWindowsSchema.Journal)(value)
            ? verify("dac-work-windows-command-journal.v2", value, stored)
            : Effect.fail(failure("STORAGE_UNSUPPORTED")),
    verifyProof: (value, stored, journal) =>
      Effect.gen(function* () {
        if (
          Schema.is(WorkStorageCleanupWindowsSchema.Proof)(value) &&
          Schema.is(WorkStorageCleanupWindowsSchema.Journal)(journal)
        ) {
          yield* verify("dac-work-windows-command-empty.v2", value, stored)
          if (
            value.target !== journal.target ||
            hash(value.security) !== hash(journal.security) ||
            value.cleanupID !== journal.cleanupID ||
            value.manifestHash !== journal.manifestHash ||
            value.planHash !== hash(journal) ||
            value.quarantine !== journal.quarantine ||
            value.files !== journal.files.length ||
            value.observedAt > Date.now()
          )
            return yield* failure("STORAGE_INVALID")
          return
        }
        if (
          Schema.is(WorkStorageCleanupWindowsWriteSchema.Proof)(value) &&
          Schema.is(WorkStorageCleanupWindowsWriteSchema.Journal)(journal)
        ) {
          yield* verify("dac-work-windows-write-empty.v2", value, stored)
          if (
            value.target !== journal.target ||
            value.cleanupID !== journal.cleanupID ||
            value.manifestHash !== journal.manifestHash ||
            value.planHash !== hash(journal) ||
            value.quarantine !== journal.quarantine ||
            value.files !== journal.files.length ||
            value.observedAt > Date.now()
          )
            return yield* failure("STORAGE_INVALID")
          return
        }
        if (value.version !== 1 || journal.version !== 1) return yield* failure("STORAGE_UNSUPPORTED")
        const jobKey = Buffer.from(mac("dac-work-storage-job.v1", [journal.cleanupID, hash(journal)]), "hex")
        const actual = createHmac("sha256", jobKey)
          .update("dac-work-storage-empty.v1\0")
          .update(CanonicalJson.stringify(value))
          .digest("hex")
        jobKey.fill(0)
        if (
          !Schema.is(WorkStorageCleanupSchema.Digest)(stored) ||
          !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(stored, "hex")) ||
          value.cleanupID !== journal.cleanupID ||
          value.manifestHash !== journal.manifestHash ||
          value.planHash !== hash(journal) ||
          value.quarantine !== journal.quarantine ||
          value.files !== journal.files.length ||
          value.observedAt > Date.now()
        )
          return yield* failure("STORAGE_INVALID")
      }),
  })
  return { authority, database }
})

/** Deterministic storage identity, never an execution or recovery authority. */
export function terminalRecoveryID(admissionID: string) {
  return `wstorage_terminal_${hash({ domain: "dac-windows-known-terminal-storage.v1", admissionID })}`
}

/** Called only by the actual native helper after preparation and before dispatch. */
export const capture = Effect.fn("NativeWorkStorageCleanup.capture")(
  function* (input: { kind: "write" | "command"; admissionID: string }) {
    const host = yield* make
    const witness = yield* host.authority.prepareManifest(input)
    return yield* WorkStorageCleanup.capture(host.database.db, witness).pipe(
      Effect.provideService(WorkStorageCleanup.Authority, host.authority),
    )
  },
  Effect.scoped,
  preserve,
)

/** Explicit operator-only entry, creates no runner, provider call or tool admission. */
export const cleanup = Effect.fn("NativeWorkStorageCleanup.cleanup")(
  function* (input: WorkStorageCleanupSchema.Request) {
    const host = yield* make
    return yield* WorkStorageCleanup.cleanup(host.database.db, input).pipe(
      Effect.provideService(WorkStorageCleanup.Authority, host.authority),
      diagnostic("cleanup"),
    )
  },
  Effect.scoped,
  preserve,
)

/** A read-only refusal also works against the historical schema. It authenticates the
 * actual operator and recovery MAC, but never decrypts a native outcome, inspects private
 * storage, recreates a manifest or returns a deletion/execution capability. */
export const refuseUncapturedCommand = Effect.fn("NativeWorkStorageCleanup.refuseUncapturedCommand")(
  function* (input: WorkStorageCleanupSchema.Request) {
    const request = yield* decode(WorkStorageCleanupSchema.Request, input)
    const database = yield* Database.Service
    const installation = yield* LocalTaskAuthority.readInstallation
    const secret = Buffer.from(installation.secret, "hex")
    yield* Effect.addFinalizer(() => Effect.sync(() => secret.fill(0)))
    const recovery = yield* WorkKnownRecovery.read(
      database.db,
      eq(WorkKnownRecoveryTable.recovery_id, request.recoveryID),
      (record, stored) =>
        Effect.gen(function* () {
          const actual = createHmac("sha256", secret)
            .update("dac-work-known-recovery.v1\0")
            .update(CanonicalJson.stringify([installation.instanceID, record]))
            .digest("hex")
          if (
            record.instanceID !== installation.instanceID ||
            !Schema.is(WorkKnownRecoverySchema.Digest)(stored) ||
            !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(stored, "hex"))
          )
            return yield* WorkKnownRecovery.failure("RECOVERY_INVALID_RECORD")
        }),
    )
    if (!recovery) return yield* failure("STORAGE_INVALID")
    return yield* database.db.transaction((tx) =>
      Effect.gen(function* () {
        const operator = yield* LocalOperator.requireMutation(tx)
        const command = yield* WorkCommand.get(tx, request.admissionID)
        if (!command) return
        const work = yield* WorkAuthority.get(tx, command.workID)
        const session = yield* tx
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(command.sessionID)))
          .get()
        const tool = recovery.evidence.tools.filter((item) => item.admissionID === command.admissionID)
        if (
          operator.instance_id !== installation.instanceID ||
          operator.operator_id !== recovery.operatorID ||
          !work ||
          work.binding.schemaVersion !== "work-execution.v2" ||
          work.parent_work_id ||
          work.binding.scope.actorID !== operator.operator_id ||
          work.work_id !== recovery.workID ||
          work.binding_hash !== recovery.bindingHash ||
          work.root_work_id !== recovery.rootWorkID ||
          command.instanceID !== installation.instanceID ||
          command.workID !== work.work_id ||
          command.rootWorkID !== work.root_work_id ||
          command.sessionID !== work.session_id ||
          command.inputID !== work.input_id ||
          command.bindingHash !== work.binding_hash ||
          command.controlRevision !== recovery.controlRevision ||
          command.revision !== request.expectedCustodyRevision ||
          tool.length !== 1 ||
          tool[0]!.receiptID !== command.providerReceiptID ||
          tool[0]!.attemptID !== command.providerAttemptID ||
          tool[0]!.toolCallID !== command.toolCallID
        )
          return yield* failure("STORAGE_CONFLICT")
        if (
          command.state !== "settled" ||
          !command.stopConfirmed ||
          command.outcome !== "exited" ||
          command.releasedAt !== null ||
          work.outcome === "unknown" ||
          !(work.outcome === "succeeded" || work.outcome === "failed" || work.control_state === "cancelled") ||
          !session ||
          session.execution_claim_token !== null
        )
          return yield* failure("STORAGE_UNKNOWN")
        const [effect] = yield* tx.all<{
          proof: string
          hash: string
          state: string
          error: string | null
          owner: string
        }>(sql`
      SELECT known_command_proof proof,outcome_hash hash,state,error_code error,owner_token owner
      FROM session_v2_tool_effect WHERE effect_id=${tool[0]!.effectID} AND session_id=${command.sessionID}
        AND receipt_id=${command.providerReceiptID} AND provider_attempt_id=${command.providerAttemptID}
        AND tool_call_id=${command.toolCallID} AND tool_name='managed_command' AND effect_kind='mutating'
        AND length(CAST(known_command_proof AS BLOB)) BETWEEN 1 AND 16384`)
        if (
          !effect ||
          effect.state !== "settled" ||
          effect.error !== null ||
          effect.owner !== command.ownerToken ||
          effect.hash !== tool[0]!.outcomeHash ||
          Hash.sha256(effect.proof) !== tool[0]!.proofHash
        )
          return yield* failure("STORAGE_UNKNOWN")
        const [table] = yield* tx.all<{ n: number }>(
          "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='work_storage_cleanup'",
        )
        if (table?.n === 1 && (yield* WorkStorageCleanup.read(tx, command.admissionID))) return
        return yield* failure("STORAGE_UNSUPPORTED")
      }),
    )
  },
  Effect.scoped,
  preserve,
)

const verifiedAsset = Effect.gen(function* () {
  if (process.platform !== "darwin" && process.platform !== "linux") return yield* failure("STORAGE_UNSUPPORTED")
  const installed = yield* NativeInstallation.current()
  const inventory = yield* NativeInstallation.inventory(installed)
  const filename = path.join(yield* NativeInstallation.assetDirectory(installed), "deepagent-work-storage-cleanup")
  const component = inventory.find(
    (item) =>
      item.path === `packages/work-file-helper/bin/${process.platform}-${process.arch}/deepagent-work-storage-cleanup`,
  )
  if (!component || component.bytes < 1 || component.bytes > 16777216) return yield* failure("STORAGE_UNAVAILABLE")
  return yield* Effect.tryPromise({
    try: async () => {
      if ((await fs.realpath(filename)) !== filename) throw failure("STORAGE_INVALID")
      const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await file.stat({ bigint: true })
        const data = await file.readFile()
        const after = await file.stat({ bigint: true })
        const named = await fs.lstat(filename, { bigint: true })
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size !== BigInt(component.bytes) ||
          (before.mode & 0o022n) !== 0n ||
          Hash.sha256(data) !== component.sha256 ||
          [before, after, named].some(
            (item) =>
              item.dev !== before.dev ||
              item.ino !== before.ino ||
              item.size !== before.size ||
              item.mtimeNs !== before.mtimeNs ||
              item.ctimeNs !== before.ctimeNs,
          )
        )
          throw failure("STORAGE_INVALID")
        return { filename, identity: `${before.dev}:${before.ino}`, hash: component.sha256 }
      } finally {
        await file.close()
      }
    },
    catch: () => failure("STORAGE_UNAVAILABLE"),
  })
})
async function privateData(directory: string) {
  const value = await fs.lstat(directory, { bigint: true })
  if (
    !value.isDirectory() ||
    value.uid !== BigInt(process.getuid!()) ||
    (value.mode & 0o022n) !== 0n ||
    (await fs.realpath(directory)) !== directory
  )
    throw failure("STORAGE_INVALID")
  return { kind: "posix" as const, device: value.dev.toString(), inode: value.ino.toString() }
}
function run<A>(
  asset: { filename: string; identity: string; hash: string },
  payload: unknown,
  schema: Schema.Decoder<A>,
) {
  return Effect.tryPromise({
    try: (signal) => invoke(asset, payload, schema, signal),
    catch: (error) => (error instanceof WorkStorageCleanupSchema.Error ? error : failure("STORAGE_UNKNOWN")),
  })
}
async function invoke<A>(
  asset: { filename: string; identity: string; hash: string },
  payload: unknown,
  schema: Schema.Decoder<A>,
  signal: AbortSignal,
) {
  const frame = Buffer.from(CanonicalJson.stringify(payload))
  if (frame.length > 262144) throw failure("STORAGE_CAPACITY")
  const actual = await fs.lstat(asset.filename, { bigint: true })
  if (
    `${actual.dev}:${actual.ino}` !== asset.identity ||
    !actual.isFile() ||
    actual.size > 16777216n ||
    Hash.sha256(await fs.readFile(asset.filename)) !== asset.hash ||
    signal.aborted
  )
    throw failure("STORAGE_INVALID")
  return await new Promise<A>((resolve, reject) => {
    const child = spawn(asset.filename, [], {
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const state = {
      bytes: 0,
      chunks: [] as Buffer[],
      stderr: 0,
      stopped: false,
      kill: undefined as ReturnType<typeof setTimeout> | undefined,
      bound: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    const stop = () => {
      state.stopped = true
      child.kill("SIGTERM")
      state.kill ??= setTimeout(() => child.kill("SIGKILL"), 500)
      state.bound ??= setTimeout(() => reject(failure("STORAGE_UNKNOWN")), 2500)
    }
    signal.addEventListener("abort", stop, { once: true })
    const timeout = setTimeout(stop, 31000)
    const kill = setTimeout(() => {
      state.stopped = true
      child.kill("SIGKILL")
    }, 31500)
    const bound = setTimeout(() => {
      state.stopped = true
      reject(failure("STORAGE_UNKNOWN"))
    }, 33500)
    child.stdout.on("data", (chunk: Buffer) => {
      state.bytes += chunk.length
      if (state.bytes > 131072) {
        stop()
        return
      }
      state.chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      state.stderr += chunk.length
      if (state.stderr > 16384) stop()
    })
    child.on("error", () => {
      state.stopped = true
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      clearTimeout(kill)
      clearTimeout(bound)
      clearTimeout(state.kill)
      clearTimeout(state.bound)
      signal.removeEventListener("abort", stop)
      frame.fill(0)
      if (state.stopped || code !== 0 || state.bytes < 1 || state.bytes > 131072) {
        reject(failure("STORAGE_UNKNOWN"))
        return
      }
      const output = Schema.decodeUnknownOption(Schema.fromJsonString(schema), { onExcessProperty: "error" })(
        Buffer.concat(state.chunks).toString("utf8"),
      )
      if (Option.isNone(output)) {
        reject(failure("STORAGE_INVALID"))
        return
      }
      resolve(output.value)
    })
    child.stdin.on("error", stop)
    child.stdin.end(frame)
  })
}
function decode<A>(schema: Schema.Decoder<A>, value: unknown) {
  const result = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  return Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(failure("STORAGE_INVALID"))
}
function diagnostic(
  stage:
    | "installation"
    | "services"
    | "authenticate_known"
    | "operator"
    | "current_facts"
    | "native_prepare"
    | "cleanup"
    | "host",
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          const cause =
            error instanceof EffectDrizzleQueryError && Cause.isCause(error.cause)
              ? Option.getOrUndefined(Cause.findErrorOption(error.cause))
              : error
          const native = cause instanceof SqlError ? cause.reason.cause : cause
          const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined
          const code = typeof native === "object" && native !== null && "code" in native ? native.code : undefined
          console.warn(
            JSON.stringify({
              service: "known-work-storage",
              stage,
              tag: typeof tag === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tag) ? tag : "UNCLASSIFIED",
              code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNCLASSIFIED",
            }),
          )
        }),
      ),
    )
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    diagnostic("host"),
    Effect.mapError((error) =>
      error instanceof WorkStorageCleanupSchema.Error ? error : failure("STORAGE_UNAVAILABLE"),
    ),
  )
}
