// The signed debug entrypoint uses the production Root and actual HTTP mutation witnesses.
// Faults are actual source writes, HTTP pause, and an external SIGKILL of this process.
import { Cause, Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { EventV2 } from "@deepagent-code/core/event"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventInvestigation } from "@deepagent-code/core/deepagent/event-investigation"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { EventInvestigationHost } from "@/deepagent/event-investigation"
import { EventValidationNative } from "@/installation/event-validation-native"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppRuntime } from "@/effect/app-runtime"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { ServerAuth } from "@/server/auth"
import { Server } from "@/server/server"
import { InvestigationCaptured } from "@/server/routes/instance/httpapi/groups/event-investigation"
import { cmd } from "@/cli/cmd/cmd"

const ruleID = "actual-investigate-fault-rule"

export const DebugCommand = cmd({ command: "debug", handler: async () => {
  const output = process.env.DAC_EVENT_NATIVE_RESULT
  const mode = process.env.DAC_EVENT_FAULT_MODE
  if (!output || !["pause", "changed", "identity", "ready-leaf", "cold-hold", "cold-check"].includes(mode ?? ""))
    throw new Error("A private fault mode and result file are required")
  const progress: Record<string, unknown> = { mode, stage: "root" }
  const outcome = await AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const config = yield* ServerAuth.Config
    const configured = yield* LocalTaskAuthority.configured(config)
    yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, config.username, configured.password)
    const execution = yield* SessionExecution.Service
    const investigation = yield* EventInvestigationHost.Service
    const listener = yield* Effect.acquireRelease(
      Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: Number(process.env.DAC_EVENT_NATIVE_HTTP_PORT) })),
      (listener) => Effect.promise(() => listener.stop(true)),
    )
    const request = (route: string, body: unknown) => Effect.tryPromise({
      try: async () => {
        const response = await fetch(new URL(route, listener.url), { method: "POST", headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${config.username}:${configured.password}`).toString("base64")}`,
        }, body: JSON.stringify(body) })
        const value: unknown = await response.json()
        if (response.status !== 200) throw new Error(`Actual HTTP ${route}: ${response.status} ${JSON.stringify(value)}`)
        return value
      }, catch: (error) => error instanceof Error ? error : new Error("Actual fault HTTP request failed"),
    })
    const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx)).pipe(
      Effect.provideService(LocalOperator.Runtime, configured.runtime))
    if (mode === "cold-check") {
      progress.before = yield* census(db)
      // A cold Root does not replay a touched input. If the old provider lease
      // is still live at startup, its dispatched custody remains unconfirmed;
      // only an actual fenced classification may change it to unknown.
      yield* investigation.reconcile
      yield* Effect.sleep(500)
      progress.cold = yield* census(db)
      const retained = yield* db.get<{ state: string; reserved_total_tokens: number; charged_tokens: number }>(
        "SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation")
      if (!retained || !["dispatching", "unknown"].includes(retained.state) ||
        retained.reserved_total_tokens !== 4137 || retained.charged_tokens !== 4137)
        throw new Error("Cold Root must retain the actual dispatched reservation")
      progress.coldClassification = retained.state === "unknown" ? "unknown" : "unconfirmed_dispatching"
      const original = yield* EventValidation.getRule(db, ruleID)
      if (!original || original.configuration.maxRuns < 2 || original.investigationAuthority?.state !== "enabled" ||
        original.investigationAuthority.grant.expiresAt <= Date.now()) throw new Error("Cold barrier needs a live grant and unused native run")
      progress.originalRule = original
      const filename = path.join(original.configuration.scope.canonicalRoot, "guard.test.ts")
      yield* Effect.promise(() => fs.appendFile(filename, "\n// EXPECT_COLD_SUCCESSOR_NATIVE_VERSION\n"))
      const deadline = Date.now() + 45_000
      const successor = { run: undefined as EventValidationSchema.RunRecord | undefined }
      while (Date.now() < deadline) {
        const rule = yield* EventValidation.getRule(db, ruleID)
        const run = rule?.currentRunID ? yield* EventValidation.getRun(db, rule.currentRunID) : undefined
        if (run && run.contentRevision > original.contentRevision && run.state === "settled" && run.outcome === "failed" &&
          run.resultCurrent && run.releasedAt !== null && run.retainedBytes === 0 && run.result?.stopConfirmed &&
          run.result.stdout.complete && run.result.stderr.complete) { successor.run = run; break }
        yield* Effect.sleep(50)
      }
      if (!successor.run) throw new Error("The actual successor native failure did not settle and release")
      progress.successor = successor.run
      const current = yield* EventValidation.getRule(db, ruleID)
      if (current?.investigationAuthority?.state !== "enabled" || current.investigationAuthority.epoch !== 1 ||
        current.investigationAuthority.grant.expiresAt <= Date.now() || current.configuration.maxRuns !== 2)
        throw new Error("The successor barrier must be tested with a live original grant")
      const refused = yield* investigation.accept({ ruleID, runID: successor.run.runID }).pipe(Effect.exit)
      progress.successorAdmission = Exit.isFailure(refused) && Cause.squash(refused.cause) instanceof EventInvestigationSchema.Error
        ? (Cause.squash(refused.cause) as EventInvestigationSchema.Error).code : Exit.isSuccess(refused) ? "success" : Cause.pretty(refused.cause)
    }
    if (mode !== "cold-check") {
      const target = operator.policy.targets.find((entry) => entry.id === "validation")
      if (!target || !("version" in target.target) || !target.target.toolPolicy.commandRecipes?.[0])
        throw new Error("Actual enrolled validation target is unavailable")
      const configuration = Schema.decodeUnknownSync(EventValidationSchema.Configuration)({
        profile: "project_validation_v1", scope: { instanceID: operator.instance_id, workspaceID: null,
          securityNamespaceID: target.target.scope.securityNamespaceID, namespaceBindingHash: target.namespaceBindingHash,
          locationKey: target.locationKey, projectScopeKey: target.target.scope.projectScopeKey,
          projectID: target.target.projectScope.projectID, canonicalRoot: target.target.location.directory,
          rootIdentity: target.target.projectScope.rootIdentity }, kind: "test", recipe: target.target.toolPolicy.commandRecipes[0],
        parameters: [], helperHash: target.target.projectScope.helperHash, watch: ["guard.test.ts"], recipient: "local_status",
        maxRuns: ["changed", "identity", "ready-leaf"].includes(mode ?? "") ? 1 : 2,
        expiresAt: Date.now() + 360_000, investigation: "disabled", autoFix: false,
      })
      progress.stage = "configure"
      yield* request("/api/v1/event-validation/rules/configure", { ruleID, requestID: "configure-once", expectedRevision: 0, configuration })
      const expiresAt = Date.now() + 240_000
      const grant = { ruleID, requestID: "grant-once", operation: "enable", expectedEpoch: 0,
        expectedOperatorRevision: operator.revision, targetID: "investigation", expiresAt }
      if (mode !== "ready-leaf") {
        const capture = yield* Schema.decodeUnknownEffect(InvestigationCaptured)(yield* request("/api/v1/event-investigation/capture",
          { ruleID, targetID: "investigation", expiresAt }))
        yield* request("/api/v1/event-investigation/control", { ...grant, captureID: capture.captureID })
      }
      progress.before = yield* census(db)
      progress.stage = "validation-enable"
      yield* request(`/api/v1/event-validation/rules/${ruleID}/control`, { requestID: "enable-once", expectedRevision: 1, action: "enable" })
      if (mode === "ready-leaf") {
        progress.stage = "known-failure-without-grant"
        const deadline = Date.now() + 45_000
        const failed = { run: undefined as EventValidationSchema.RunRecord | undefined }
        while (Date.now() < deadline) {
          const rule = yield* EventValidation.getRule(db, ruleID)
          const run = rule?.currentRunID ? yield* EventValidation.getRun(db, rule.currentRunID) : undefined
          if (run?.state === "settled" && run.outcome === "failed" && run.resultCurrent && run.releasedAt !== null &&
            run.retainedBytes === 0 && run.result?.stopConfirmed && run.result.stdout.complete && run.result.stderr.complete) {
            failed.run = run; break
          }
          yield* Effect.sleep(25)
        }
        if (!failed.run) throw new Error("The actual failure did not clean up before grant admission")
        yield* Effect.sleep(250)
        if (yield* db.get("SELECT receipt_id FROM event_validation_investigation_receipt LIMIT 1"))
          throw new Error("A failure without a grant must not admit investigation Work")
        const capture = yield* Schema.decodeUnknownEffect(InvestigationCaptured)(yield* request("/api/v1/event-investigation/capture",
          { ruleID, targetID: "investigation", expiresAt }))
        yield* request("/api/v1/event-investigation/control", { ...grant, captureID: capture.captureID })
        const installed = yield* WorkExecutionProfile.Services
        const events = yield* EventV2Bridge.Service
        if (!installed.files) throw new Error("The original installed file capability is unavailable")
        const reserved = yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID, runID: failed.run.runID }).pipe(
          Effect.provideService(EventInvestigation.Native, investigation.native),
          Effect.provideService(WorkAuthority.Verifier, installed.verifier),
          Effect.provideService(LocalOperator.Runtime, configured.runtime))
        yield* WorkAdmission.admitOnly({ binding: reserved.binding, auditedText: reserved.receipt.auditedText }).pipe(
          Effect.provideService(WorkAuthority.Verifier, installed.verifier), Effect.provideService(EventV2.Service, events))
        progress.ready = yield* census(db)
        progress.originalManifest = reserved.receipt.evidence.content.files[0]
        const original = yield* EventValidation.getRule(db, ruleID)
        if (!original) throw new Error("The ready Work's original Rule is unavailable")
        progress.originalRule = original
        const root = yield* installed.files.open({ binding: reserved.binding, controlRevision: reserved.work.control_revision })
        const filename = path.join(configuration.scope.canonicalRoot, "guard.test.ts")
        const physical = yield* Effect.promise(async () => {
          const before = await fs.stat(filename, { bigint: true })
          const bytes = await fs.readFile(filename)
          const expected = reserved.receipt.evidence.content.files[0]!
          if (expected.identity?.kind !== "posix" || expected.identity.device !== String(before.dev) ||
            expected.identity.inode !== String(before.ino) || expected.sha256 !== Bun.CryptoHasher.hash("sha256", bytes, "hex"))
            throw new Error("The ready Work manifest differs from the original physical file")
          const replacement = path.join(configuration.scope.canonicalRoot, "identity-replacement.tmp")
          await fs.writeFile(replacement, bytes, { mode: 0o600 })
          await fs.rename(replacement, filename)
          const after = await fs.stat(filename, { bigint: true })
          if (before.ino === after.ino || !bytes.equals(await fs.readFile(filename)))
            throw new Error("The ready leaf replacement did not preserve bytes with a new inode")
          return { before: { device: String(before.dev), inode: String(before.ino) },
            after: { device: String(after.dev), inode: String(after.ino) },
            sha256: expected.sha256, bytes: bytes.byteLength, sameBytes: true }
        })
        progress.physicalIdentity = physical
        const observed = yield* EventValidation.observe(db, ruleID).pipe(Effect.provide(EventValidationNative.layer),
          Effect.provide(Global.layer), Effect.provideService(LocalOperator.Runtime, configured.runtime), Effect.scoped)
        if (observed.changed || observed.rule.revision !== original.revision || observed.rule.contentRevision !== original.contentRevision ||
          observed.rule.contentHash !== original.contentHash || observed.rule.investigationAuthority?.epoch !== original.investigationAuthority?.epoch)
          throw new Error("The Rule changed before the original ready read wrapper")
        progress.identityObserved = { changed: observed.changed, rule: observed.rule }
        progress.stage = "physical-ready-read"
        const read = yield* installed.files.read(root, { relative: "guard.test.ts", offset: 0, bytes: 51200, scanLimit: 16777216 }).pipe(Effect.exit)
        const error = Exit.isFailure(read) ? Cause.squash(read.cause) : undefined
        progress.readRefusal = error instanceof WorkFileCapability.Error ? { code: error.code, message: error.message } :
          { code: Exit.isSuccess(read) ? "unexpected_success" : "unclassified_failure" }
        if (!(error instanceof WorkFileCapability.Error) || error.code !== "WORK_FILE_CHANGED" || error.message !== "Native read differs from the failed version")
          throw new Error("The original ready wrapper did not return the exact physical manifest refusal")
      }
      if (mode === "identity") {
        const manifestReady = process.env.DAC_EVENT_FAULT_MANIFEST_READY
        const identityReady = process.env.DAC_EVENT_FAULT_IDENTITY_READY
        const observedReady = process.env.DAC_EVENT_FAULT_OBSERVED_READY
        if (!manifestReady || !identityReady || !observedReady) throw new Error("Private identity witnesses are required")
        progress.stage = "freeze-original-manifest"
        const deadline = Date.now() + 45_000
        const frozen = { receipt: undefined as EventInvestigationSchema.Receipt | undefined }
        while (Date.now() < deadline) {
          const row = yield* db.get<{ receipt_id: string }>("SELECT receipt_id FROM event_validation_investigation_receipt")
          if (row) { frozen.receipt = yield* EventInvestigation.get(db, row.receipt_id); break }
          yield* Effect.sleep(25)
        }
        if (!frozen.receipt) throw new Error("The actual original investigation manifest was not admitted")
        progress.originalManifest = frozen.receipt.evidence.content.files[0]
        const original = yield* EventValidation.getRule(db, ruleID)
        if (!original) throw new Error("The original current Rule is unavailable")
        progress.originalRule = original
        yield* Effect.promise(() => fs.writeFile(manifestReady, JSON.stringify(progress.originalManifest), { mode: 0o600 }))
        while (Date.now() < deadline && !(yield* Effect.promise(() => Bun.file(identityReady).exists()))) yield* Effect.sleep(25)
        if (!(yield* Effect.promise(() => Bun.file(identityReady).exists()))) throw new Error("The physical same-byte replacement was not witnessed")
        progress.stage = "identity-reobserve"
        const observed = yield* EventValidation.observe(db, ruleID).pipe(
          Effect.provide(EventValidationNative.layer), Effect.provide(Global.layer),
          Effect.provideService(LocalOperator.Runtime, configured.runtime), Effect.scoped)
        if (observed.changed || observed.rule.revision !== original.revision || observed.rule.contentRevision !== original.contentRevision ||
          observed.rule.contentHash !== original.contentHash || observed.rule.investigationAuthority?.epoch !== original.investigationAuthority?.epoch)
          throw new Error("Identity-only replacement changed the Rule before the read leaf")
        progress.identityObserved = { changed: observed.changed, rule: observed.rule }
        yield* Effect.promise(() => fs.writeFile(observedReady, "actual unchanged native observation", { mode: 0o600 }))
        progress.stage = "wait-identity-leaf"
        yield* waitFor(db, execution, "revoked")
      }
      if (mode === "pause" || mode === "cold-hold") {
        progress.stage = "wait-streaming"
        yield* waitFor(db, execution, "streaming")
        progress.streaming = yield* census(db)
        if (mode === "cold-hold") {
          if (!process.env.DAC_EVENT_FAULT_READY) throw new Error("A private cold readiness file is required")
          progress.stage = "streaming-ready"
          yield* Effect.promise(() => fs.writeFile(process.env.DAC_EVENT_FAULT_READY!, JSON.stringify(progress), { mode: 0o600 }))
          yield* Effect.never
        }
        const current = yield* EventValidation.getRule(db, ruleID)
        if (!current) throw new Error("Current native Rule is missing")
        progress.stage = "pause"
        yield* request(`/api/v1/event-validation/rules/${ruleID}/control`, { requestID: "pause-once",
          expectedRevision: current.revision, action: "pause" })
        yield* waitFor(db, execution, "revoked")
        progress.paused = yield* EventValidation.getRule(db, ruleID)
        const paused = yield* EventValidation.getRule(db, ruleID)
        if (!paused) throw new Error("Paused Rule is missing")
        progress.stage = "reenable"
        yield* request(`/api/v1/event-validation/rules/${ruleID}/control`, { requestID: "reenable-once",
          expectedRevision: paused.revision, action: "enable" })
        const reenabled = yield* EventValidation.getRule(db, ruleID)
        if (!reenabled?.investigationAuthority) throw new Error("Current independent authority is missing")
        yield* request("/api/v1/event-investigation/control", { ruleID, requestID: "disable-once", operation: "disable",
          expectedEpoch: reenabled.investigationAuthority.epoch, expectedOperatorRevision: operator.revision,
          targetID: null, expiresAt: null, captureID: null })
        progress.replayed = yield* request("/api/v1/event-investigation/control", { ...grant, captureID: null })
        // A remaining native run is allowed after re-enable. Wait for real custody to
        // settle; disabled investigation authority must prevent any new model work.
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          const busy = yield* db.get("SELECT run_id FROM event_validation_run WHERE state IN ('queued','preparing','dispatching') LIMIT 1")
          const rule = yield* EventValidation.getRule(db, ruleID)
          if (!busy && rule?.dueAt === null) break
          yield* Effect.sleep(50)
        }
        if (yield* db.get("SELECT run_id FROM event_validation_run WHERE retained_bytes<>0 OR state IN ('queued','preparing','dispatching') LIMIT 1"))
          throw new Error("Re-enabled deterministic consumer has not released its actual custody")
      }
      if (mode === "changed") {
        progress.stage = "wait-changed"
        yield* waitFor(db, execution, "revoked")
        // The native leaf may revoke before the filesystem hint is observed. Require
        // the actual watcher projection too, without attributing either race winner.
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          const rule = yield* EventValidation.getRule(db, ruleID)
          const receipt = yield* db.get<{ content_revision: number }>("SELECT content_revision FROM event_validation_investigation_receipt")
          if (rule && receipt && rule.contentRevision > receipt.content_revision) break
          yield* Effect.sleep(50)
        }
      }
    }
    progress.after = yield* census(db)
    progress.rule = yield* EventValidation.getRule(db, ruleID)
    progress.runs = yield* EventValidation.history(db, ruleID)
    const receipt = yield* db.get<{ receipt_id: string }>("SELECT receipt_id FROM event_validation_investigation_receipt")
    if (receipt) progress.receipt = yield* EventInvestigation.get(db, receipt.receipt_id)
    progress.activeSessions = [...(yield* execution.active)]
    progress.stage = "observed"
  }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit))
  if (Exit.isFailure(outcome)) { progress.error = Cause.pretty(outcome.cause); process.exitCode = 1 }
  await fs.writeFile(output, JSON.stringify(progress, null, 2), { mode: 0o600 })
  await AppRuntime.dispose()
} })

function waitFor(db: Database.Interface["db"], execution: SessionExecution.Interface,
  state: "streaming" | "revoked") {
  return Effect.gen(function* () {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const work = yield* db.get<{ control_state: string; outcome: string }>("SELECT control_state,outcome FROM work_execution")
      const provider = yield* db.get<{ state: string }>("SELECT state FROM session_v2_provider_turn_receipt ORDER BY created_at DESC LIMIT 1")
      const dispatch = yield* db.get<{ state: string }>("SELECT state FROM work_dispatch_reservation")
      if (state === "streaming" && provider?.state === "streaming" && dispatch?.state === "dispatching") return
      if (state === "revoked" && work?.control_state === "revoked" && (yield* execution.active).size === 0) return
      yield* Effect.sleep(50)
    }
    throw new Error(`Actual ${state} boundary was not reached`)
  })
}

function census(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    return {
      receipts: yield* db.all("SELECT receipt_id,work_id,session_id,input_id,record_hash FROM event_validation_investigation_receipt"),
      work: yield* db.all("SELECT work_id,admission_state,control_state,control_revision,outcome FROM work_execution"),
      sessions: yield* db.all("SELECT id,execution_claim_token FROM session"),
      inputs: yield* db.all("SELECT id,session_id,promoted_seq FROM session_input"),
      counts: yield* db.all("SELECT state,record FROM work_count_acquisition"),
      dispatches: yield* db.all("SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation"),
      providers: yield* db.all("SELECT state,outcome_hash,error_code FROM session_v2_provider_turn_receipt"),
      tools: yield* db.all("SELECT state,effect_kind,known_read_proof,error_code FROM session_v2_tool_effect"),
      admissions: yield* db.all("SELECT admission_id,tool_name,effect_kind FROM session_v2_tool_effect_admission"),
    }
  })
}
