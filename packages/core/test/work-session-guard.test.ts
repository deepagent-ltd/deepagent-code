import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "../src/database/database"
import { AgentV2 } from "../src/agent"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-layer"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { Prompt } from "../src/session/prompt"
import { SessionRunner } from "../src/session/runner"
import { SessionStore } from "../src/session/store"
import { WorkAdmission } from "../src/session/work-admission"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { Delegation } from "../src/tool/delegation"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { projectLayer } from "./fixture/project-layer"

type Services =
  | Database.Service
  | EventV2.Service
  | SessionV2.Service
  | SessionStore.Service
  | SessionExecution.Service
  | Scope.Scope
const model = ModelV2.Ref.make({
  id: ModelV2.ID.make("deterministic"),
  providerID: ProviderV2.ID.make("test-provider"),
})

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : Cause.pretty(exit.cause)
}

const facts = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return {
    sessions: yield* db.all<Record<string, unknown>>("SELECT * FROM session ORDER BY id"),
    inputs: yield* db.all<Record<string, unknown>>("SELECT * FROM session_input ORDER BY id"),
    events: yield* db.all<Record<string, unknown>>("SELECT aggregate_id,seq,type,data FROM event ORDER BY sync_seq"),
  }
})

async function isolated<A, E>(
  body: (fixture: {
    location: Location.Ref
    binding: WorkAuthoritySchema.Binding
    state: { locations: number; runs: number; shells: number; block: boolean }
    started: Deferred.Deferred<void>
  }) => Effect.Effect<A, E, Services>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-session-guard-")))
  const directory = path.join(root, "project")
  await fs.mkdir(directory)
  const database = WorkAuthorityFixture.database(path.join(root, "authority.sqlite"))
  await Effect.runPromise(WorkAuthorityFixture.initialize().pipe(Effect.provide(database), Effect.scoped))
  const state = { locations: 0, runs: 0, shells: 0, block: false }
  const started = Deferred.makeUnsafe<void>()
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const locations = Layer.effect(
    LocationServiceMap,
    LayerMap.make(() =>
      Layer.effect(
        SessionRunner.Service,
        Effect.sync(() => {
          state.locations++
          return SessionRunner.Service.of({
            run: () =>
              Effect.gen(function* () {
                state.runs++
                yield* Deferred.succeed(started, undefined)
                if (state.block) yield* Effect.never
              }),
          })
        }),
      ),
    ).pipe(Effect.map((service) => service as unknown as LocationServiceMap["Service"])),
  )
  const execution = SessionExecutionLocal.layer.pipe(
    Layer.provide(Layer.mergeAll(database, store, events, locations, Delegation.delegationSlotLayer)),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(Layer.mergeAll(database, store, events, execution, projectLayer(database))),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(events, database)))
  const services = Layer.mergeAll(
    database,
    events,
    store,
    execution,
    sessions,
    projector,
    WorkAuthorityFixture.verifier,
  )
  const binding = {
    ...WorkAuthorityFixture.binding("session-guard"),
    location: { directory },
    deadline: Date.now() + 100_000,
  }
  try {
    // The Location runner is the controlled external execution boundary. Session APIs, SQL
    // claims, coordination, input admission and all event projections are actual services.
    // This core-only admission composition intentionally omits the optional Agent roster.
    return await Effect.runPromise(
      body({ location: { directory: AbsolutePath.make(directory) }, binding, state, started }).pipe(
        Effect.provideService(SessionV2.CurrentManualShell, () =>
          Effect.sync(() => {
            state.shells++
          }),
        ),
        Effect.provide(services),
        Effect.scoped,
      ),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("ordinary Session remains writable and executes through actual claims and lifecycle", () =>
  isolated(({ location, state }) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const ordinary = yield* session.create({ location, model })
      yield* session.setPermissions({
        sessionID: ordinary.id,
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
      })
      yield* session.switchModel({ sessionID: ordinary.id, model })
      yield* session.update({ sessionID: ordinary.id, title: "ordinary control" })
      const prompt = yield* session.prompt({
        sessionID: ordinary.id,
        prompt: new Prompt({ text: "ordinary" }),
        resume: false,
      })
      expect(prompt.id).toBeTruthy()
      expect(state.runs).toBe(0)
      yield* session.shell({ sessionID: ordinary.id, command: "controlled shell boundary", resume: false })
      expect(state.shells).toBe(1)
      yield* session.resume(ordinary.id)
      expect(state.locations).toBe(1)
      expect(state.runs).toBe(1)
      const recorded = yield* facts
      expect(recorded.inputs).toHaveLength(1)
      expect(recorded.sessions[0]?.execution_claim_token).toBeNull()
      expect(recorded.events.map((event) => event.type)).toContain("session.execution.started.1")
      expect(recorded.events.map((event) => event.type)).toContain("session.execution.succeeded.1")
    }),
  ))

test("trusted admit-only exact retry creates one queue input without waking the bound Session", () =>
  isolated(({ binding, state }) =>
    Effect.gen(function* () {
      const admitted = yield* WorkAdmission.admitWithState({ binding, auditedText: WorkAuthorityFixture.TEXT })
      expect(admitted.becameReady).toBe(true)
      const first = admitted.input
      const repeated = yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT })
      expect(repeated).toEqual(first)
      expect(
        (yield* WorkAdmission.admitWithState({ binding, auditedText: WorkAuthorityFixture.TEXT })).becameReady,
      ).toBe(false)
      const db = (yield* Database.Service).db
      const work = yield* WorkAuthority.get(db, binding.workID)
      expect(work?.admission_state).toBe("ready")
      expect(work?.admitted_seq).toBe(first.admittedSeq)
      const recorded = yield* facts
      expect(recorded.sessions).toHaveLength(1)
      expect(recorded.inputs).toHaveLength(1)
      expect(recorded.inputs[0]).toMatchObject({
        id: binding.inputID,
        session_id: binding.sessionID,
        delivery: "queue",
        promoted_seq: null,
      })
      expect(recorded.events.some((event) => String(event.type).startsWith("session.execution."))).toBe(false)
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0, block: false })
      yield* db.run("UPDATE test_work_source SET enabled=0")
      expect(
        code(yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT }).pipe(Effect.exit)),
      ).toBe("WORK_REVOKED")
      expect(yield* facts).toEqual(recorded)
    }),
  ))

test("failed actual input commit keeps a queryable reservation and one concurrent retry wins readiness", () =>
  isolated(({ binding, state }) => Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("CREATE TRIGGER reject_work_input BEFORE INSERT ON session_input BEGIN SELECT RAISE(ABORT,'controlled admission failure'); END")
    const failed = yield* WorkAdmission.admitWithState({ binding, auditedText: WorkAuthorityFixture.TEXT }).pipe(Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    expect((yield* WorkAuthority.get(db, binding.workID))?.admission_state).toBe("reserved")
    expect((yield* facts).sessions).toHaveLength(1)
    expect((yield* facts).inputs).toHaveLength(0)
    expect(state.runs).toBe(0)
    yield* db.run("DROP TRIGGER reject_work_input")
    const retried = yield* Effect.all([
      WorkAdmission.admitWithState({ binding, auditedText: WorkAuthorityFixture.TEXT }),
      WorkAdmission.admitWithState({ binding, auditedText: WorkAuthorityFixture.TEXT }),
    ], { concurrency: 2 })
    expect(retried.map((value) => value.becameReady).sort()).toEqual([false, true])
    expect(retried[0]?.input).toEqual(retried[1]?.input)
    expect((yield* facts).inputs).toHaveLength(1)
    expect((yield* WorkAuthority.get(db, binding.workID))?.admission_state).toBe("ready")
    expect(state.runs).toBe(0)
  })))

test("public prompt, shell, compact and mutable settings reject bound work before any write", () =>
  isolated(({ binding, state }) =>
    Effect.gen(function* () {
      yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT })
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.make(binding.sessionID)
      const before = yield* facts
      const attempts: Effect.Effect<unknown, unknown>[] = [
        session.prompt({
          sessionID: id,
          id: SessionMessage.ID.make(binding.inputID),
          prompt: new Prompt({ text: WorkAuthorityFixture.TEXT }),
          delivery: "queue",
          resume: false,
        }),
        session.prompt({ sessionID: id, prompt: new Prompt({ text: "new public input" }), resume: true }),
        session.shell({ sessionID: id, command: "must never execute" }),
        session.skill({ sessionID: id, skill: "must never load" }),
        session.compact({ sessionID: id, model: { providerID: model.providerID, modelID: model.id } }),
        session.switchAgent({ sessionID: id, agent: "another-agent" }),
        session.switchModel({ sessionID: id, model }),
        session.setPermissions({ sessionID: id, permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
        session.update({ sessionID: id, title: "must not update", metadata: { workID: binding.workID } }),
      ]
      for (const attempt of attempts) expect(code(yield* attempt.pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
      expect(yield* facts).toEqual(before)
      expect((yield* session.get(id)).id).toBe(id)
      expect(yield* session.messages({ sessionID: id })).toEqual([])
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0, block: false })
    }),
  ))

test("public create cannot occupy a reserved ID, adopt bound work or create its child", () =>
  isolated(({ binding, location, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.make(binding.sessionID)
      yield* WorkAuthority.reserve(db, { binding })
      expect(
        code(yield* session.create({ id, location, model, agent: AgentV2.ID.make("build") }).pipe(Effect.exit)),
      ).toBe("WORK_BINDING_CONFLICT")
      expect(
        code(
          yield* session
            .create({
              id,
              location,
              metadata: {
                workID: binding.workID,
                bindingHash: (yield* WorkAuthority.get(db, binding.workID))?.binding_hash,
              },
            })
            .pipe(Effect.exit),
        ),
      ).toBe("WORK_BINDING_CONFLICT")
      expect((yield* facts).sessions).toEqual([])
      yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT })
      const before = yield* facts
      expect(code(yield* session.create({ id, location }).pipe(Effect.exit))).toBe("WORK_BINDING_CONFLICT")
      expect(code(yield* session.create({ parentID: id, location }).pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
      // Existing child adoption must also validate the requested parent before returning an existing row.
      const ordinary = yield* session.create({ location })
      expect(code(yield* session.create({ id: ordinary.id, parentID: id, location }).pipe(Effect.exit))).toBe(
        "PROFILE_UNAVAILABLE",
      )
      expect((yield* facts).inputs).toEqual(before.inputs)
      expect((yield* session.get(ordinary.id)).parentID).toBeUndefined()
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0, block: false })
    }),
  ))

test("public and direct execution resumes reject bound work before Location, claim or Started", () =>
  isolated(({ binding, state }) =>
    Effect.gen(function* () {
      yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT })
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const id = SessionV2.ID.make(binding.sessionID)
      const before = yield* facts
      expect(code(yield* session.resume(id).pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
      expect(code(yield* execution.resume(id).pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
      expect(code(yield* (yield* SessionStore.Service).requireExecution(id).pipe(Effect.exit))).toBe(
        "PROFILE_UNAVAILABLE",
      )
      yield* execution.wake(id, 999).pipe(Effect.exit)
      yield* execution.awaitIdle(id).pipe(Effect.exit)
      expect(yield* facts).toEqual(before)
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0, block: false })
      expect((yield* execution.active).size).toBe(0)
      // A bound idle Session remains interruptible; stopping must not need ordinary write permission.
      yield* session.interrupt(id)
      const after = yield* facts
      expect(after.inputs).toEqual(before.inputs)
      expect(after.events.at(-1)?.type).toBe("session.next.interrupt.requested.1")
      expect(after.sessions[0]?.execution_claim_token).toBeNull()
      expect(state.runs).toBe(0)
    }),
  ))

test("interrupt still stops an actual active ordinary coordinator and releases its claim", () =>
  isolated(({ location, state, started }) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const ordinary = yield* session.create({ location })
      state.block = true
      const pending = yield* session.resume(ordinary.id).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      expect((yield* execution.active).has(ordinary.id)).toBe(true)
      expect((yield* facts).sessions[0]?.execution_claim_token).toBeNumber()
      yield* session.interrupt(ordinary.id)
      const outcome = yield* Fiber.join(pending)
      expect(Exit.isFailure(outcome)).toBe(true)
      if (Exit.isFailure(outcome)) expect(Cause.hasInterruptsOnly(outcome.cause)).toBe(true)
      const stopped = yield* facts
      expect(stopped.sessions[0]?.execution_claim_token).toBeNull()
      expect(stopped.events.at(-1)?.type).toBe("session.execution.interrupted.1")
      expect((yield* execution.active).size).toBe(0)
      expect(state.runs).toBe(1)
    }),
  ))

test("a pre-existing descendant cannot escape a subsequently reserved Work ancestor", () =>
  isolated(({ binding, location, state }) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      // Session parent IDs are durable links, not foreign keys. Exercise the real public create
      // ordering instead of manufacturing a child row or mocking ancestor lookups.
      const child = yield* session.create({ parentID: SessionV2.ID.make(binding.sessionID), location })
      const grandchild = yield* session.create({ parentID: child.id, location })
      yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT })
      const before = yield* facts
      for (const id of [child.id, grandchild.id]) {
        expect(
          code(
            yield* session.prompt({ sessionID: id, prompt: new Prompt({ text: "must not escape" }) }).pipe(Effect.exit),
          ),
        ).toBe("PROFILE_UNAVAILABLE")
        expect(code(yield* execution.resume(id).pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
        expect(code(yield* session.create({ parentID: id, location }).pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
      }
      expect(yield* facts).toEqual(before)
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0, block: false })
    }),
  ))
