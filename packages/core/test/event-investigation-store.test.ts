import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { LocalOperator } from "../src/im/local-operator"
import { EventInvestigation } from "../src/deepagent/event-investigation"
import { EventInvestigationPolicy } from "../src/deepagent/event-investigation-policy"
import { EventInvestigationSchema } from "../src/deepagent/event-investigation.schema"
import { EventValidation } from "../src/deepagent/event-validation"
import { EventValidationSchema } from "../src/deepagent/event-validation.schema"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { EventValidationStoreFixture } from "./fixture/event-validation-store"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}

// This is the actual formal-migration business store oracle. Its opaque producer and route
// are controlled private fixtures; it does not claim installed Native or provider execution.
function producer() {
  const grants = new WeakMap<EventInvestigation.GrantCapture, string>()
  const failures = new WeakMap<EventInvestigation.FailureCapture, EventInvestigation.FailureEvidence>()
  return EventInvestigation.Native.of({
    approveGrant: (input) => Effect.sync(() => {
      const handle = Object.freeze({}) as EventInvestigation.GrantCapture
      grants.set(handle, EventInvestigationPolicy.hash(input))
      return handle
    }),
    approvedGrant: (capture, input) => grants.get(capture) === EventInvestigationPolicy.hash(input),
    observeFailure: (input) => Effect.sync(() => {
      const evidence = EventInvestigationPolicy.evidenceFor(input.rule, input.run)
      if (!evidence || !input.run.result) throw new Error("controlled failure is not current")
      const auditedText = CanonicalJson.stringify({ version: "event-investigation-audited.v1", failure: evidence,
        logs: { stdout: input.run.result.stdout.excerpt, stderr: input.run.result.stderr.excerpt },
        approvedRead: input.grant.target.toolPolicy.fileScope.read.map((rule) => EventInvestigation.expectedFile({ evidence }, rule.path)) })
      const handle = Object.freeze({}) as EventInvestigation.FailureCapture
      failures.set(handle, { evidence, auditedText, auditedTextHash: Hash.sha256(auditedText), auditedTextBytes: Buffer.byteLength(auditedText) })
      return handle
    }),
    failure: (capture) => failures.get(capture),
  })
}

const verifier = Layer.effect(WorkAuthority.Verifier, Effect.gen(function* () {
  const base = yield* WorkAuthority.Verifier
  return { ...base, authorizeSource: EventInvestigation.authorizeWorkSource }
})).pipe(Layer.provide(WorkAuthorityFixture.verifier))

function registerTarget(configuration: EventValidationSchema.Configuration) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
    const base = actor.policy.targets[0]!
    if (!("version" in base.target)) throw new Error("controlled project enrollment is missing")
    const target = { ...base, id: "investigation", target: { ...base.target,
      profile: { id: "event_investigate_v1" as const, version: 1 as const, hash: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE_HASH },
      budget: { ...WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget }, durationMs: 60_000,
      toolPolicy: { ...base.target.toolPolicy, capabilities: [{ toolID: "read", definitionHash: "f".repeat(64), operations: ["read" as const] }],
        commandScope: [], commandRecipes: [], integrations: [] } } }
    yield* db.transaction((tx) => LocalOperator.updatePolicyInTransaction(tx, { expectedRevision: actor.revision,
      now: Date.now(), policy: { version: 2, targets: [...actor.policy.targets, target] } }))
    yield* EventValidationStoreFixture.authorized(Effect.gen(function* () {
      yield* EventValidation.configure(db, { ruleID: "rule", requestID: "create", expectedRevision: 0, configuration })
      yield* EventValidation.control(db, { ruleID: "rule", requestID: "enable", expectedRevision: 1, action: "enable" })
    }))
  })
}

function knownFailure(configuration: EventValidationSchema.Configuration, native: ReturnType<typeof EventValidationStoreFixture.native>) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    native.state.outcome = "failed"
    const observed = yield* EventValidation.observe(db, "rule", true)
    const claimed = yield* EventValidation.claim(db, "rule", observed.observation, "owner")
    if (!claimed) throw new Error("controlled actual store claim is absent")
    yield* EventValidation.preparing(db, claimed.run.runID, "owner")
    const handle = yield* native.service.prepare(configuration, observed.observation, claimed.run.workspaceBasename, claimed.run.deadline)
    yield* EventValidation.prepared(db, claimed.run.runID, "owner", handle)
    yield* native.service.execute(handle, { beforeDispatch: EventValidation.dispatch(db, claimed.run.runID, "owner", handle).pipe(Effect.provideService(EventValidation.Native, native.service), Effect.asVoid),
      started: (pid) => EventValidation.started(db, claimed.run.runID, "owner", pid).pipe(Effect.asVoid) })
    const run = yield* EventValidation.finish(db, claimed.run.runID, "owner", handle)
    yield* native.service.cleanup(handle)
    return yield* EventValidation.released(db, run.runID, handle)
  })
}

function command(rule: EventValidationSchema.RuleRecord, actor: LocalOperator.Record,
  operation: "enable" | "disable", requestID: string): EventInvestigationSchema.GrantCommand {
  return { ruleID: rule.ruleID, requestID, operation, expectedEpoch: rule.investigationAuthority?.epoch ?? 0,
    expectedOperatorRevision: actor.revision, targetID: operation === "enable" ? "investigation" : null,
    expiresAt: operation === "enable" ? rule.configuration.expiresAt - 1_000 : null }
}

test("independent grant, immutable receipt and Work share one admission, survive cold exact retry and reject ABA", () =>
  EventValidationStoreFixture.fixture(async (f) => {
    const installed = producer()
    await f.run(EventValidationStoreFixture.authorized(registerTarget(f.configuration)).pipe(
      Effect.provideService(EventValidation.Native, f.native.service)))
    const original = await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const run = yield* knownFailure(f.configuration, f.native)
      const rule = yield* EventValidation.getRule(db, "rule")
      if (!rule) throw new Error("missing rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      const enable = command(rule, actor, "enable", "investigation-enable")
      expect(yield* EventInvestigation.candidates(db, "rule")).toMatchObject({ ruleID: "rule", ruleRevision: 2,
        operatorRevision: actor.revision, epoch: 0, targets: [{ targetID: "investigation", read: ["input.ts"],
          profile: { id: "event_investigate_v1" }, budget: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget }] })
      expect(code(yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! }).pipe(
        Effect.provideService(EventInvestigation.Native, installed), Effect.exit))).toBe("success")
      const capture = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      expect(code(yield* EventInvestigation.enableAuthority(db, enable, { ...capture }).pipe(Effect.exit))).toBe("INVESTIGATION_UNAVAILABLE")
      const enabled = yield* EventInvestigation.enableAuthority(db, enable, capture)
      expect(enabled.receipt.investigation).toEqual({ version: 1, operation: "enable", epoch: 1 })
      const unchanged = yield* EventValidation.getRule(db, "rule")
      expect(unchanged).toMatchObject({ revision: rule.revision, configHash: rule.configHash,
        contentRevision: rule.contentRevision, contentHash: rule.contentHash, currentRunID: rule.currentRunID, runCount: rule.runCount })
      expect(yield* EventInvestigation.readReconcileCandidates(db)).toEqual([{ kind: "failure", ruleID: "rule", runID: run.runID }])
      const admitted = yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: run.runID })
      expect(admitted.work.admission_state).toBe("reserved")
      expect(yield* EventInvestigation.get(db, admitted.receipt.receiptID)).toEqual(admitted.receipt)
      expect(yield* EventInvestigation.reports(db, "rule")).toEqual([{ receiptID: admitted.receipt.receiptID,
        failureKey: admitted.receipt.failureKey, runID: run.runID, contentRevision: run.contentRevision, contentHash: run.contentHash,
        sessionID: admitted.receipt.sessionID, grantEpoch: 1, createdAt: admitted.receipt.createdAt, deadline: admitted.receipt.deadline,
        work: { admissionState: "reserved", controlState: "active", controlRevision: 1, outcome: "pending" } }])
      expect(yield* db.all("SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM event_validation_investigation_receipt) receipts")).toEqual([{ sessions: 0, inputs: 0, work: 1, receipts: 1 }])
      expect((yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: run.runID })).receipt).toEqual(admitted.receipt)
      expect(yield* db.transaction((tx) => EventInvestigation.authorizeWorkSource(tx, admitted.binding))).toEqual({ authorityID: admitted.receipt.receiptID,
        revision: 1, recordHash: admitted.receipt.authorityHash })
      expect((yield* db.transaction((tx) => EventInvestigation.requireColdWake(tx, admitted.binding))).work.work_id).toBe(admitted.work.work_id)
      expect(yield* EventInvestigation.readReconcileCandidates(db)).toEqual([{ kind: "receipt", receipt: admitted.receipt }])
      return { enable, admitted, run }
    }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.provideService(EventInvestigation.Native, installed),
      Effect.provide(verifier), Effect.scoped)))
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      // Reopening this actual file connection has neither preview/capture nor Native layer.
      expect((yield* EventInvestigation.enableAuthority(db, original.enable)).replayed).toBe(true)
      expect((yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: original.run.runID })).receipt).toEqual(original.admitted.receipt)
      const rule = yield* EventValidation.getRule(db, "rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      if (!rule) throw new Error("missing cold rule")
      const disabled = yield* EventInvestigation.enableAuthority(db, command(rule, actor, "disable", "disable"))
      expect(disabled.interruptedSessionIDs).toEqual([original.admitted.receipt.sessionID])
      expect((yield* WorkAuthority.get(db, original.admitted.work.work_id))?.control_state).toBe("revoked")
      expect(yield* EventInvestigation.readRevokedSessionPage(db, { ruleID: "rule" })).toEqual({
        sessionIDs: [original.admitted.receipt.sessionID], nextReceiptID: null })
      const off = yield* EventValidation.getRule(db, "rule")
      if (!off) throw new Error("missing disabled rule")
      const reenable = command(off, actor, "enable", "reenable")
      const captured = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: reenable.expiresAt! })
      yield* EventInvestigation.enableAuthority(db, reenable, captured)
      expect((yield* EventInvestigation.enableAuthority(db, original.enable)).receipt.investigation?.epoch).toBe(1)
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority?.epoch).toBe(3)
      expect(code(yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: original.run.runID }).pipe(Effect.exit))).toBe("INVESTIGATION_SOURCE_CHANGED")
      yield* EventValidation.control(db, { ruleID: "rule", requestID: "pause", expectedRevision: 2, action: "pause" })
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority).toMatchObject({ epoch: 4, state: "disabled", grant: null })
      yield* EventValidation.control(db, { ruleID: "rule", requestID: "resume-validation", expectedRevision: 3, action: "enable" })
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority).toMatchObject({ epoch: 4, state: "disabled", grant: null })
      expect(yield* db.all("SELECT count(*) count FROM event_validation_investigation_receipt")).toEqual([{ count: 1 }])
      expect(yield* db.all("SELECT count(*) count FROM work_execution")).toEqual([{ count: 1 }])
      expect(yield* EventInvestigation.readReconcileCandidates(db)).toEqual([])
      expect(yield* db.all("SELECT count(*) count FROM session_provider_attempt")).toEqual([{ count: 0 }])
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.provideService(EventInvestigation.Native, installed), Effect.provide(verifier))))
  }))

test("cold release-before-hook gap reads one current failure, requires Native first admission, then excludes touched Work", () =>
  EventValidationStoreFixture.fixture(async (f) => {
    const installed = producer()
    await f.run(EventValidationStoreFixture.authorized(registerTarget(f.configuration)).pipe(Effect.provideService(EventValidation.Native, f.native.service)))
    const failed = await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const run = yield* knownFailure(f.configuration, f.native)
      const rule = yield* EventValidation.getRule(db, "rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      if (!rule) throw new Error("missing current failure")
      const enable = command(rule, actor, "enable", "grant")
      const capture = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      yield* EventInvestigation.enableAuthority(db, enable, capture)
      return run
    }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.provideService(EventInvestigation.Native, installed), Effect.scoped)))
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      // Actual reopened connection, with no receipt, capture, Native or model service.
      expect(yield* EventInvestigation.readReconcileCandidates(db)).toEqual([{ kind: "failure", ruleID: "rule", runID: failed.runID }])
      expect(code(yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: failed.runID }).pipe(Effect.exit))).toBe("INVESTIGATION_UNAVAILABLE")
      expect(yield* db.all("SELECT count(*) count FROM event_validation_investigation_receipt")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM work_execution")).toEqual([{ count: 0 }])
    })))
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const admitted = yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: failed.runID })
      expect((yield* EventInvestigation.readReconcileCandidates(db))[0]?.kind).toBe("receipt")
      yield* WorkAuthorityFixture.materialize(admitted.binding, { text: admitted.receipt.auditedText })
      expect(yield* EventInvestigation.readReconcileCandidates(db)).toEqual([])
      expect(code(yield* db.transaction((tx) => EventInvestigation.requireColdWake(tx, admitted.binding)).pipe(Effect.exit))).toBe("INVESTIGATION_RECOVERY_REQUIRED")
      expect(yield* db.all("SELECT count(*) count FROM work_count_acquisition")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
    }).pipe(Effect.provideService(EventInvestigation.Native, installed), Effect.provide(verifier))))
  }))

test("content change revokes only the original Work; unknown project lineage prevents a successor reserve", () =>
  EventValidationStoreFixture.fixture(async (f) => {
    const installed = producer()
    await f.run(EventValidationStoreFixture.authorized(registerTarget(f.configuration)).pipe(Effect.provideService(EventValidation.Native, f.native.service)))
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const first = yield* knownFailure(f.configuration, f.native)
      const rule = yield* EventValidation.getRule(db, "rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      if (!rule) throw new Error("missing first failure")
      const enable = command(rule, actor, "enable", "grant")
      const capture = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      yield* EventInvestigation.enableAuthority(db, enable, capture)
      const original = yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: first.runID })
      f.native.state.content = "second"
      const second = yield* knownFailure(f.configuration, f.native)
      expect((yield* WorkAuthority.get(db, original.work.work_id))?.control_state).toBe("revoked")
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority?.epoch).toBe(1)
      const successor = yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: second.runID })
      expect(successor.work.work_id).not.toBe(original.work.work_id)
      expect(yield* EventInvestigation.sourceChanged(db, original.binding, 1)).toEqual([])
      expect((yield* WorkAuthority.get(db, successor.work.work_id))?.control_state).toBe("active")
      // Actual durable unknown projection tests this cross-root source admission barrier;
      // it is deliberately not presented as a real provider dispatch or Native proof.
      yield* db.run(sql`UPDATE work_execution SET outcome='unknown' WHERE work_id=${original.work.work_id}`)
      f.native.state.content = "third"
      const third = yield* knownFailure(f.configuration, f.native)
      expect(code(yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: third.runID }).pipe(Effect.exit))).toBe("INVESTIGATION_RECOVERY_REQUIRED")
      expect(yield* db.all("SELECT count(*) count FROM event_validation_investigation_receipt")).toEqual([{ count: 2 }])
      expect(yield* db.all("SELECT count(*) count FROM work_execution")).toEqual([{ count: 2 }])
      expect(yield* db.all("SELECT count(*) count FROM session_input")).toEqual([{ count: 0 }])
    }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.provideService(EventInvestigation.Native, installed),
      Effect.provide(verifier), Effect.scoped)))
  }))

test("unavailable final route rolls the immutable business receipt and Work reserve back together", () =>
  EventValidationStoreFixture.fixture(async (f) => {
    const installed = producer()
    await f.run(EventValidationStoreFixture.authorized(registerTarget(f.configuration)).pipe(
      Effect.provideService(EventValidation.Native, f.native.service)))
    const denyRoute = Layer.succeed(WorkAuthority.Verifier, { authorizeSource: EventInvestigation.authorizeWorkSource,
      resolveRoute: () => Effect.fail(new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "controlled final route unavailable" })) })
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const run = yield* knownFailure(f.configuration, f.native)
      const rule = yield* EventValidation.getRule(db, "rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      if (!rule) throw new Error("missing rule")
      const enable = command(rule, actor, "enable", "enable-investigation")
      const captured = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      yield* EventInvestigation.enableAuthority(db, enable, captured)
      expect(code(yield* EventInvestigation.acceptFailureAndReserve(db, { ruleID: "rule", runID: run.runID }).pipe(Effect.exit))).toBe("INVESTIGATION_UNAVAILABLE")
      expect(yield* db.all("SELECT count(*) count FROM event_validation_investigation_receipt")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM work_execution")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM session_input")).toEqual([{ count: 0 }])
    }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.provideService(EventInvestigation.Native, installed),
      Effect.provide(denyRoute), Effect.scoped)))
  }))

test("late command rollback preserves the original capture for exact successful retry and fences its old epoch", () =>
  EventValidationStoreFixture.fixture(async (f) => {
    const installed = producer()
    await f.run(EventValidationStoreFixture.authorized(registerTarget(f.configuration)).pipe(Effect.provideService(EventValidation.Native, f.native.service)))
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const rule = yield* EventValidation.getRule(db, "rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      if (!rule) throw new Error("missing rule")
      const enable = command(rule, actor, "enable", "late-enable")
      const capture = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      // Connection-local fault after the real Rule CAS, without changing formal migration SQL.
      yield* db.run("CREATE TEMP TRIGGER reject_investigation_command BEFORE INSERT ON event_validation_command WHEN NEW.request_id='late-enable' BEGIN SELECT RAISE(ABORT,'controlled_late_command'); END")
      expect(code(yield* EventInvestigation.enableAuthority(db, enable, capture).pipe(Effect.exit))).toBe("INVESTIGATION_UNAVAILABLE")
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority).toBeUndefined()
      expect(yield* db.all("SELECT count(*) count FROM event_validation_command WHERE request_id='late-enable'")).toEqual([{ count: 0 }])
      yield* db.run("DROP TRIGGER reject_investigation_command")
      expect((yield* EventInvestigation.enableAuthority(db, enable, capture)).receipt.investigation?.epoch).toBe(1)
      expect((yield* EventInvestigation.enableAuthority(db, enable, capture)).replayed).toBe(true)
      const enabled = yield* EventValidation.getRule(db, "rule")
      if (!enabled) throw new Error("missing enabled rule")
      const oldEpochCapture = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      yield* EventInvestigation.enableAuthority(db, command(enabled, actor, "disable", "disable"))
      const off = yield* EventValidation.getRule(db, "rule")
      if (!off) throw new Error("missing disabled rule")
      const next = command(off, actor, "enable", "attempt-next-epoch")
      expect(code(yield* EventInvestigation.enableAuthority(db, next, oldEpochCapture).pipe(Effect.exit))).toBe("INVESTIGATION_UNAVAILABLE")
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority).toMatchObject({ epoch: 2, state: "disabled", grant: null })
      expect(yield* db.all("SELECT count(*) count FROM event_validation_command WHERE request_id='attempt-next-epoch'")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM work_execution")).toEqual([{ count: 0 }])
    }).pipe(Effect.provideService(EventInvestigation.Native, installed))))
  }))

test("a captured operator and policy tuple cannot be replaced by newer command parameters", () =>
  EventValidationStoreFixture.fixture(async (f) => {
    const installed = producer()
    await f.run(EventValidationStoreFixture.authorized(registerTarget(f.configuration)).pipe(Effect.provideService(EventValidation.Native, f.native.service)))
    await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const rule = yield* EventValidation.getRule(db, "rule")
      const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      if (!rule) throw new Error("missing rule")
      const enable = command(rule, actor, "enable", "old-principal")
      const captured = yield* EventInvestigation.captureGrant(db, { ruleID: "rule", targetID: "investigation", expiresAt: enable.expiresAt! })
      yield* db.transaction((tx) => LocalOperator.updatePolicyInTransaction(tx, { expectedRevision: actor.revision,
        now: Date.now(), policy: actor.policy }))
      const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      const shifted = { ...enable, expectedOperatorRevision: current.revision }
      const attempt = EventInvestigation.enableAuthority(db, shifted, captured).pipe(
        Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))
      expect(code(yield* attempt.pipe(Effect.exit))).toBe("INVESTIGATION_UNAVAILABLE")
      expect((yield* EventValidation.getRule(db, "rule"))?.investigationAuthority).toBeUndefined()
      expect(yield* db.all("SELECT count(*) count FROM event_validation_command WHERE request_id='old-principal'")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM work_execution")).toEqual([{ count: 0 }])
    }).pipe(Effect.provideService(EventInvestigation.Native, installed))))
  }))
