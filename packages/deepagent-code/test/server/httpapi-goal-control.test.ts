import { NodeHttpServer } from "@effect/platform-node"
import { existsSync } from "node:fs"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { GoalWorkBoundaryFixture } from "../fixture/goal-work-boundary"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { SessionV2 } from "@deepagent-code/core/session"
import { Session } from "../../src/session/session"
import { SessionRevert } from "../../src/session/revert"
import { SessionSteer } from "../../src/session/steer"
import { GoalManager } from "../../src/session/goal-manager"
import { Agent } from "../../src/agent/agent"
import { Snapshot } from "../../src/snapshot"
import { LSP } from "../../src/lsp/lsp"
import { Provider } from "../../src/provider/provider"
import { BackgroundJob } from "../../src/background/job"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { DeepAgentApi } from "../../src/server/routes/instance/httpapi/groups/deepagent"
import { deepagentHandlers } from "../../src/server/routes/instance/httpapi/handlers/deepagent"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const common = Layer.mergeAll(
  database,
  RuntimeFlags.layer({ experimentalGoalLoop: true, v4MultiAgentRuntime: true }),
  Layer.mock(BackgroundJob.Service)({}),
  Layer.mock(EventV2Bridge.Service)({}),
)
// Real Manager, Session SQL reader, GoalLoop initialization, outbox and EventBus. Execution-only
// dependencies are tripwires and no tick consumer is started in this command API topology.
// EventV2Bridge.publish also defects: advisory notification failure must not erase SQL acceptance.
const services = Layer.mergeAll(
  common,
  Session.layer.pipe(Layer.provide(common)),
  DeepAgentEventBus.layerWith().pipe(Layer.provide(database)),
  EffectFlock.defaultLayer,
  Layer.mock(Agent.Service)({}),
  Layer.mock(SessionRevert.Service)({}),
  Layer.mock(SessionSteer.Service)({}),
  Layer.mock(Provider.Service)({}),
  Layer.mock(LSP.Service)({}),
  Layer.mock(SessionV2.Service)({}),
  Layer.mock(Snapshot.Service)({}),
  Layer.mock(ApprovalQueue.Service)({}),
  AgentGateway.runtimeLayer().pipe(Layer.provide(EffectFlock.defaultLayer)),
  Layer.mock(LocationIdentity.Service)({}),
)
const manager = GoalManager.layer.pipe(Layer.provideMerge(services))
const TestApi = HttpApi.make("deepagent-code-instance").addHttpApi(DeepAgentApi)
const middleware = Layer.mergeAll(
  schemaErrorLayer,
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect),
  ),
  Layer.succeed(
    InstanceContextMiddleware,
    InstanceContextMiddleware.of((effect) => effect),
  ),
  Layer.succeed(
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddleware.of((effect) =>
      effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: "/tmp/goal-fixture" })),
    ),
  ),
)
const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(deepagentHandlers),
      Layer.provide(middleware),
      Layer.provide(manager),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(manager)),
)

const post = (action: string, payload: unknown) =>
  HttpClientRequest.post(`/deepagent/goal/${action}`).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(HttpClient.execute),
  )

it.live("actual Goal API refuses bound Work and ancestors before initialization, SQL mutation or wake", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* GoalWorkBoundaryFixture.reserve(db, "http-bound-root")
    const root = yield* GoalControlFixture.prepare(db, "http-bound-root")
    const child = yield* GoalControlFixture.prepare(db, "http-bound-child")
    const grandchild = yield* GoalControlFixture.prepare(db, "http-bound-grandchild")
    yield* db.run(sql`UPDATE session SET parent_id=${root.input.sessionID} WHERE id=${child.input.sessionID}`)
    yield* db.run(sql`UPDATE session SET parent_id=${child.input.sessionID} WHERE id=${grandchild.input.sessionID}`)
    yield* db.run(sql`DELETE FROM goal_control_command`)
    yield* db.run(sql`DELETE FROM goal_control`)
    const responses = []
    for (const setup of [root, child, grandchild]) {
      yield* db.run(
        sql`UPDATE session SET model='{"providerID":"goal-fixture","id":"never-called"}' WHERE id=${setup.input.sessionID}`,
      )
      expect(existsSync(GoalManager.goalStoreRoot(setup.input.sessionID))).toBe(false)
      const response = yield* post("start", {
        sessionID: setup.input.sessionID,
        requestID: `start-${setup.input.sessionID}`,
        objective: "Must never initialize or execute",
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 1, maxTokens: 100, maxWallclockMs: 10000 },
      })
      responses.push({ status: response.status, body: yield* response.json })
    }
    expect(responses).toMatchObject([
      { status: 409, body: { code: "unsupported" } },
      { status: 409, body: { code: "unsupported" } },
      { status: 409, body: { code: "unsupported" } },
    ])
    expect(
      [root, child, grandchild].map((setup) => existsSync(GoalManager.goalStoreRoot(setup.input.sessionID))),
    ).toEqual([false, false, false])
    for (const table of [
      "goal_control",
      "goal_control_command",
      "goal_tick_permit",
      "deepagent_event",
      "session_input",
      "session_context_selection",
      "session_provider_attempt",
    ]) {
      expect(yield* db.all(sql.raw(`SELECT * FROM ${table}`))).toEqual([])
    }
    expect(yield* db.all(sql`SELECT id FROM session WHERE execution_claim_token IS NOT NULL`)).toEqual([])
  }),
)

it.live("actual Goal API rejects old bound preparing retries without activating or mutating their records", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* GoalWorkBoundaryFixture.reserve(db, "http-bound-preparing")
    const prepared = yield* GoalControlFixture.prepare(db, "http-bound-preparing")
    const payload = { sessionID: prepared.input.sessionID, requestID: prepared.input.requestID }
    yield* db.run(
      sql`UPDATE goal_control_command SET request_hash=${GoalControl.fingerprint(payload)} WHERE goal_id=${prepared.row.goal_id}`,
    )
    const before = yield* GoalControl.current(db, prepared.input.sessionID)
    const command = yield* GoalControl.command(db, prepared.input.sessionID, prepared.input.requestID)
    const response = yield* post("start", payload)
    expect({ status: response.status, body: yield* response.json }).toMatchObject({
      status: 409,
      body: { code: "unsupported" },
    })
    expect(yield* GoalControl.current(db, prepared.input.sessionID)).toEqual(before)
    expect(yield* GoalControl.command(db, prepared.input.sessionID, prepared.input.requestID)).toEqual(command)
    expect(yield* GoalControl.pendingWakes(db)).toEqual([])
    expect(existsSync(GoalManager.goalStoreRoot(prepared.input.sessionID))).toBe(false)
  }),
)

it.live("ordinary Goal start does not treat Work-looking metadata as authority", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const prepared = yield* GoalControlFixture.prepare(db, "http-ordinary-metadata")
    yield* db.run(sql`DELETE FROM goal_control_command WHERE goal_id=${prepared.row.goal_id}`)
    yield* db.run(sql`DELETE FROM goal_control WHERE goal_id=${prepared.row.goal_id}`)
    yield* db.run(
      sql`UPDATE session SET model='{"providerID":"goal-fixture","id":"never-called"}', metadata='{"workID":"untrusted-hint","profile":"text-only","childPolicy":"deny_all"}' WHERE id=${prepared.input.sessionID}`,
    )
    const response = yield* post("start", {
      sessionID: prepared.input.sessionID,
      requestID: "ordinary-metadata-start",
      objective: "Ordinary metadata does not create Work authority",
      criteria: [{ kind: "plan_complete" }],
      limits: { maxTicks: 1, maxTokens: 100, maxWallclockMs: 10000 },
    })
    expect({ status: response.status, body: yield* response.json }).toMatchObject({
      status: 200,
      body: { preparation: "ready", requestedPhase: "running", wakeState: "pending" },
    })
    const row = (yield* GoalControl.current(db, prepared.input.sessionID))!
    expect(
      (yield* GoalControl.beginTick(db, {
        sessionID: prepared.input.sessionID,
        goalId: row.goal_id,
        planDocId: row.plan_doc_id,
        revision: 1,
        seq: 0,
        expectedPlanVersion: row.plan_version,
        mode: "event",
      })).replayed,
    ).toBe(false)
    expect(yield* db.all(sql`SELECT work_id FROM work_execution`)).toEqual([])
    expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
    expect(yield* db.all(sql`SELECT attempt_id FROM session_provider_attempt`)).toEqual([])
  }),
)

it.live("actual Goal API start, CAS, exact retry and legacy rejection use durable authority", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    // Seed only the native Session; remove fixture's unused preparation so real Manager initializes it.
    const prepared = yield* GoalControlFixture.prepare(db, "http")
    yield* db.run(sql`DELETE FROM goal_control_command WHERE goal_id=${prepared.row.goal_id}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM goal_control WHERE goal_id=${prepared.row.goal_id}`).pipe(Effect.orDie)
    yield* db
      .run(
        sql`UPDATE session SET model='{"providerID":"goal-fixture","id":"never-called"}' WHERE id=${prepared.input.sessionID}`,
      )
      .pipe(Effect.orDie)
    const payload = {
      sessionID: prepared.input.sessionID,
      requestID: "http-start",
      objective: "Document the fixture",
      criteria: [{ kind: "plan_complete" }],
      limits: { maxTicks: 2, maxTokens: 100, maxWallclockMs: 10000 },
    }
    const response = yield* post("start", payload)
    const started = yield* response.json
    expect({ status: response.status, started }).toMatchObject({
      status: 200,
      started: { revision: 1, requestedPhase: "running", wakeState: "pending" },
    })
    const row = (yield* GoalControl.current(db, payload.sessionID))!
    const version = DocumentStore.shared(GoalManager.goalStoreRoot(payload.sessionID)).get(row.plan_doc_id)?.version
    expect(
      (yield* post("start", {
        ...payload,
        requestID: "different-start",
        objective: "Must not rewrite the active plan",
      })).status,
    ).toBe(409)
    expect(DocumentStore.shared(GoalManager.goalStoreRoot(payload.sessionID)).get(row.plan_doc_id)?.version).toBe(
      version,
    )
    expect((yield* post("start", { ...payload, objective: "Conflicting exact retry" })).status).toBe(409)
    expect(row.initialization.model).toEqual({ providerID: "goal-fixture", modelID: "never-called" })
    const retry = yield* post("start", payload)
    expect(yield* retry.json).toMatchObject({ goalId: row.goal_id, replayed: true, revision: 1 })
    expect((yield* post("pause", { sessionID: payload.sessionID })).status).toBe(400)
    expect(
      (yield* post("pause", { sessionID: payload.sessionID, goalId: "old", expectedRevision: 1, requestID: "stale" }))
        .status,
    ).toBe(404)
    const control = { sessionID: payload.sessionID, goalId: row.goal_id, expectedRevision: 1, requestID: "http-pause" }
    const paused = yield* post("pause", control)
    expect(yield* paused.json).toMatchObject({ revision: 2, requestedPhase: "paused", inFlight: false })
    expect(yield* (yield* post("pause", control)).json).toMatchObject({ revision: 2, replayed: true })
    expect((yield* post("resume", { ...control, requestID: "stale-revision" })).status).toBe(409)
    const stopped = yield* post("stop", { ...control, expectedRevision: 2, requestID: "http-stop" })
    expect(yield* stopped.json).toMatchObject({ revision: 3, requestedPhase: "stopped", inFlight: false })
    const next = yield* (yield* post("start", { ...payload, requestID: "http-second-start" })).json
    expect(next).toMatchObject({ revision: 1, requestedPhase: "running", replayed: false })
    expect((yield* post("stop", { ...control, expectedRevision: 3, requestID: "late-old-goal" })).status).toBe(409)
    expect((yield* GoalControl.current(db, payload.sessionID))?.requested_phase).toBe("running")
    expect(yield* db.get(sql`SELECT count(*) AS count FROM session_input`).pipe(Effect.orDie)).toEqual({ count: 0 })
    expect(yield* db.get(sql`SELECT count(*) AS count FROM session_provider_attempt`).pipe(Effect.orDie)).toEqual({
      count: 0,
    })
  }),
)

it.live("actual Goal API retries a persisted preparation without resetting its GoalLoop record", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const prepared = yield* GoalControlFixture.prepare(db, "http-preparation")
    yield* db.run(sql`DELETE FROM goal_control_command WHERE goal_id=${prepared.row.goal_id}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM goal_control WHERE goal_id=${prepared.row.goal_id}`).pipe(Effect.orDie)
    yield* db
      .run(
        sql`UPDATE session SET model='{"providerID":"goal-fixture","id":"never-called"}' WHERE id=${prepared.input.sessionID}`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`CREATE TRIGGER goal_activation_gap BEFORE UPDATE OF receipt ON goal_control_command WHEN NEW.request_id='http-preparation-gap' AND NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'activation gap'); END`,
      )
      .pipe(Effect.orDie)
    const payload = {
      sessionID: prepared.input.sessionID,
      requestID: "http-preparation-gap",
      objective: "Stable preparation",
      criteria: [{ kind: "plan_complete" }],
      limits: { maxTicks: 2, maxTokens: 100, maxWallclockMs: 10000 },
    }
    expect((yield* post("start", payload)).status).toBe(503)
    const row = (yield* GoalControl.current(db, payload.sessionID))!
    expect(row.preparation).toBe("preparing")
    expect((yield* GoalControl.command(db, payload.sessionID, payload.requestID))?.wake_state).toBe("none")
    const store = DocumentStore.shared(GoalManager.goalStoreRoot(payload.sessionID))
    const refs = store.list({ type: "run_context" })
    expect(refs).toHaveLength(1)
    const before = store.get(refs[0]!.id)!
    yield* db.run(sql`DROP TRIGGER goal_activation_gap`).pipe(Effect.orDie)
    const retried = yield* post("start", payload)
    expect(retried.status).toBe(200)
    expect(yield* retried.json).toMatchObject({ goalId: row.goal_id, revision: 1, preparation: "ready" })
    expect(store.get(before.id)?.body).toBe(before.body)
    expect(store.get(before.id)?.version).toBe(before.version)
    expect(store.list({ type: "run_context" })).toHaveLength(1)
    expect(yield* db.get(sql`SELECT count(*) AS count FROM session_provider_attempt`).pipe(Effect.orDie)).toEqual({
      count: 0,
    })
  }),
)
