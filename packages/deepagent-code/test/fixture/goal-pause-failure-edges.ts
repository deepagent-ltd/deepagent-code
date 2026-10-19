// Finite macOS failure edges through real AppRuntime, HTTP, file DB and owned native validation.
// No model request, SQL authority write or substitute process/permission service is used.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { GoalPauseBoundary } from "@deepagent-code/core/deepagent/goal-pause-boundary"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { createPlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { GoalManager } from "@/session/goal-manager"
import { GoalTickExecution } from "@/session/goal-tick-execution"
import { GoalTickProjection } from "@/session/goal-tick-projection"
import { GoalOwnedLoop } from "@/session/goal-owned-loop"
import { GoalOwnedTurn } from "@/session/goal-owned-turn"
import { OwnedValidation } from "@/deepagent/owned-validation"
import { Server } from "@/server/server"

assert.equal(process.platform, "darwin", "This finite native containment qualification targets macOS")
const root = process.argv[2]!
const directory = path.join(root, "project")
await Bun.write(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    model: "fixture/test-model",
    permission: { "*": "allow" },
    provider: {
      fixture: {
        name: "No-provider Goal failure edges",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: "http://127.0.0.1:1/v1" },
        models: { "test-model": { name: "Fixture", tool_call: true, limit: { context: 100000, output: 10000 } } },
      },
    },
  }),
)
const rg = Bun.which("rg")!
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, path.basename(rg)))

const setup = (name: string, command?: string) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* (yield* SessionV2.Service).create({
        location: { directory: AbsolutePath.make(directory) },
        model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      const docroot = GoalManager.goalStoreRoot(session.id)
      const initialization = yield* GoalTickProjection.prepare(db, {
        directory: docroot,
        sessionID: session.id,
        requestID: name,
        plan: createPlanDoc(session.id, "Failure edge, no model execution", [
          { step_id: "one", title: "Retain original business work", status: "active" },
        ]),
        spec: {
          criteria: command ? [{ kind: "tests_pass", commands: [command] }] : [{ kind: "plan_complete" }],
          limits: { maxTicks: 2, maxTokens: 1000, maxWallclockMs: 300000 },
          stallThreshold: 3,
        },
        model: { providerID: "fixture", modelID: "test-model" },
        netTokenBudget: false,
        panel: { question: "Review", codeRefs: [], lenses: ["correctness"], maxRounds: 1 },
      })
      const start = yield* GoalControl.reserveStart(db, {
        sessionID: session.id,
        requestID: name,
        requestHash: GoalControl.fingerprint(name),
        initialization,
        planDocId: initialization.spec.planDocId,
        driverMode: "event",
      })
      yield* GoalTickProjection.initialize(db, {
        row: start.row,
        requestID: name,
        requestHash: GoalControl.fingerprint(name),
        directory: docroot,
      })
      const tick = yield* GoalControl.beginTick(db, {
        sessionID: session.id,
        goalId: start.row.goal_id,
        planDocId: initialization.spec.planDocId,
        revision: 1,
        seq: 0,
        expectedPlanVersion: 1,
        mode: "event",
      })
      const context = yield* (yield* InstanceStore.Service).load({ directory })
      yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot }).pipe(
        Effect.provideService(InstanceRef, context),
      )
      return { session, tick, docroot, context }
    }),
  )
type Setup = Awaited<ReturnType<typeof setup>>
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
const control = async (action: "pause" | "stop", owner: Setup, expectedRevision: number, requestID: string) => {
  assert(listener)
  const url = new URL(`/deepagent/goal/${action}`, listener.url)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("deepagent-code:pause-edge-fixture").toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionID: owner.session.id, goalId: owner.tick.row.goal_id, expectedRevision, requestID }),
  })
  const body: unknown = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return Schema.decodeUnknownSync(GoalControlSchema.Snapshot)(body)
}
const observe = (owner: Setup) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const checkpoint = (yield* GoalTickCheckpointV2.read(db, owner.tick.permit.permit_id))!
      const goal = (yield* GoalControl.get(db, owner.tick.row.goal_id))!
      const boundary = yield* GoalPauseBoundary.read(db, owner.tick.permit.permit_id)
      const resume = yield* GoalControl.control(db, {
        action: "resume",
        sessionID: owner.session.id,
        goalId: goal.goal_id,
        expectedRevision: goal.revision,
        requestID: `no-resume-${owner.session.id}`,
      }).pipe(Effect.exit)
      const permit = (yield* db.all<GoalControl.Permit>(
        sql`SELECT * FROM goal_tick_permit WHERE permit_id=${owner.tick.permit.permit_id}`,
      ))[0]!
      return { checkpoint, goal, boundary, permit, resumeRefused: Exit.isFailure(resume) }
    }),
  )
const cleanup = { server: false, runtime: false }
try {
  await AppRuntime.runPromise(Database.Service)
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const marker = path.join(directory, "owned-write-marker.txt")
  const writer = await setup(
    "real-owned-write-interrupt",
    `printf 'ACTUAL_OWNED_WRITE' > '${marker.replaceAll("'", "'\\''")}'; while :; do :; done`,
  )
  const writing = AppRuntime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* GoalTickExecution.Service).withFrame(writer.tick.permit, (frame) =>
        GoalOwnedTurn.validate({ permitID: writer.tick.permit.permit_id, frame, ordinal: 0, timeoutMs: 30000 }),
      )
    }).pipe(Effect.provideService(InstanceRef, writer.context), Effect.exit),
  )
  for (let attempt = 0; ; attempt++) {
    if ((await Bun.file(marker).exists()) && (await Bun.file(marker).text()) === "ACTUAL_OWNED_WRITE") break
    assert(attempt < 400, "The real owned writer did not create its marker within the bounded wait")
    await Bun.sleep(10)
  }
  const writePause = await control("pause", writer, 1, "pause-actual-owned-write")
  assert(Exit.isFailure(await writing))
  const written = await observe(writer)
  assert.equal(await Bun.file(marker).text(), "ACTUAL_OWNED_WRITE")
  assert.equal(writePause.requestedPhase, "paused")
  assert.equal(writePause.inFlight, true)
  assert.equal(writePause.recoveryRequired, true)
  assert.equal(written.boundary, undefined)
  assert.equal(written.permit.state, "unknown")
  assert(written.resumeRefused)
  const effect = written.checkpoint.journal.localEffects[0]!
  assert.equal(effect.state, "stop_confirmed")
  assert.equal(effect.containment, "single-process")
  assert.equal(effect.stopProof, "owned_process_exit")
  assert.equal(OwnedValidation.inspectCustody().live, 0)
  assert.equal(OwnedValidation.inspectCustody().quarantine, 0)

  const target = await setup("capacity-paused-original-frame")
  // Reservations are produced through normal Goal admission. No record or byte counter is patched.
  for (let index = 2; index < 256; index++) await setup(`capacity-reservation-${index}`)
  const capacity = await AppRuntime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Database.Service).db.get<{ records: number; bytes: number }>(
        sql`SELECT count(*) AS records,coalesce(sum(reserved_bytes),0) AS bytes FROM (SELECT reserved_bytes FROM goal_tick_checkpoint UNION ALL SELECT reserved_bytes FROM goal_pause_boundary)`,
      )
    }),
  )
  assert.equal(capacity?.records, 256)
  assert.equal(capacity?.bytes, 256 * GoalTickProgram.MAX_BYTES)
  const ready = Promise.withResolvers<void>()
  const frame = AppRuntime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* GoalTickExecution.Service).withFrame(target.tick.permit, () =>
        Effect.gen(function* () {
          ready.resolve()
          return yield* Effect.never
        }),
      )
    }).pipe(Effect.exit),
  )
  await ready.promise
  const fullPause = await control("pause", target, 1, "pause-at-real-logical-capacity")
  assert(Exit.isFailure(await frame))
  const full = await observe(target)
  assert.equal(fullPause.requestedPhase, "paused")
  assert.equal(fullPause.inFlight, true)
  assert.equal(fullPause.recoveryRequired, true)
  assert.equal(full.boundary, undefined)
  assert.equal(full.permit.state, "unknown")
  assert(full.resumeRefused)
  assert.equal(full.checkpoint.journal.localEffects.length, 0)
  const stopped = await control("stop", target, 2, "stop-at-real-logical-capacity")
  assert.equal(stopped.requestedPhase, "stopped")
  const providerReceipts = await AppRuntime.runPromise(
    Effect.gen(function* () {
      return (yield* (yield* Database.Service).db.all("SELECT receipt_id FROM session_v2_provider_turn_receipt")).length
    }),
  )
  assert.equal(providerReceipts, 0)
  await Bun.write(
    path.join(root, "result.json"),
    JSON.stringify({
      qualification: "macOS-AppRuntime-HTTP-fileDB-real-owned-process-no-model",
      writeInterrupted: {
        marker: "ACTUAL_OWNED_WRITE",
        nativeEffect: effect,
        ordinaryResumeRefused: true,
        boundaryAbsent: true,
        custody: OwnedValidation.inspectCustody(),
        documentCASCrashProven: false,
      },
      capacity: {
        ...capacity,
        semantics: "256MiB actual logical checkpoint reservations, not disk ENOSPC or 256MiB document bodies",
        pauseRevoked: true,
        ordinaryResumeRefused: true,
        boundaryAbsent: true,
        stopSucceeded: true,
      },
      providerReceipts,
    }),
  )
} finally {
  await listener?.stop()
  cleanup.server = true
  await AppRuntime.dispose()
  cleanup.runtime = true
  if (await Bun.file(path.join(root, "result.json")).exists()) {
    const result = await Bun.file(path.join(root, "result.json")).json()
    await Bun.write(path.join(root, "result.json"), JSON.stringify({ ...result, cleanup }))
  }
}
process.exit(0)
