// Real AppRuntime, durable producers, HTTP control, frame finalizers and file DB. No provider
// requests, SQL authority writes, or copied user data. Source Windows tests supply an explicitly
// absent owned Settings store at Root composition; they do not qualify Native storage.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalPauseBoundary } from "@deepagent-code/core/deepagent/goal-pause-boundary"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { GoalPlanRebase } from "@deepagent-code/core/deepagent/goal-plan-rebase"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
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
import { GoalChildPolicyHost } from "@/session/goal-child-policy"
import { Server } from "@/server/server"

const root = process.argv[2]!
const phase = process.argv[3]
const directory = path.join(root, "project")
const stage = (event: string, details?: Record<string, unknown>) =>
  writeSync(2, `[goal-pause-fixture] ${JSON.stringify({
    phase: phase ?? "default", event, at: Date.now(), elapsedMs: Math.round(performance.now()), ...details,
  })}\n`)
const frameExit = (event: string, exit: Exit.Exit<unknown, unknown>) => stage(event, {
  exit: exit._tag,
  errors: Exit.isFailure(exit) ? Cause.prettyErrors(exit.cause).slice(0, 2).map((error) => {
    const codes = {
      PROFILE_UNAVAILABLE: "profile_unavailable",
      LOCAL_OPERATOR_UNAVAILABLE: "native_operator_unavailable",
      WORK_BINDING_CONFLICT: "work_binding_conflict",
      EVENT_CONSUMPTION_UNAVAILABLE: "event_consumption_unavailable",
      SQLITE_BUSY: "sqlite_busy", SQLITE_LOCKED: "sqlite_locked", SQLITE_CANTOPEN: "sqlite_unavailable",
      SQLITE_READONLY: "sqlite_readonly", SQLITE_IOERR: "sqlite_io", SQLITE_CORRUPT: "sqlite_corrupt",
      SQLITE_NOTADB: "sqlite_not_database", ENOENT: "filesystem_missing", EACCES: "filesystem_denied",
      EPERM: "filesystem_denied", ERR_ASSERTION: "assertion_failed",
    } as const
    const rawCode: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value
    const code = typeof rawCode === "string" && Object.hasOwn(codes, rawCode) ? rawCode as keyof typeof codes : undefined
    const tag: unknown = Object.getOwnPropertyDescriptor(error, "_tag")?.value
    const name: unknown = Object.getOwnPropertyDescriptor(error, "name")?.value
    return {
      name: name === "AssertionError" ? "AssertionError" : error instanceof TypeError ? "TypeError"
        : error instanceof RangeError ? "RangeError" : error instanceof SyntaxError ? "SyntaxError" : "Error",
      tag: tag === "OwnedValidationError" ? "OwnedValidationError" : tag === "WorkAuthorityError" ? "WorkAuthorityError"
        : tag === "LocalOperatorError" ? "LocalOperatorError" : tag === "GoalChild.Error" ? "GoalChild.Error"
        : tag === "DatabaseBootstrapError" ? "DatabaseBootstrapError" : "UnclassifiedError",
      code: code ?? "UNCLASSIFIED",
      reason: code ? codes[code] : "unclassified_error",
    }
  }) : [],
})
stage("fixture-module-loaded")
await Bun.write(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    $schema: "https://ai.deepagent.ltd/config.schema.json",
    formatter: false,
    lsp: false,
    model: "fixture/test-model",
    permission: { "*": "allow" },
    provider: {
      fixture: {
        name: "Never-dispatched Goal oracle",
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

const setup = (name: string, maxTicks = 4) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      stage("setup-entered")
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
        plan: createPlanDoc(session.id, "Keep the original active business step", [
          { step_id: "one", title: "Original unexecuted step", status: "active" },
        ]),
        spec: {
          criteria: [{ kind: "plan_complete" }],
          limits: { maxTicks, maxTokens: 1000, maxWallclockMs: 60000 },
          stallThreshold: 3,
        },
        model: { providerID: "fixture", modelID: "test-model" },
        netTokenBudget: false,
        panel: { question: "Review", codeRefs: [], lenses: ["correctness"], maxRounds: 1 },
      })
      const prepared = yield* GoalControl.reserveStart(db, {
        sessionID: session.id,
        requestID: name,
        requestHash: GoalControl.fingerprint(name),
        initialization,
        planDocId: initialization.spec.planDocId,
        driverMode: "event",
      })
      yield* GoalTickProjection.initialize(db, {
        row: prepared.row,
        requestID: name,
        requestHash: GoalControl.fingerprint(name),
        directory: docroot,
      })
      const tick = yield* GoalControl.beginTick(db, {
        sessionID: session.id,
        goalId: prepared.row.goal_id,
        planDocId: initialization.spec.planDocId,
        revision: 1,
        seq: 0,
        expectedPlanVersion: 1,
        mode: "event",
      })
      stage("tick-issued")
      const context = yield* (yield* InstanceStore.Service).load({ directory })
      stage("instance-ready")
      const program = yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot }).pipe(
        Effect.provideService(InstanceRef, context),
      )
      stage("program-prepared")
      return { session, tick, program, docroot, context }
    }),
  )
type Setup = Awaited<ReturnType<typeof setup>>

const admit = (setup: Setup, frame: GoalTickExecution.Frame, permitID = setup.tick.permit.permit_id) =>
  Effect.gen(function* () {
    stage("admit-entered")
    const db = (yield* Database.Service).db
    const frames = yield* GoalTickExecution.Service
    const current = (yield* GoalTickCheckpointV2.read(db, permitID))!
    const activated = yield* GoalTickCheckpointV2.activate(db, {
      permitID,
      revision: current.revision,
      role: 0,
      text: "Never dispatch this retained original stage",
    })
    stage("checkpoint-activated")
    const role = activated.journal.program.roles[0]
    const framePolicy = frames.policy(frame)
    assert(framePolicy)
    const policy = yield* GoalChildPolicyHost.prepare({
      version: 3,
      frame: framePolicy,
      permitID,
      roleKey: role.key,
      agent: role.agent,
      mode: role.mode,
    })
    stage("policy-prepared")
    const view = GoalChildPolicy.inspect(policy)
    assert(view)
    const source = yield* GoalControl.get(db, setup.tick.row.goal_id)
    assert(source)
    const permit = (yield* db.all<GoalControl.Permit>(
      sql`SELECT * FROM goal_tick_permit WHERE permit_id=${permitID}`,
    ))[0]
    const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, {
      permitID,
      permitToken: permit.token,
      roleKey: role.key,
      mode: role.mode,
      steeringHash: view.steeringHash,
      promptPolicyHash: view.promptPolicyHash,
      stage: "plain",
      text: "Never dispatch this retained original stage",
      policy,
    })
    stage("child-admitted")
    return child
  }).pipe(Effect.provideService(InstanceRef, setup.context))

let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
const control = async (
  action: string,
  setup: { session: { id: string }; tick: { row: { goal_id: string } } },
  expectedRevision: number,
  requestID: string,
) => {
  assert(listener)
  const url = new URL(`/deepagent/goal/${action}`, listener.url)
  url.searchParams.set("directory", directory)
  stage("control-dispatched", { action })
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("deepagent-code:pause-boundary-fixture").toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionID: setup.session.id, goalId: setup.tick.row.goal_id, expectedRevision, requestID }),
  })
  const body: unknown = await response.json()
  stage("control-response", { status: response.status })
  assert.equal(response.status, 200, JSON.stringify(body))
  return Schema.decodeUnknownSync(GoalControlSchema.Snapshot)(body)
}

const cleanup = { server: false, runtime: false }
try {
  stage("runtime-build-started")
  await AppRuntime.runPromise(Database.Service)
  stage("runtime-ready")
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  stage("listener-ready")
  if (phase === "crash-after-cas" || phase === "cold-after-cas") {
    // Readiness records only physical child identity. Goal admission and replay wait for the
    // parent to install the original business watchdogs and close this private start channel.
    const marker = path.join(root, `startup-${phase}-${process.pid}.json`)
    await Bun.write(marker + ".tmp", JSON.stringify({ phase, pid: process.pid }))
    await fs.rename(marker + ".tmp", marker)
    if ((await Bun.stdin.text()) !== "GO\n") throw new Error("Goal pause fixture did not receive its private start command")
    stage("business-started")
  }
  if (phase === "crash-after-cas") {
    const first = await setup("pause-real-cas-crash")
    const ready = Promise.withResolvers<void>()
    void AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* GoalTickExecution.Service).withFrame(first.tick.permit, (frame) =>
          Effect.gen(function* () {
            stage("frame-entered")
            yield* admit(first, frame)
            ready.resolve()
            return yield* Effect.never
          }),
        )
      }).pipe(Effect.exit),
    ).then((exit) => frameExit("crash-frame-exited", exit))
    await ready.promise
    stage("frame-ready")
    await Bun.write(
      path.join(root, "crash-case.json"),
      JSON.stringify({
        sessionID: first.session.id,
        goalID: first.tick.row.goal_id,
        permitID: first.tick.permit.permit_id,
        directory: first.docroot,
      }),
    )
    const original = DocumentStore.prototype.projectExact
    // This child-only observer delegates the real CAS first, then stops before its caller can ACK SQL.
    DocumentStore.prototype.projectExact = function (payload, expected) {
      const observed = original.call(this, payload, expected)
      if (expected && observed.version === expected.version + 1) {
        writeFileSync(
          path.join(root, "cas-complete-before-ack.json"),
          JSON.stringify({
            pid: process.pid,
            documentID: observed.id,
            version: observed.version,
            hash: observed.hash,
            at: Date.now(),
            originalMethodReturned: true,
          }),
        )
        stage("cas-observed")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      return observed
    }
    await control("pause", first, 1, "pause-real-cas-crash-command")
    throw new Error("Parent did not kill the actual post-CAS child")
  }
  if (phase === "cold-after-cas") {
    const source = (await Bun.file(path.join(root, "crash-case.json")).json()) as {
      sessionID: string
      goalID: string
      permitID: string
      directory: string
    }
    const marker = (await Bun.file(path.join(root, "cas-complete-before-ack.json")).json()) as {
      documentID: string
      version: number
      hash: string
    }
    const inspect = async () => {
      const state = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const boundary = (yield* GoalPauseBoundary.read(db, source.permitID))!
          const goal = (yield* GoalControl.get(db, source.goalID))!
          const checkpoint = (yield* GoalTickCheckpointV2.read(db, source.permitID))!
          const permit = (yield* db.all<GoalControl.Permit>(
            sql`SELECT * FROM goal_tick_permit WHERE permit_id=${source.permitID}`,
          ))[0]!
          const counts = (yield* db.get<{
            providers: number
            attempts: number
            tools: number
            inputs: number
          }>(sql`SELECT
        (SELECT count(*) FROM session_v2_provider_turn_receipt) AS providers,
        (SELECT count(*) FROM session_provider_attempt) AS attempts,
        (SELECT count(*) FROM session_v2_tool_effect_admission) AS tools,
        (SELECT count(*) FROM session_input) AS inputs`))!
          const documents = boundary.record.documents.map((item) => {
            const document = DocumentStore.openExact(
              source.directory,
              boundary.record.documents.map((d) => d.documentID),
            ).get(item.documentID)!
            return { id: document.id, version: document.version, hash: document.hash, body: document.body }
          })
          return { boundary, goal, checkpoint, permit, counts, documents }
        }),
      )
      const files = (await Array.fromAsync(new Bun.Glob("docs/**/*.json").scan({ cwd: source.directory }))).sort()
      assert(files.length <= 64)
      return {
        ...state,
        files: await Promise.all(
          files.map(async (file) => ({
            path: file,
            sha256: new Bun.CryptoHasher("sha256")
              .update(await fs.readFile(path.join(source.directory, file)))
              .digest("hex"),
          })),
        ),
      }
    }
    const before = await inspect()
    assert.equal(before.boundary.state, "prepared")
    assert.equal(before.boundary.record.documents.find((d) => d.documentID === marker.documentID)!.state, "pending")
    assert.equal(before.documents.find((d) => d.id === marker.documentID)!.hash, marker.hash)
    const target = { session: { id: source.sessionID }, tick: { row: { goal_id: source.goalID } } }
    const status = await control("pause", target, 1, "pause-real-cas-crash-command")
    const after = await inspect()
    assert(status.replayed && status.inFlight && status.recoveryRequired)
    assert.equal(after.boundary.state, "prepared")
    assert.equal(after.boundary.record.documents.find((d) => d.documentID === marker.documentID)!.state, "confirmed")
    assert(after.boundary.record.documents.some((d) => d.state === "pending"))
    assert.deepEqual(after.documents, before.documents)
    assert.deepEqual(after.files, before.files)
    assert.deepEqual({ ...after.boundary.record, documents: [] }, { ...before.boundary.record, documents: [] })
    assert.deepEqual(after.permit, before.permit)
    assert.deepEqual(after.checkpoint, before.checkpoint)
    assert.deepEqual(after.counts, before.counts)
    assert.equal(after.counts.providers + after.counts.attempts + after.counts.tools, 0)
    assert.equal(after.goal.next_seq, before.goal.next_seq)
    const twice = await control("pause", target, 1, "pause-real-cas-crash-command")
    assert(twice.replayed && twice.inFlight && twice.recoveryRequired)
    assert.deepEqual((await inspect()).boundary, after.boundary)
    const resumed = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* GoalControl.control(db, {
          action: "resume",
          sessionID: source.sessionID,
          goalId: source.goalID,
          expectedRevision: after.goal.revision,
          requestID: "cold-cannot-remint",
        }).pipe(Effect.exit)
      }),
    )
    assert(Exit.isFailure(resumed))
    await Bun.write(
      path.join(root, "result.json"),
      JSON.stringify({
        phase,
        pid: process.pid,
        actualCASKill: true,
        originalProjectionAcknowledged: true,
        unstartedProjectionStillPending: true,
        documentsUnchanged: true,
        permitUnchanged: true,
        checkpointUnchanged: true,
        cursorUnchanged: true,
        documentFiles: after.files,
        recordSourceUnchanged: true,
        exactRetryIdempotent: true,
        noAuthorityReminted: true,
        ordinaryResumeRefused: true,
        providerReceipts: after.counts.providers,
        providerAttempts: after.counts.attempts,
        toolAdmissions: after.counts.tools,
        inputs: after.counts.inputs,
        cleanup,
      }),
    )
  } else if (phase === "foreign-live-root") {
    const first = await setup("pause-foreign-live-root")
    const ready = Promise.withResolvers<GoalTickExecution.Frame>()
    const frame = AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* GoalTickExecution.Service).withFrame(first.tick.permit, (frame) =>
          Effect.gen(function* () {
            stage("frame-entered")
            yield* admit(first, frame)
            ready.resolve(frame)
            return yield* Effect.never
          }),
        )
      }).pipe(Effect.exit),
    ).then((exit) => {
      frameExit("foreign-frame-exited", exit)
      return exit
    })
    const actual = await ready.promise
    stage("frame-ready")
    const foreign = await AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const owner = yield* GoalTickExecution.Service
          const other = Context.get(yield* Layer.build(Layer.fresh(GoalTickExecution.layer)), GoalTickExecution.Service)
          assert.notEqual(owner, other)
          yield* owner.current(actual)
          assert(owner.policy(actual))
          assert.equal(other.policy(actual), undefined)
          const denied = yield* other.current(actual).pipe(Effect.exit)
          assert(Exit.isFailure(denied))
          yield* other.control(first.tick.row.goal_id, 2, {
            commandID: "foreign-not-authority",
            directory: first.docroot,
          })
          assert.equal(yield* GoalPauseBoundary.read(db, first.tick.permit.permit_id), undefined)
          yield* owner.current(actual)
          return {
            foreignCurrentRefused: true,
            foreignPolicyAbsent: true,
            foreignControlNoSettlement: true,
            ownerStillLive: true,
          }
        }),
      ),
    )
    stage("foreign-checks-complete")
    const paused = await control("pause", first, 1, "pause-after-foreign-refusal")
    assert(!paused.inFlight && !paused.recoveryRequired)
    assert(Exit.isFailure(await frame))
    const receipt = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return {
          boundary: (yield* GoalPauseBoundary.read(db, first.tick.permit.permit_id))!.state,
          providers: (yield* db.get<{ n: number }>(sql`SELECT count(*) AS n FROM session_v2_provider_turn_receipt`))!.n,
        }
      }),
    )
    assert.equal(receipt.boundary, "committed")
    assert.equal(receipt.providers, 0)
    await Bun.write(
      path.join(root, "result.json"),
      JSON.stringify({
        phase,
        pid: process.pid,
        ...foreign,
        originalRootSettled: true,
        providerReceipts: receipt.providers,
        cleanup,
      }),
    )
  } else {
    const first = await setup("pause-boundary-never-dispatched")
    const ready = Promise.withResolvers<Effect.Success<ReturnType<typeof admit>>>()
    const frame = AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* GoalTickExecution.Service).withFrame(first.tick.permit, (frame) =>
          Effect.gen(function* () {
            const admitted = yield* admit(first, frame)
            ready.resolve(admitted)
            return yield* Effect.never
          }),
        )
      }).pipe(Effect.exit),
    )
    const original = await ready.promise
    const originalInput = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(original.unit.child_session_id)))
          .all()
      }),
    )
    const before = await AppRuntime.runPromise(
      Effect.gen(function* () {
        return (yield* GoalTickCheckpointV2.read((yield* Database.Service).db, first.tick.permit.permit_id))!
      }),
    )
    const paused = await control("pause", first, 1, "pause-never-dispatched")
    assert.equal(paused.requestedPhase, "paused")
    assert.equal(paused.inFlight, false)
    assert.equal(paused.recoveryRequired, false)
    assert(Exit.isFailure(await frame))
    const retry = await control("pause", first, 1, "pause-never-dispatched")
    assert(retry.replayed)
    const after = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const checkpoint = (yield* GoalTickCheckpointV2.read(db, first.tick.permit.permit_id))!
        const boundary = (yield* GoalPauseBoundary.read(db, first.tick.permit.permit_id))!
        const goal = (yield* GoalControl.get(db, first.tick.row.goal_id))!
        const baseline = yield* GoalPlanRebase.baseline(db, goal)
        const oldInputs = yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(original.unit.child_session_id)))
          .all()
        const forbidden = yield* GoalPauseBoundary.authority<object>(() => undefined)(db, {
          witness: {},
          directory: first.docroot,
        }).pipe(Effect.exit)
        const oldResume = yield* (yield* SessionExecution.Service)
          .resume(SessionSchema.ID.make(original.unit.child_session_id))
          .pipe(Effect.exit)
        return {
          checkpoint,
          boundary,
          goal,
          baseline,
          oldInputs,
          forbidden: Exit.isFailure(forbidden),
          oldResume: Exit.isFailure(oldResume),
          requests: (yield* db.all("SELECT receipt_id FROM session_v2_provider_turn_receipt")).length,
        }
      }),
    )
    assert.equal(after.checkpoint.state, "halted")
    assert.equal(after.checkpoint.journal_hash, before.journal_hash)
    assert.deepEqual(after.checkpoint.journal, before.journal)
    assert.equal(after.boundary.state, "committed")
    assert.equal(after.goal.next_seq, 1)
    assert.equal(after.goal.plan_version, first.tick.permit.plan_version)
    assert.deepEqual(after.oldInputs, originalInput)
    assert(after.forbidden && after.oldResume)
    assert.equal(after.requests, 0)
    const state = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(
      after.baseline.documents.find((item) => item.id === `doc:run_context:${after.goal.goal_id}`)!.body,
    )
    assert.equal(state.ledger.ticks, 1)
    assert.equal(state.ledger.tokens, 0)
    assert.equal(state.ledger.cost, 0)
    assert.equal(state.phase, "running")
    assert.equal(state.lastOutcome, first.program.state.lastOutcome)
    assert.equal(
      after.baseline.documents.find((item) => item.id === after.goal.plan_doc_id)!.body,
      first.program.docs.find((item) => item.id === after.goal.plan_doc_id)!.body,
    )
    // Use the actual durable control producer admit-only, keeping the event dispatcher out of this
    // no-provider oracle; HTTP pause and its original registry path above are the product boundary.
    const fresh = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* GoalControl.control(db, {
          action: "resume",
          sessionID: first.session.id,
          goalId: after.goal.goal_id,
          expectedRevision: 2,
          requestID: "explicit-resume-new-tick",
        })
        const next = yield* GoalControl.beginTick(db, {
          sessionID: first.session.id,
          goalId: after.goal.goal_id,
          planDocId: after.goal.plan_doc_id,
          revision: 3,
          seq: 1,
          expectedPlanVersion: after.goal.plan_version,
          mode: "event",
        })
        const prepared = yield* GoalOwnedLoop.prepare({
          permitID: next.permit.permit_id,
          directory: first.docroot,
        }).pipe(Effect.provideService(InstanceRef, first.context))
        const frames = yield* GoalTickExecution.Service
        const outcome = yield* frames.withFrame(next.permit, (frame) => admit(first, frame, next.permit.permit_id))
        const oldWake = yield* (yield* SessionExecution.Service)
          .wake(SessionSchema.ID.make(original.unit.child_session_id))
          .pipe(Effect.exit)
        return { next, prepared, unit: outcome.unit, oldWakeFailed: Exit.isFailure(oldWake) }
      }),
    )
    assert.notEqual(fresh.next.permit.permit_id, first.tick.permit.permit_id)
    assert.notEqual(fresh.unit.unit_id, original.unit.unit_id)
    assert.notEqual(fresh.unit.child_session_id, original.unit.child_session_id)
    assert.notEqual(fresh.unit.inputs[0].inputID, original.unit.inputs[0].inputID)
    assert.equal(fresh.prepared.state.ledger.ticks, 1)
    await control("stop", first, 3, "stop-new-virgin-tick")

    const race = await setup("pause-stop-race")
    const entered = Promise.withResolvers<void>()
    const finalizing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const racingFrame = AppRuntime.runPromise(
      Effect.gen(function* () {
        const frames = yield* GoalTickExecution.Service
        return yield* frames.withFrame(race.tick.permit, () =>
          Effect.gen(function* () {
            entered.resolve()
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.promise(async () => {
                  finalizing.resolve()
                  await release.promise
                }),
              ),
            )
          }),
        )
      }).pipe(Effect.exit),
    )
    await entered.promise
    const pausing = control("pause", race, 1, "pause-before-stop")
    await finalizing.promise
    const stopping = control("stop", race, 2, "stop-wins-pause-settlement")
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        for (const _ of Array.from({ length: 200 })) {
          const goal = yield* GoalControl.get((yield* Database.Service).db, race.tick.row.goal_id)
          if (goal?.requested_phase === "stopped") return
          yield* Effect.sleep("5 millis")
        }
        throw new Error("Stop must commit before releasing the original frame")
      }),
    )
    release.resolve()
    await Promise.all([pausing, stopping, racingFrame])
    const final = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const goal = (yield* GoalControl.get(db, race.tick.row.goal_id))!
        const boundary = yield* GoalPauseBoundary.read(db, race.tick.permit.permit_id)
        const resume = yield* GoalControl.control(db, {
          action: "resume",
          sessionID: race.session.id,
          goalId: goal.goal_id,
          expectedRevision: goal.revision,
          requestID: "cannot-reopen-stop",
        }).pipe(Effect.exit)
        return {
          goal,
          hasBoundary: !!boundary,
          resumeFailed: Exit.isFailure(resume),
          providerReceipts: (yield* db.all("SELECT receipt_id FROM session_v2_provider_turn_receipt")).length,
          boundaryCount: (yield* db.all("SELECT permit_id FROM goal_pause_boundary")).length,
        }
      }),
    )
    assert.equal(final.goal.requested_phase, "stopped")
    assert.equal(final.hasBoundary, false)
    assert(final.resumeFailed)
    assert.equal(final.providerReceipts, 0)
    assert.equal(final.boundaryCount, 1)

    const conflicted = await setup("pause-file-cas-conflict")
    const conflictReady = Promise.withResolvers<void>()
    const conflictFrame = AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* GoalTickExecution.Service).withFrame(conflicted.tick.permit, () =>
          Effect.gen(function* () {
            conflictReady.resolve()
            return yield* Effect.never
          }),
        )
      }).pipe(Effect.exit),
    )
    await conflictReady.promise
    const worklog = conflicted.program.docs.find((item) => item.id === `doc:worklog:${conflicted.tick.row.goal_id}`)!
    DocumentStore.openExact(
      conflicted.docroot,
      conflicted.program.docs.map((item) => item.id),
    ).projectExact(
      { ...worklog, version: worklog.version + 1, body: "An actual conflicting human file revision" },
      { id: worklog.id, version: worklog.version, hash: `sha256:${GoalTickProgram.hash(worklog)}` },
    )
    const conflictPause = await control("pause", conflicted, 1, "pause-file-conflict")
    await conflictFrame
    assert.equal(conflictPause.inFlight, true)
    assert.equal(conflictPause.recoveryRequired, true)
    const conflictEvidence = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const boundary = (yield* GoalPauseBoundary.read(db, conflicted.tick.permit.permit_id))!
        const forbidden = yield* GoalControl.control(db, {
          action: "resume",
          sessionID: conflicted.session.id,
          goalId: conflicted.tick.row.goal_id,
          expectedRevision: 2,
          requestID: "file-conflict-no-resume",
        }).pipe(Effect.exit)
        return { boundary, refused: Exit.isFailure(forbidden) }
      }),
    )
    assert.equal(conflictEvidence.boundary.state, "prepared")
    assert(conflictEvidence.boundary.record.documents.some((item) => item.state === "confirmed"))
    assert(conflictEvidence.refused)
    const repeatConflict = await control("pause", conflicted, 1, "pause-file-conflict")
    assert(repeatConflict.replayed && repeatConflict.inFlight && repeatConflict.recoveryRequired)
    await control("stop", conflicted, 2, "stop-file-conflict")

    const budget = await setup("pause-budget-preserved", 1)
    const budgetReady = Promise.withResolvers<void>()
    const budgetFrame = AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* GoalTickExecution.Service).withFrame(budget.tick.permit, () =>
          Effect.gen(function* () {
            budgetReady.resolve()
            return yield* Effect.never
          }),
        )
      }).pipe(Effect.exit),
    )
    await budgetReady.promise
    const budgetPause = await control("pause", budget, 1, "pause-last-tick-budget")
    await budgetFrame
    assert.equal(budgetPause.inFlight, false)
    const budgetResume = await AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* GoalControl.control((yield* Database.Service).db, {
          action: "resume",
          sessionID: budget.session.id,
          goalId: budget.tick.row.goal_id,
          expectedRevision: 2,
          requestID: "cannot-reset-original-tick-budget",
        }).pipe(Effect.exit)
      }),
    )
    assert(Exit.isFailure(budgetResume))
    await control("stop", budget, 2, "stop-budget-boundary")
    const providerReceipts = await AppRuntime.runPromise(
      Effect.gen(function* () {
        return (yield* (yield* Database.Service).db.all("SELECT receipt_id FROM session_v2_provider_turn_receipt"))
          .length
      }),
    )
    assert.equal(providerReceipts, 0)
    const exact = DocumentStore.openExact(
      first.docroot,
      after.baseline.documents.map((item) => item.id),
    )
    assert.equal(exact.get(`doc:run_context:${after.goal.goal_id}`)!.version, 2)
    await Bun.write(
      path.join(root, "result.json"),
      JSON.stringify({
        neverDispatched: {
          currentHTTPStatus: paused,
          journalUnchanged: true,
          originalInputUnchanged: true,
          tick: state.ledger.ticks,
          tokens: state.ledger.tokens,
          cost: state.ledger.cost,
          receipt: after.boundary.state,
        },
        newTick: { freshUnit: true, freshSession: true, freshInput: true, oldResumeRejected: after.oldResume },
        race: { stopped: true, noBoundary: !final.hasBoundary },
        fileCAS: { preparedNotSettled: true, samePauseCannotRemint: true, resumeRefused: true },
        budget: { tickConsumedOnce: true, resumeCannotReset: true },
        providerReceipts,
        qualification: "local-AppRuntime-fileDB-HTTP-no-model",
        cleanup,
      }),
    )
  }
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
