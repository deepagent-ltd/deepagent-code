import { afterAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { decode } from "effect/unstable/encoding/Sse"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import type { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { SessionV2 } from "@deepagent-code/core/session"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, planScope } from "@deepagent-code/core/deepagent/plan-controller"
import { Hash } from "@deepagent-code/core/util/hash"
import { createRuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { EventRouteRef, InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { Session } from "../../src/session/session"
import { SessionRevert } from "../../src/session/revert"
import { SessionSteer } from "../../src/session/steer"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { LSP } from "../../src/lsp/lsp"
import { BackgroundJob } from "../../src/background/job"
import { InstanceStore } from "../../src/project/instance-store"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { makeGoalTickPort } from "../../src/session/goal-tick-port"
import { GoalTickProjection } from "../../src/session/goal-tick-projection"
import type { InstanceContext } from "../../src/project/instance-context"
import { EventApi } from "../../src/server/routes/instance/httpapi/groups/event"
import { eventHandlers } from "../../src/server/routes/instance/httpapi/handlers/event"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"

// This fixture isolates the completed runtime adapter. It does not execute a model,
// mint a Native execution proof, or qualify a live Goal. Publisher, file SQL authority,
// EventV2Bridge and the production strict-directory SSE handler remain real.
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-route-test-")))
afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

for (const staleRoute of [false, true]) {
  test(`owned committed publisher retains its actual directory from a cold fiber (stale route ${staleRoute})`, async () => {
    const root = path.join(scratch, staleRoute ? "stale" : "cold")
    await fs.mkdir(root)
    const directory = path.join(root, "project")
    const otherDirectory = path.join(root, "other-project")
    await Promise.all([directory, otherDirectory].map((value) => fs.mkdir(value)))
    const ctx: InstanceContext = {
      directory,
      worktree: directory,
      project: {
        id: ProjectV2.ID.make("route-project"),
        worktree: directory,
        sandboxes: [],
        time: { created: 1, updated: 1 },
      },
    }
    const other: InstanceContext = {
      ...ctx,
      directory: otherDirectory,
      worktree: otherDirectory,
    }
    const database = Database.layerFromPath(path.join(root, "authority.sqlite"))
    const nativeEvents = EventV2.layer.pipe(Layer.provide(database))
    const bridge = EventV2Bridge.layerWithRuntimeFeatures(createRuntimeFeatureRegistry(undefined, {})).pipe(
      Layer.provideMerge(nativeEvents),
      Layer.provideMerge(database),
    )
    const common = Layer.mergeAll(
      bridge,
      RuntimeFlags.layer({
        v4MultiAgentRuntime: false,
        v4GoalTickEventDriven: true,
      }),
      Layer.mock(BackgroundJob.Service)({}),
    )
    // These execution-only services are tripwires, as in the existing Goal API
    // fixture; the owned runtime adapter never invokes a legacy model/tool path.
    const services = Layer.mergeAll(
      common,
      Session.layer.pipe(Layer.provide(common)),
      DeepAgentEventBus.layerWith().pipe(Layer.provide(database)),
      ApprovalQueue.layer.pipe(Layer.provide(database)),
      Layer.mock(Agent.Service)({}),
      Layer.mock(SessionRevert.Service)({}),
      Layer.mock(SessionSteer.Service)({}),
      Layer.mock(Provider.Service)({}),
      Layer.mock(LSP.Service)({}),
      Layer.mock(SessionV2.Service)({}),
      Layer.mock(InstanceStore.Service)({ load: () => Effect.succeed(ctx) }),
      Layer.mock(SessionExecution.Service)({}),
      Layer.mock(SessionRuntimeStatus.Service)({}),
    )
    const middleware = Layer.mergeAll(
      Layer.succeed(
        Authorization,
        Authorization.of((effect) => effect),
      ),
      Layer.succeed(
        WorkspaceRoutingMiddleware,
        WorkspaceRoutingMiddleware.of((effect) =>
          effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory })),
        ),
      ),
      Layer.succeed(
        InstanceContextMiddleware,
        InstanceContextMiddleware.of((effect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const requested = request.headers["x-deepagent-code-directory"]
            if (requested !== directory && requested !== otherDirectory)
              return yield* Effect.die("Unknown fixture directory")
            return yield* effect.pipe(
              Effect.provideService(InstanceRef, requested === directory ? ctx : other),
              Effect.provideService(WorkspaceRef, undefined),
            )
          }),
        ),
      ),
    )
    const transport = HttpServer.layerTestClient.pipe(
      Layer.provide(
        Layer.fresh(FetchHttpClient.layer).pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
        ),
      ),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    )
    const server = HttpRouter.serve(
      HttpApiBuilder.layer(EventApi).pipe(
        Layer.provide(eventHandlers),
        Layer.provide(middleware),
        Layer.provide(services),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provideMerge(transport), Layer.provideMerge(services))
    const stateDir = path.join(root, "state")
    const sessionState = AgentGateway.DeepAgentSessionState.createRuntime(stateDir)
    const planState = AgentGateway.DeepAgentPlanStore.createRuntime(stateDir)
    await AgentGateway.DeepAgentSessionState.withRuntime(sessionState, () =>
      AgentGateway.DeepAgentPlanStore.withRuntime(planState, () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const built = yield* Layer.build(server)
              return yield* Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const events = yield* EventV2Bridge.Service
                const sessionID = `ses_owned_route_${staleRoute ? "stale" : "cold"}`
                const graphRoot = path.join(stateDir, "goal", sessionID, "graph")
                const store = DocumentStore.shared(graphRoot)
                const doc = store.upsert({
                  type: "plan",
                  scope: planScope(sessionID),
                  description: `session plan ${sessionID}`,
                  idSlug: `plan-${sessionID}`,
                  body: JSON.stringify(
                    createPlanDoc(sessionID, "Synthetic route observation", [
                      {
                        step_id: "step_1",
                        title: "Retain independent gap",
                        status: "active",
                        acceptance: null,
                        assigned_agent: null,
                        evidence: [],
                        note: null,
                      },
                    ]),
                  ),
                  provenance: {
                    source: "runner",
                    run_ref: planScope(sessionID),
                  },
                })
                yield* db.run(
                  sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('route-project',${directory},1,1,'[]')`,
                )
                yield* db.run(
                  sql`INSERT INTO session (id,project_id,slug,directory,title,version,v2_authority,time_created,time_updated) VALUES (${sessionID},'route-project',${sessionID},${directory},'Synthetic route fixture','2',1,1,1)`,
                )
                const spec = {
                  planDocId: doc.id,
                  criteria: [{ kind: "plan_complete" as const }],
                  limits: {
                    maxTicks: 3,
                    maxTokens: 1000,
                    maxWallclockMs: 60000,
                  },
                  stallThreshold: 3,
                }
                const initialization = yield* GoalTickProjection.prepare(db, {
                  directory: graphRoot,
                  sessionID,
                  requestID: "start-route-fixture",
                  plan: JSON.parse(doc.body),
                  spec,
                  model: {
                    providerID: "never-called",
                    modelID: "never-called",
                  },
                  netTokenBudget: false,
                  panel: {
                    question: "No model route fixture",
                    lenses: ["correctness"],
                    codeRefs: [],
                  },
                })
                const input = {
                  sessionID,
                  requestID: "start-route-fixture",
                  requestHash: Hash.sha256(sessionID),
                  planDocId: doc.id,
                  driverMode: "event" as const,
                  initialization,
                }
                const prepared = yield* GoalControl.reserveStart(db, input)
                yield* GoalTickProjection.initialize(db, {
                  row: prepared.row,
                  requestID: input.requestID,
                  requestHash: input.requestHash,
                  directory: graphRoot,
                })
                const runtime = GoalTickState.requireState({
                  version: 2,
                  goalId: prepared.row.goal_id,
                  sessionId: sessionID,
                  planDocId: doc.id,
                  spec,
                  phase: "needs_human",
                  ledger: {
                    ticks: 1,
                    tokens: 17,
                    cost: 0,
                    costComplete: false,
                    wallclockMs: 10,
                    startedAtMs: 1,
                  },
                  stallCount: 1,
                  lastFingerprint: null,
                  lastDoneCount: 0,
                  lastEvidenceCount: 0,
                  lastMetCount: 0,
                  lastProcessedVersion: 2,
                  lastOutcome: "needs_human",
                  gaps: ["synthetic independently settled gap"],
                  lastDeliveredFeedback: [],
                  pendingSteers: [],
                  budgetTokenScope: "gross",
                  lastTransitionHash: null,
                  haltReason: null,
                })
                const received: Array<{ type: string; location: unknown }> = []
                yield* events.listen((event) =>
                  Effect.sync(() => {
                    if (event.type === "goal.updated")
                      received.push({
                        type: event.type,
                        location: event.location,
                      })
                  }),
                )
                const open = (target: string) =>
                  Effect.gen(function* () {
                    const response = yield* HttpClientRequest.get("/event").pipe(
                      HttpClientRequest.setHeader("x-deepagent-code-directory", target),
                      HttpClient.execute,
                    )
                    expect(response.status).toBe(200)
                    const queue = yield* Queue.unbounded<{
                      type: string
                      properties: Record<string, unknown>
                    }>()
                    yield* response.stream.pipe(
                      Stream.decodeText(),
                      Stream.pipeThroughChannel(decode()),
                      Stream.runForEach((event) =>
                        Queue.offer(
                          queue,
                          Schema.decodeUnknownSync(
                            Schema.Struct({
                              type: Schema.String,
                              properties: Schema.Record(Schema.String, Schema.Unknown),
                            }),
                          )(JSON.parse(event.data)),
                        ),
                      ),
                      Effect.forkScoped,
                    )
                    const read = () =>
                      Queue.take(queue).pipe(
                        Effect.timeoutOrElse({
                          duration: "300 millis",
                          orElse: () => Effect.succeed(null),
                        }),
                      )
                    expect(yield* read()).toMatchObject({
                      type: "server.connected",
                    })
                    return read
                  })
                const mainRead = yield* open(directory),
                  otherRead = yield* open(otherDirectory)
                const port = makeGoalTickPort({
                  db,
                  events,
                  sessions: yield* Session.Service,
                  agents: yield* Agent.Service,
                  revert: yield* SessionRevert.Service,
                  steerBuffer: yield* SessionSteer.Service,
                  provider: yield* Provider.Service,
                  lsp: yield* LSP.Service,
                  instanceStore: yield* InstanceStore.Service,
                  eventBus: yield* DeepAgentEventBus.Service,
                  approvalQueue: yield* ApprovalQueue.Service,
                  flags: yield* RuntimeFlags.Service,
                  v2Session: yield* SessionV2.Service,
                  goalStoreRoot: () => graphRoot,
                  runOwned: ({ permitID }) =>
                    Effect.gen(function* () {
                      const permit = (yield* GoalTickCheckpoint.currentPermit(db, permitID)).permit
                      yield* GoalControl.settleTick(db, {
                        permit,
                        nextSeq: 1,
                        planVersion: 2,
                        phase: "needs_human",
                      })
                      // A complete typed in-memory runtime result, not a durable
                      // checkpoint or a claim that the synthetic worker executed.
                      const journal = {
                        ...GoalTickProgram.reservation(
                          {
                            version: 2,
                            contract: "owned-goal-v2",
                            roles: [
                              {
                                key: "worker.0",
                                agent: "worker",
                                kind: "worker",
                                ordinal: 0,
                                criterion: null,
                                round: null,
                                lens: null,
                                mode: "plain",
                                policyHash: Hash.sha256("synthetic route policy"),
                                recipe: {
                                  id: "goal-worker-v2",
                                  hash: Hash.sha256("synthetic route recipe"),
                                  schemaHash: Hash.sha256("synthetic output"),
                                  dependencies: [],
                                },
                              },
                            ],
                            documents: [],
                            localEffectSlots: 0,
                            nextStateBytes: 4096,
                          },
                          {
                            sessionID,
                            sourceSeq: 0,
                            authorityHash: Hash.sha256("synthetic parent"),
                            authority: "{}",
                            steering: { cutoff: 0, mutationEpoch: 0, rows: [] },
                          },
                        ).empty,
                        nextState: JSON.stringify(runtime),
                        nextStateHash: Hash.sha256(JSON.stringify(runtime)),
                      }
                      return {
                        permit_id: permit.permit_id,
                        goal_id: permit.goal_id,
                        tick_seq: permit.tick_seq,
                        version: 2,
                        revision: 0,
                        binding_hash: Hash.sha256("synthetic binding"),
                        role_manifest_hash: GoalTickProgram.hash(journal.program),
                        parent_checked_through_seq: 0,
                        state: "committed",
                        journal,
                        journal_hash: GoalTickProgram.hash(journal),
                        logical_bytes: Buffer.byteLength(JSON.stringify(journal)),
                        reserved_bytes: GoalTickProgram.MAX_BYTES,
                        error_code: null,
                        created_at: 1,
                        updated_at: 1,
                      } satisfies GoalTickCheckpointV2.Row
                    }).pipe(Effect.orDie),
                })
                const outcome = yield* port({
                  sessionID,
                  goalId: prepared.row.goal_id,
                  planDocId: doc.id,
                  revision: 1,
                  seq: 0,
                  expectedPlanVersion: doc.version,
                }).pipe(
                  Effect.provideService(InstanceRef, undefined),
                  Effect.provideService(WorkspaceRef, undefined),
                  Effect.provideService(EventRouteRef, staleRoute ? other : undefined),
                )
                expect(outcome).toMatchObject({
                  progress: "terminal",
                  nextSeq: 1,
                })
                const packets = []
                for (let n = 0; n < 3; n++) {
                  const packet = yield* mainRead()
                  if (!packet) break
                  packets.push(packet)
                  if (packet.type === "goal.updated") break
                }
                const packet = packets.find((value) => value.type === "goal.updated")
                expect({ packet, received }).toMatchObject({
                  packet: {
                    type: "goal.updated",
                    properties: {
                      sessionID,
                      phase: "needs_human",
                      ledger: { ticks: 1, tokens: 17 },
                      gaps: runtime.gaps,
                    },
                  },
                  received: [{ type: "goal.updated", location: { directory } }],
                })
                expect(yield* otherRead()).toBeNull()
                expect(
                  (yield* GoalControl.snapshot(db, (yield* GoalControl.get(db, prepared.row.goal_id))!)).phase,
                ).toBe("needs_human")
              }).pipe(Effect.provideContext(built))
            }),
          ),
        ),
      ),
    )
  }, 15000)
}
