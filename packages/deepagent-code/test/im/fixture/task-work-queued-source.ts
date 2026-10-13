import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalTaskAuth } from "@deepagent-code/core/im/local-task-auth"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { EventV2Bridge } from "@/event-v2-bridge"
import { IMTaskWorkAdmission } from "@/im/task-work-admission"
import { KernelTaskSourceAuthorityFixture } from "./kernel-task-source-authority"

const root = process.env.DAC_TASK_WORK_QUEUED_SOURCE_ROOT
if (!root) throw new Error("Private queued-source fixture root is required")
const expiry = process.env.DAC_TASK_WORK_QUEUED_EXPIRY === "1"

await KernelTaskSourceAuthorityFixture.run(root, (input) => Effect.gen(function* () {
  const verification = { assertions: 0 }
  const checked = {
    equal: (...args: Parameters<typeof assert.equal>) => { verification.assertions++; assert.equal(...args) },
    deepEqual: (...args: Parameters<typeof assert.deepEqual>) => { verification.assertions++; assert.deepEqual(...args) },
  }
  const order: string[] = []
  const wakes: string[] = []
  const changes = { control: false }
  const unused = () => Effect.die("Queued-source module must not execute a provider or admit another task")
  const source = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(LocalOperator.Runtime, input.runtime),
    Effect.provideService(LocalTaskAuth.KernelSource, input.resolver.verifier),
  )
  // The route port is controlled here. Source/current/grant/placement/Work checks use
  // the actual enrolled stores and SDK handle; this is not a Native/provider acceptance.
  const installed: WorkExecutionProfile.Installed = {
    profile: {
      observe: unused, bind: unused, current: unused, acquireCount: unused,
      prepareSource: (work) => Effect.gen(function* () {
        checked.equal(work.work_id, input.grant.work_id)
        order.push("prepare")
        // BEGIN would fail inside the consuming transaction. No business row changes.
        yield* input.db.run("BEGIN IMMEDIATE").pipe(Effect.orDie)
        yield* input.db.run("ROLLBACK").pipe(Effect.orDie)
        yield* input.resolver.prepareWork(work).pipe(Effect.mapError(() => new WorkAuthoritySchema.Error({
          code: "WORK_REVOKED", message: "Current original source capture is unavailable",
        })))
        if (changes.control) yield* input.db.run(sql`UPDATE work_execution
          SET control_state='revoked',control_revision=control_revision+1 WHERE work_id=${work.work_id}`).pipe(Effect.orDie)
      }),
      preflight: (work) => Effect.gen(function* () {
        order.push("preflight")
        yield* WorkExecutionProfile.requirePlacement(input.db, work)
        yield* input.db.transaction((tx) => installed.verifier.authorizeSource(tx, work.binding)).pipe(
          Effect.catchTag("SqlError", Effect.die),
        )
      }),
    },
    verifier: {
      authorizeSource: (tx, binding) => source(IMTaskAuthority.authorizeWorkSource(tx, binding)),
      resolveRoute: (_tx, binding) => Effect.succeed({ evidenceID: binding.provider.evidenceID,
        evidenceHash: binding.provider.evidenceHash, configurationHash: binding.provider.configurationHash }),
    },
    evidence: { resolve: unused, readCount: unused },
    approval: { captured: unused, authenticate: unused, verify: unused },
    count: { requireCapture: unused, authenticate: unused, verify: unused },
  }
  yield* input.resolver.prepareMessage({ messageID: input.messageID })
  const reserved = yield* WorkAuthority.reserve(input.db, { binding: input.grant.binding }).pipe(
    Effect.provideService(WorkAuthority.Verifier, installed.verifier),
  )
  const created = Date.now()
  yield* input.db.run(sql`INSERT OR IGNORE INTO project(id,worktree,sandboxes,time_created,time_updated)
    VALUES (${input.projectID},${reserved.binding.location.directory},'[]',${created},${created})`)
  yield* input.db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,agent,model,time_created,time_updated)
    VALUES (${reserved.session_id},${input.projectID},'queued-source',${reserved.binding.location.directory},'Queued source','2',1,
      ${reserved.binding.agentID},${JSON.stringify({ id: reserved.binding.provider.modelID, providerID: reserved.binding.provider.providerID })},${created},${created})`)
  yield* input.resolver.prepareMessage({ messageID: input.messageID })
  yield* input.db.transaction((tx) => Effect.gen(function* () {
    yield* tx.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,time_created)
      VALUES (${reserved.input_id},${reserved.session_id},${JSON.stringify({ text: input.request.audited_text })},'queue',1,${created})`)
    yield* WorkAuthority.bindInputInTransaction(tx, { workID: reserved.work_id, inputID: reserved.input_id,
      sessionID: reserved.session_id, promptHash: reserved.binding.auditedText.hash, admittedSeq: 1, expectedRevision: 1 })
  }), { behavior: "immediate" }).pipe(Effect.provideService(WorkAuthority.Verifier, installed.verifier))
  const originalProof = yield* input.db.all("SELECT proof,proof_hash,snapshot,snapshot_hash FROM im_task_source")
  const tasks = yield* IMTaskWorkAdmission.make.pipe(
    Effect.provideService(Database.Service, { db: input.db }),
    Effect.provide(WorkExecutionProfile.servicesLayer(installed)),
    Effect.provide(Layer.mock(SessionV2.Service, {})),
    Effect.provide(Layer.mock(EventV2Bridge.Service, {})),
    Effect.provide(Layer.mock(SessionExecution.Service, {
      wake: (sessionID) => Effect.sync(() => { order.push("wake"); wakes.push(sessionID) }),
    })),
  )
  const current = (yield* WorkAuthority.get(input.db, reserved.work_id))!
  const cutCount = () => input.native.queries.filter((query) => query.topic === "qry_delivery_read_cut").length
  if (expiry) {
    checked.equal(current.binding.deadline > Date.now(), true)
    yield* tasks.reconcileQueued
    checked.deepEqual(order, ["prepare", "preflight", "wake"])
    checked.deepEqual(wakes, [reserved.session_id])
    const before = cutCount()
    const original = yield* input.db.all("SELECT state,expires_at,binding FROM im_task_grant")
    const workRows = yield* input.db.all("SELECT admission_state,control_state,control_revision,outcome,binding FROM work_execution")
    yield* Effect.sleep(Math.max(0, current.binding.deadline - Date.now()) + 20)
    checked.equal(current.binding.deadline <= Date.now(), true)
    order.length = 0
    yield* tasks.reconcileQueued
    checked.deepEqual(order, [])
    checked.equal(wakes.length, 1)
    checked.equal(cutCount(), before)
    checked.deepEqual(yield* input.db.all("SELECT state,expires_at,binding FROM im_task_grant"), original)
    checked.deepEqual(yield* input.db.all("SELECT admission_state,control_state,control_revision,outcome,binding FROM work_execution"), workRows)
    checked.deepEqual(yield* input.db.all("SELECT proof,proof_hash,snapshot,snapshot_hash FROM im_task_source"), originalProof)
    const counts = (yield* input.db.get<{ providers: number; counts: number; dispatches: number; activities: number }>(sql`
      SELECT (SELECT count(*) FROM session_provider_attempt) providers,
        (SELECT count(*) FROM work_count_acquisition) counts,
        (SELECT count(*) FROM work_dispatch_reservation) dispatches,
        (SELECT count(*) FROM session_activity) activities`))!
    checked.deepEqual(counts, { providers: 0, counts: 0, dispatches: 0, activities: 0 })
    return { ...counts, actualDeadlineElapsed: true, expiredWorkDoesNotCaptureOrWake: true,
      originalSourceProofUnchanged: true, originalGrantAndWorkUnchanged: true, moduleNodeAssertions: verification.assertions }
  }
  // This sleep tests the real fixed deadline, not fiber readiness.
  yield* Effect.sleep("1010 millis")
  const before = cutCount()
  const expired = yield* installed.profile.preflight(current).pipe(Effect.flip)
  checked.equal(expired.code, "WORK_REVOKED")
  checked.equal(cutCount(), before)
  order.length = 0
  yield* tasks.reconcileQueued
  checked.deepEqual(order, ["prepare", "preflight", "wake"])
  checked.deepEqual(wakes, [reserved.session_id])
  checked.equal(cutCount(), before + 1)
  checked.deepEqual(yield* input.db.all("SELECT proof,proof_hash,snapshot,snapshot_hash FROM im_task_source"), originalProof)

  yield* Effect.sleep("1010 millis")
  input.native.faults.members = ["receiver"]
  order.length = 0
  yield* tasks.reconcileQueued
  checked.deepEqual(order, ["prepare"])
  checked.equal(wakes.length, 1)
  checked.equal((yield* WorkAuthority.get(input.db, reserved.work_id))?.outcome, "pending")
  input.native.faults.members = ["receiver", "sender"]
  order.length = 0
  yield* tasks.reconcileQueued
  checked.deepEqual(order, ["prepare", "preflight", "wake"])
  checked.equal(wakes.length, 2)

  for (const boundary of ["claim", "promoted", "unknown"] as const) {
    if (boundary === "claim") yield* input.db.run(sql`UPDATE session SET execution_claim_token=7 WHERE id=${reserved.session_id}`)
    if (boundary === "promoted") yield* input.db.run(sql`UPDATE session_input SET promoted_seq=2 WHERE id=${reserved.input_id}`)
    if (boundary === "unknown") yield* input.db.run(sql`UPDATE work_execution SET outcome='unknown' WHERE work_id=${reserved.work_id}`)
    order.length = 0
    yield* tasks.reconcileQueued
    checked.deepEqual(order, [])
    checked.equal(wakes.length, 2)
    if (boundary === "claim") yield* input.db.run(sql`UPDATE session SET execution_claim_token=NULL WHERE id=${reserved.session_id}`)
    if (boundary === "promoted") yield* input.db.run(sql`UPDATE session_input SET promoted_seq=NULL WHERE id=${reserved.input_id}`)
    if (boundary === "unknown") yield* input.db.run(sql`UPDATE work_execution SET outcome='pending' WHERE work_id=${reserved.work_id}`)
  }
  changes.control = true
  order.length = 0
  yield* tasks.reconcileQueued
  checked.deepEqual(order, ["prepare", "preflight"])
  checked.equal(wakes.length, 2)
  checked.equal((yield* WorkAuthority.get(input.db, reserved.work_id))?.control_state, "revoked")
  checked.deepEqual(yield* input.db.all("SELECT proof,proof_hash,snapshot,snapshot_hash FROM im_task_source"), originalProof)
  const counts = (yield* input.db.get<{ providers: number; counts: number; dispatches: number; activities: number }>(sql`
    SELECT (SELECT count(*) FROM session_provider_attempt) providers,
      (SELECT count(*) FROM work_count_acquisition) counts,
      (SELECT count(*) FROM work_dispatch_reservation) dispatches,
      (SELECT count(*) FROM session_activity) activities`))!
  checked.deepEqual(counts, { providers: 0, counts: 0, dispatches: 0, activities: 0 })
  return { ...counts, originalSourceProofUnchanged: true, expiredSlotRefreshedOutsideSQL: true,
    currentMembershipRefusalDoesNotWake: true, knownUnstartedCanRetry: true,
    claimedPromotedAndUnknownExcluded: true, changedControlDoesNotWake: true, advisoryWakeCount: wakes.length, moduleNodeAssertions: verification.assertions }
}), expiry ? { durationMs: 7500 } : undefined)
