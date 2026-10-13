export * as WorkProviderDispatchFixture from "./work-provider-dispatch"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LLM, type LLMEvent } from "@deepagent-code/llm"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { Effect, Layer, Schema, Scope, Stream } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { FSUtil } from "../../src/fs-util"
import { AbsolutePath } from "../../src/schema"
import { LocationIdentity } from "../../src/context-federation/identity"
import { SessionContext } from "../../src/context-federation/session-context"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionInput } from "../../src/session/input"
import { SessionProjector } from "../../src/session/projector"
import { SessionStore } from "../../src/session/store"
import { SessionSchema } from "../../src/session/schema"
import { SessionRunnerCanonical } from "../../src/session/runner/canonical-turn"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"
import { WorkAdmission } from "../../src/session/work-admission"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { WorkAuthorityPolicy } from "../../src/session/work-authority-policy"
import { WorkProviderDispatch } from "../../src/session/work-provider-dispatch"
import { WorkRoutePolicy } from "../../src/session/work-route-policy"
import { Hash } from "../../src/util/hash"
import { CanonicalJson } from "../../src/util/canonical-json"
import { WorkAuthorityFixture } from "./work-authority"
import { EventInvestigationFixture } from "./event-investigation"
import { WorkRouteFixture } from "./work-route"
import { projectLayer } from "./project-layer"

export type Fixture = Awaited<ReturnType<typeof create>>
export type Context = Pick<Fixture, "root" | "filename" | "candidate" | "state">
export type Services =
  | Database.Service
  | SessionContext.Service
  | SessionV2.Service
  | EventV2.Service
  | SessionStore.Service
  | LocationIdentity.Service
  | V2ProviderTurn.Service
  | SessionProviderOwner.Service
  | Scope.Scope

export async function create(
  options: {
    counter?: (request: Request) => Promise<Response>
    onCancel?: () => void
    beforeTerminal?: () => Promise<void>
    profile?: "event" | "project"
    generation?: (turn: number) => Promise<Response>
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-provider-")))
  await fs.mkdir(path.join(root, "project"))
  const state = { mode: "complete", bodies: [] as string[], reads: 0, streams: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/responses/input_tokens" && options.counter)
        return options.counter(request)
      if (new URL(request.url).pathname !== "/v1/responses") throw new Error("Unexpected network path")
      state.bodies.push(await request.text())
      if (options.generation) return options.generation(state.bodies.length)
      if (state.mode === "drop")
        return new Response(
          'data: {"type":"response.output_text.delta","item_id":"msg_fixture","delta":"partial"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      if (state.mode === "wait")
        return new Response(
          new ReadableStream({
            cancel() {
              options.onCancel?.()
            },
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","item_id":"msg_fixture","delta":"partial"}\n\n',
                ),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      await options.beforeTerminal?.()
      const usage =
        state.mode === "missing-usage"
          ? undefined
          : {
              input_tokens: state.mode === "overrun" ? 42 : 41,
              output_tokens: 12,
              output_tokens_details: { reasoning_tokens: state.mode === "invalid-usage" ? 13 : 5 },
              total_tokens: state.mode === "overrun" ? 54 : 53,
            }
      const terminal = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", usage } })}\n\n`
      return new Response(
        'data: {"type":"response.output_text.delta","item_id":"msg_fixture","delta":"accepted"}\n\n' +
          terminal +
          (state.mode === "duplicate" ? terminal : ""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const original = WorkRouteFixture.candidate(`${server.url.origin}/v1/responses`)
  const binding = options.profile ? { ...EventInvestigationFixture.binding("dispatch-profile"),
    provider: original.binding.provider, auditedText: original.binding.auditedText,
    deadline: original.binding.deadline,
    budget: { ...WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget, maxCompletionTokens: 64 },
    ...(options.profile === "project" ? {
      profile: { id: "project_work_v1" as const, version: 1 as const, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
      source: { ...original.binding.source, kind: "server_operator" as const },
    } : {}),
  } : original.binding
  const profile = WorkAuthorityPolicy.profileFor(binding.profile)
  if (!profile) throw new Error("Fixture requires an exact known profile")
  const candidate = options.profile ? { ...original, binding,
    request: LLM.updateRequest(original.request, { system: profile.instructions }) } : original
  const filename = path.join(root, "authority.sqlite")
  await Effect.runPromise(
    WorkAuthorityFixture.initialize().pipe(Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped),
  )
  return {
    root,
    filename,
    candidate,
    state,
    server,
    async close() {
      server.stop(true)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

export async function open<A, E>(
  fixture: Context,
  body: Effect.Effect<A, E, Services>,
  options: { runtime?: boolean; evidence?: boolean; leaseMs?: number } = {},
) {
  const database = WorkAuthorityFixture.database(fixture.filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(Layer.mergeAll(database, events, store, SessionExecution.noopLayer, projectLayer(database))),
  )
  const contexts = SessionContext.layer.pipe(
    Layer.provide(Layer.mergeAll(database, SessionRunnerCanonical.degradedArtifactStore)),
  )
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const turns = V2ProviderTurn.layerWith({ leaseMs: options.leaseMs }).pipe(
    Layer.provide(Layer.mergeAll(database, owners)),
  )
  const read = <A>(name: string) =>
    Effect.gen(function* () {
      const row = yield* (yield* Database.Service).db
        .get<{ value: string }>(sql`SELECT value FROM test_dispatch_evidence WHERE id = ${name}`)
        .pipe(Effect.orDie)
      if (!row)
        return yield* new WorkAuthoritySchema.Error({
          code: "PROFILE_UNAVAILABLE",
          message: "Missing persisted fixture evidence",
        })
      return yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.value).pipe(
        Effect.map((value) => value as A),
        Effect.orDie,
      )
    })
  const runtime = Layer.effect(
    WorkProviderDispatch.Runtime,
    Effect.gen(function* () {
      const db = yield* Database.Service
      return {
        observe: () => read<WorkRoutePolicy.Runtime>("runtime").pipe(Effect.provideService(Database.Service, db)),
      }
    }),
  ).pipe(Layer.provide(database))
  const evidence = Layer.effect(
    WorkRoutePolicy.Evidence,
    Effect.gen(function* () {
      const db = yield* Database.Service
      return {
        resolve: () => read<WorkRoutePolicy.RouteEvidence>("route").pipe(Effect.provideService(Database.Service, db)),
        readCount: () =>
          read<WorkRoutePolicy.CountReceipt | WorkRoutePolicy.ProjectCountReceipt>("count").pipe(
            Effect.tap(() => Effect.sync(() => fixture.state.reads++)),
            Effect.provideService(Database.Service, db),
          ),
      }
    }),
  ).pipe(Layer.provide(database))
  return await Effect.runPromise(
    body.pipe(
      Effect.provide(
        Layer.mergeAll(
          database,
          events,
          store,
          sessions,
          contexts,
          owners,
          turns,
          SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(database, events))),
          LocationIdentity.layer.pipe(Layer.provide(Layer.mergeAll(database, FSUtil.defaultLayer))),
          WorkAuthorityFixture.verifier,
          ...(options.runtime === false ? [] : [runtime]),
          ...(options.evidence === false ? [] : [evidence]),
          LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
        ),
      ),
      Effect.scoped,
    ),
  )
}

export const admit = Effect.fn("WorkProviderDispatchFixture.admit")(function* (
  fixture: Context,
  options: { count?: boolean } = {},
) {
  const db = (yield* Database.Service).db
  const directory = path.join(fixture.root, "project")
  const identity = yield* (yield* LocationIdentity.Service).resolve({
    boundary: { kind: "implicit_local" },
    directory: AbsolutePath.make(directory),
    project: { kind: "registered_root", observedProjectId: "global" },
  })
  const namespace = fixture.candidate.binding.schemaVersion === "work-execution.v2"
    ? yield* db.get<{ binding_hash: string }>(sql`SELECT binding_hash FROM context_security_namespace
      WHERE id=${identity.securityNamespaceId}`) : undefined
  if (fixture.candidate.binding.schemaVersion === "work-execution.v2" && !namespace)
    throw new Error("Actual fixture namespace is missing")
  const binding = {
    ...fixture.candidate.binding,
    location: { directory },
    scope: {
      ...fixture.candidate.binding.scope,
      securityNamespaceID: identity.securityNamespaceId,
      projectScopeKey: identity.projectScopeKey,
    },
    ...(fixture.candidate.binding.schemaVersion === "work-execution.v2" ? {
      projectScope: { ...fixture.candidate.binding.projectScope, projectID: "global",
        canonicalRoot: directory, locationKey: identity.locationKey, namespaceBindingHash: namespace!.binding_hash },
    } : {}),
  }
  yield* db.run(
    sql`INSERT INTO test_work_route VALUES (${binding.provider.evidenceID}, ${binding.provider.evidenceHash}, ${binding.provider.configurationHash}, 1)`,
  )
  yield* db.run("CREATE TABLE test_dispatch_evidence (id text PRIMARY KEY, value text NOT NULL)")
  const wire = yield* WorkRouteFixture.encoded(fixture.candidate.request)
  for (const [id, value] of [
    ["runtime", fixture.candidate.runtime],
    ["route", fixture.candidate.evidence],
  ] as const)
    yield* db.run(sql`INSERT INTO test_dispatch_evidence VALUES (${id}, ${JSON.stringify(value)})`)
  yield* WorkAdmission.admitOnly({ binding, auditedText: WorkRouteFixture.TEXT, allowLoopbackHTTP: true })
  return { binding, wire }
})

export const initialize = Effect.fn("WorkProviderDispatchFixture.initialize")(function* (fixture: Context) {
  const { binding, wire } = yield* admit(fixture)
  const db = (yield* Database.Service).db
  const sessionID = SessionSchema.ID.make(binding.sessionID)
  yield* SessionInput.promoteNextQueued(db, yield* EventV2.Service, sessionID)
  const selected = yield* SessionRunnerCanonical.admitRestrictedSelection({
    db,
    contexts: yield* SessionContext.Service,
    sessionID,
    workID: binding.workID,
    expectedRevision: 1,
  })
  yield* (yield* SessionStore.Service).claim(sessionID)
  const committed = yield* SessionRunnerCanonical.commitTurn({
    db,
    contexts: yield* SessionContext.Service,
    sessionID,
    admission: selected.admission,
    ownerToken: yield* (yield* V2ProviderTurn.Service).currentOwnerToken(),
    receipt: {
      sessionId: sessionID,
      userMessageId: binding.inputID,
      historyPromptEpoch: 0,
      historySourceEndMessageId: binding.inputID,
      requestInputHash: Hash.sha256("fixture-real-encoded-request"),
      providerId: binding.provider.providerID,
      modelId: binding.provider.modelID,
      protocol: binding.provider.protocol,
      ownerMode: "v2",
    },
  })
  const dispatch = yield* WorkRouteFixture.dispatch(db, binding.workID, committed.receipt.receiptId)
  const legacyCount = WorkRouteFixture.receipt({ binding, wire, auditedText: WorkRouteFixture.TEXT,
    runtime: fixture.candidate.runtime,
    dispatch,
  }, fixture.candidate.evidence)
  const count = binding.schemaVersion === "work-execution.v2" ? yield* Effect.gen(function* () {
    const inspected = WorkRoutePolicy.inspect({ binding, wire, auditedText: WorkRouteFixture.TEXT,
      runtime: fixture.candidate.runtime }, { allowLoopbackHTTP: true })
    if (!inspected.ok) return yield* inspected.error
    const project = WorkRoutePolicy.projectCountBinding({ ...dispatch, project: {
      rootWorkID: binding.rootWorkID,
      turn: { key: Hash.sha256(CanonicalJson.stringify(["work-provider-turn.v1", binding.workID,
        committed.receipt.sessionId, committed.receipt.activityId, committed.receipt.providerTurnSeq])),
        activityID: committed.receipt.activityId, providerTurnSeq: committed.receipt.providerTurnSeq,
        contextSelectionID: selected.admission.selectionId, contextProjectionHash: selected.admission.projectionHash,
        historyPromptEpoch: committed.receipt.historyPromptEpoch,
        historySourceEndMessageID: committed.receipt.historySourceEndMessageId ?? null },
      predecessor: null, toolAdvertisementHash: inspected.value.toolAdvertisementHash,
    } }, fixture.candidate.evidence, inspected.value)
    if (!project) throw new Error("Actual fixture project count identity is missing")
    return { ...legacyCount, version: "native-project-count-receipt.v1" as const, binding: project }
  }) : legacyCount
  yield* db.run(sql`INSERT INTO test_dispatch_evidence VALUES ('count', ${JSON.stringify(count)})`)
  return { binding, selected, committed, wire, count }
})

export const prepare = (
  receipt: V2ProviderTurn.Receipt,
  selection: { selectionId: string; projectionHash: string },
  wireHash: string,
  instructions: string = WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions,
) =>
  V2ProviderTurn.prepare(
    {
      receipt,
      stableSystemParts: [instructions],
      volatileSystemParts: [],
      historyMessages: [{ role: "user", content: WorkRouteFixture.TEXT }],
      contextSelectionID: selection.selectionId,
      contextProjectionHash: selection.projectionHash,
      contextReadiness: "unavailable",
      contextSelectedRefs: [],
      activityID: receipt.activityId,
      providerTurnSeq: receipt.providerTurnSeq,
      toolDefinitions: [],
      toolIDs: [],
      toolChoice: null,
      toolResultReferences: [],
      samplingMaxOutputTokens: 32,
      budget: {
        decision: "ok",
        estimatedFullRequestTokens: 41,
        physicalInputBudget: 8192,
        reservedOutputTokens: 32,
        safetyMargin: 0,
        provenance: "host_guard",
      },
      userMessageID: receipt.userMessageId,
    },
    wireHash,
  )

export const execute = Effect.fn("WorkProviderDispatchFixture.execute")(function* (
  fixture: Context,
  data: Effect.Success<ReturnType<typeof initialize>>,
  request: ReturnType<typeof LLM.request> = fixture.candidate.request,
) {
  const events: LLMEvent[] = []
  fixture.state.streams++
  return yield* V2ProviderTurn.stream({
    service: yield* V2ProviderTurn.Service,
    receipt: data.committed.receipt,
    prepare: (wireHash) => prepare(data.committed.receipt, data.selected.admission, wireHash, data.selected.instructions),
    stream: LLMClient.stream(request).pipe(Stream.tap((event) => Effect.sync(() => events.push(event)))),
    outcomeArtifact: () => events,
    errorCode: () => "fixture_transport_failure",
  }).pipe(Stream.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Stream.runCollect)
})

/** A process can die after real HTTP dispatch but before the wrapper's finalizer. This helper
 * deliberately omits ONLY that outer finalizer to exercise canonical stale-owner recovery. */
export const unfinalized = Effect.fn("WorkProviderDispatchFixture.unfinalized")(function* (
  fixture: Context,
  data: Effect.Success<ReturnType<typeof initialize>>,
) {
  const service = yield* V2ProviderTurn.Service
  let current = data.committed.receipt
  fixture.state.streams++
  return yield* LLMClient.stream(fixture.candidate.request).pipe(
    Stream.provideService(RequestExecutor.CurrentRetryLimit, 0),
    Stream.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
    Stream.provideService(RequestExecutor.CurrentRequestSeal, {
      seal: (wire) =>
        service.seal(current, prepare(current, data.selected.admission, wire.wireHash), wire).pipe(
          Effect.tap((value) => Effect.sync(() => (current = value))),
          Effect.asVoid,
          Effect.orDie,
        ),
    }),
    Stream.tap(() =>
      current.state === "dispatching"
        ? service.markStreaming(current).pipe(Effect.tap((value) => Effect.sync(() => (current = value))))
        : Effect.void,
    ),
    Stream.runCollect,
  )
})

export const rows = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return {
    reservations: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM work_dispatch_reservation`),
    receipts: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM session_v2_provider_turn_receipt`),
    attempts: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM session_provider_attempt`),
    works: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM work_execution`),
  }
})
