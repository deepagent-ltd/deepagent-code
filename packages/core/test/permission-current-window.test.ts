import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/activity-authority"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Hash } from "@deepagent-code/core/util/hash"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const layer = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provideMerge(EventV2.layer.pipe(Layer.provide(database))),
  Layer.provideMerge(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/project") }))),
  Layer.provideMerge(PermissionSaved.layer.pipe(Layer.provide(database))),
)
const it = testEffect(layer)
const ref = { activityKind: "v2" as const, activityID: "v2-current-window-activity" }

function challenge() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make("ses_current_window"),
        project_id: Project.ID.global,
        slug: "current-window",
        directory: "/project",
        title: "Current no-progress window",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .run(
        "INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created) VALUES('current-window-input','ses_current_window','{}','queue',1,1,30)",
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        "INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at) VALUES('v2-current-window-activity','ses_current_window',0,'current-window-input','queue','active',30,NULL)",
      )
      .pipe(Effect.orDie)
    const configured = yield* DeepAgentActivityAuthority.configure({
      ...ref,
      expectedVersion: 1,
      objectiveText: "finish the task",
      completionCriteria: [{ kind: "plan_complete" }],
      enforcementState: "monitoring",
      stallThreshold: 1,
    })
    const first = yield* observe(configured.version, "first")
    const stalled = yield* observe(first.objective.version, "stalled")
    expect(stalled.objective.state).toBe("needs_human")
    const requestID = PermissionV2.ID.make(
      `per_${Hash.sha256(`v2-no-progress:${ref.activityID}:${stalled.observation.revision}`).slice(0, 48)}`,
    )
    const ownerID = yield* (yield* PermissionV2.Service).currentNoProgressOwnerID!()
    const request = yield* DeepAgentActivityAuthority.requestPermission({
      ...ref,
      requestID,
      requestKind: "no_progress",
      idempotencyKey: `v2-no-progress-request:${requestID}`,
      permission: "doom_loop",
      patterns: ["activity"],
      alwaysPatterns: ["activity"],
      metadata: {
        activity_id: ref.activityID,
        observation_revision: stalled.observation.revision,
        no_progress_count: stalled.observation.noProgressCount,
        vector_hash: stalled.observation.vectorHash,
        kind: "no_progress",
      },
      ownerID,
      expiresAt: Date.now() + 86_400_000,
    })
    return { requestID, ownerID, request, stalled }
  })
}

function observe(expectedVersion: number, key: string, workspaceRevision = "workspace-original") {
  return DeepAgentActivityAuthority.observe({
    ...ref,
    expectedVersion,
    idempotencyKey: `current-window-observation:${key}`,
    workspaceRevision,
    evidence: [],
    effectReceipts: [],
    nextAction: "continue",
  })
}

function expire(ownerID: string) {
  return Effect.gen(function* () {
    // Shorten a real live lease through its production writer, then wait on real DB time.
    // Do not call PermissionV2.currentNoProgressOwnerID or rotate while observing this gap.
    yield* Effect.yieldNow
    yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID, leaseMs: 5 })
    const db = (yield* Database.Service).db
    for (let attempt = 0; attempt < 500; attempt++) {
      const lease = yield* db
        .get<{ owner_id: string; lease_expires_at: number; now: number }>(
          sql`
        SELECT owner_id,lease_expires_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AS now
        FROM session_activity_permission_owner_lease WHERE owner_id=${ownerID}`,
        )
        .pipe(Effect.orDie)
      if (lease && lease.lease_expires_at <= lease.now) {
        expect(lease.owner_id).toBe(ownerID)
        return
      }
      yield* Effect.sleep("1 millis")
    }
    return yield* Effect.die("Real permission lease did not expire")
  })
}

const approve = (requestID: PermissionV2.ID) =>
  DeepAgentActivityAuthority.decidePermission({
    requestID,
    idempotencyKey: `v2-no-progress-decision:${requestID}:approved_once`,
    decision: "approved_once",
    actorType: "user",
    actorID: "permission-ui",
  })
const consume = (requestID: PermissionV2.ID) =>
  DeepAgentActivityAuthority.consumeOnce({
    requestID,
    consumerID: `v2-no-progress:${ref.activityID}`,
    idempotencyKey: `v2-no-progress-consumption:${requestID}`,
  })
const advanceEpoch = Effect.gen(function* () {
  yield* (yield* PermissionSaved.Service).add({
    projectID: Project.ID.global,
    action: "read",
    resources: ["changed-authority"],
  })
})
function snapshot(requestID: PermissionV2.ID) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const request = yield* DeepAgentActivityAuthority.permissionRequestForRequest(requestID)
    const objective = yield* DeepAgentActivityAuthority.reconstruct(ref)
    const epoch = yield* (yield* PermissionSaved.Service).epoch(Project.ID.global)
    const decision = yield* db
      .get<{
        decision: string
      }>(sql`SELECT decision FROM session_activity_permission_decision WHERE request_id=${requestID}`)
      .pipe(Effect.orDie)
    const consumption = yield* db
      .get<{
        consumer_id: string
      }>(sql`SELECT consumer_id FROM session_activity_permission_once_consumption WHERE request_id=${requestID}`)
      .pipe(Effect.orDie)
    return {
      requestState: request?.state,
      requestEpoch: request?.authorityEpoch,
      currentEpoch: epoch.epoch,
      objectiveState: objective.objective.state,
      objectiveVersion: objective.objective.version,
      observationRevision: objective.objective.latestObservationRevision,
      decision,
      consumption,
    }
  })
}

for (const caller of ["authority", "permission_v2"] as const)
  it.live(`${caller}: rejects an expired no-progress owner before background rotation`, () =>
    Effect.gen(function* () {
      const current = yield* challenge()
      yield* expire(current.ownerID)
      const before = yield* snapshot(current.requestID)
      expect(before).toMatchObject({ requestState: "pending", objectiveState: "needs_human" })
      const reply =
        caller === "authority"
          ? yield* approve(current.requestID).pipe(Effect.exit)
          : yield* (yield* PermissionV2.Service)
              .reply({ requestID: current.requestID, reply: "once" })
              .pipe(Effect.exit)
      const after = yield* snapshot(current.requestID)
      console.log(
        "EV04_CURRENT_WINDOW",
        JSON.stringify({ case: `${caller}-owner-expired`, outcome: reply._tag, before, after }),
      )
      expect(reply._tag).toBe("Failure")
      expect(after).toMatchObject({ requestState: "pending", objectiveState: "needs_human" })
      expect(after.decision).toBeUndefined()
      expect(after.consumption).toBeUndefined()
    }),
  )

it.live("once consumption rejects an owner that expired after the durable decision but before consume", () =>
  Effect.gen(function* () {
    const current = yield* challenge()
    yield* approve(current.requestID)
    yield* expire(current.ownerID)
    const consumption = yield* consume(current.requestID).pipe(Effect.exit)
    const after = yield* snapshot(current.requestID)
    console.log(
      "EV04_CURRENT_WINDOW",
      JSON.stringify({ case: "consume-owner-expired", outcome: consumption._tag, after }),
    )
    expect(Exit.isFailure(consumption)).toBe(true)
    expect(after.consumption).toBeUndefined()
  }),
)

for (const phase of ["decision", "consume"] as const)
  it.live(`${phase}: rejects current saved epoch changing after the no-progress request`, () =>
    Effect.gen(function* () {
      const current = yield* challenge()
      if (phase === "consume") yield* approve(current.requestID)
      yield* advanceEpoch
      expect((yield* (yield* PermissionSaved.Service).epoch(Project.ID.global)).epoch).toBeGreaterThan(
        current.request.authorityEpoch,
      )
      const result =
        phase === "decision"
          ? yield* (yield* PermissionV2.Service)
              .reply({ requestID: current.requestID, reply: "once" })
              .pipe(Effect.exit)
          : yield* consume(current.requestID).pipe(Effect.exit)
      const after = yield* snapshot(current.requestID)
      console.log(
        "EV04_CURRENT_WINDOW",
        JSON.stringify({ case: `${phase}-epoch-changed`, outcome: result._tag, after }),
      )
      expect(result._tag).toBe("Failure")
      expect(after.consumption).toBeUndefined()
    }),
  )

it.live("pending no-progress observation cannot advance through the real authority while blocked", () =>
  Effect.gen(function* () {
    const current = yield* challenge()
    const attempted = yield* observe(current.stalled.objective.version, "while-blocked", "workspace-new").pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(attempted)).toBe(true)
    const before = yield* snapshot(current.requestID)
    expect(before.observationRevision).toBe(current.stalled.observation.revision)
    yield* (yield* PermissionV2.Service).reply({ requestID: current.requestID, reply: "once" })
    expect((yield* snapshot(current.requestID)).consumption).toMatchObject({
      consumer_id: `v2-no-progress:${ref.activityID}`,
    })
  }),
)

it.live("characterizes activity-scoped once consumption after a post-approval observation advances", () =>
  Effect.gen(function* () {
    const current = yield* challenge()
    yield* approve(current.requestID)
    const resumed = yield* DeepAgentActivityAuthority.reconstruct(ref)
    const changed = yield* observe(resumed.objective.version, "after-approval", "workspace-new")
    expect(changed.observation.revision).toBeGreaterThan(current.stalled.observation.revision)
    yield* consume(current.requestID)
    const after = yield* snapshot(current.requestID)
    console.log("EV04_CURRENT_WINDOW", JSON.stringify({ case: "consume-post-approval-observation", after }))
    expect(after.consumption).toMatchObject({ consumer_id: `v2-no-progress:${ref.activityID}` })
  }),
)

it.live("stale owner: fresh user and administrator terminate cannot settle the blocked activity", () =>
  Effect.gen(function* () {
    const current = yield* challenge()
    yield* expire(current.ownerID)
    const user = yield* (yield* PermissionV2.Service)
      .reply({ requestID: current.requestID, reply: "reject" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(user)).toBe(true)
    const administrator = yield* DeepAgentActivityAuthority.decidePermission({
      requestID: current.requestID,
      idempotencyKey: "administrator-terminate",
      decision: "interrupted",
      actorType: "administrator",
      actorID: "operator",
    }).pipe(Effect.exit)
    expect(Exit.isFailure(administrator)).toBe(true)
    expect(yield* snapshot(current.requestID)).toMatchObject({
      requestState: "pending",
      objectiveState: "needs_human",
    })
  }),
)

for (const actor of ["user", "administrator"] as const)
  it.live(`stale epoch: ${actor} may terminate only the original blocked activity without execution`, () =>
    Effect.gen(function* () {
      const current = yield* challenge()
      yield* advanceEpoch
      const db = (yield* Database.Service).db
      const counts = () =>
        db
          .get(
            sql`SELECT
        (SELECT COUNT(*) FROM session_input) AS inputs,
        (SELECT COUNT(*) FROM session_provider_attempt) AS attempts,
        (SELECT COUNT(*) FROM session_v2_provider_turn_receipt) AS receipts,
        (SELECT COUNT(*) FROM session_activity_permission_once_consumption) AS consumptions`,
          )
          .pipe(Effect.orDie)
      const before = yield* counts()
      if (actor === "user")
        yield* (yield* PermissionV2.Service).reply({ requestID: current.requestID, reply: "reject" })
      if (actor === "administrator")
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: current.requestID,
          idempotencyKey: "administrator-terminate",
          decision: "interrupted",
          actorType: "administrator",
          actorID: "operator",
        })
      expect(yield* snapshot(current.requestID)).toMatchObject({
        requestState: "interrupted",
        objectiveState: "interrupted",
        decision: { decision: "interrupted" },
      })
      expect(yield* counts()).toEqual(before)
      expect(
        yield* db.get(sql`SELECT state FROM session_activity WHERE activity_id=${ref.activityID}`).pipe(Effect.orDie),
      ).toEqual({ state: "interrupted" })
      expect((yield* approve(current.requestID).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* counts()).toEqual(before)
    }),
  )

it.live("system recovery can settle the stale owner and epoch", () =>
  Effect.gen(function* () {
    const current = yield* challenge()
    yield* advanceEpoch
    yield* expire(current.ownerID)
    yield* DeepAgentActivityAuthority.rotatePermissionOwner({
      previousOwnerID: current.ownerID,
      ownerID: "v2-window-recovery-owner",
      leaseMs: 30_000,
    })
    expect(yield* snapshot(current.requestID)).toMatchObject({
      requestState: "interrupted",
      objectiveState: "interrupted",
    })
  }),
)

it.live(
  "exact once retries after owner expiry and epoch change return committed receipts without rearming or consuming again",
  () =>
    Effect.gen(function* () {
      const current = yield* challenge()
      const permission = yield* PermissionV2.Service
      yield* permission.reply({ requestID: current.requestID, reply: "once" })
      const approved = yield* snapshot(current.requestID)
      yield* advanceEpoch
      yield* expire(current.ownerID)
      yield* permission.reply({ requestID: current.requestID, reply: "once" })
      const repeated = yield* snapshot(current.requestID)
      expect(repeated).toEqual({ ...approved, currentEpoch: approved.currentEpoch + 1 })
      const db = (yield* Database.Service).db
      expect(
        yield* db
          .get(
            sql`SELECT COUNT(*) AS count FROM session_activity_permission_decision WHERE request_id=${current.requestID}`,
          )
          .pipe(Effect.orDie),
      ).toEqual({ count: 1 })
      expect(
        yield* db
          .get(
            sql`SELECT COUNT(*) AS count FROM session_activity_permission_once_consumption WHERE request_id=${current.requestID}`,
          )
          .pipe(Effect.orDie),
      ).toEqual({ count: 1 })
    }),
)
