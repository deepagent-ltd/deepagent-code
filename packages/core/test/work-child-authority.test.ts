import { expect, test } from "bun:test"
import { LLM, LLMEvent } from "@deepagent-code/llm"
import { count, eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Stream } from "effect"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { PermissionV2 } from "../src/permission"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { projectLayer } from "./fixture/project-layer"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { SessionInput } from "../src/session/input"
import { SessionStore } from "../src/session/store"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { SessionContext } from "../src/context-federation/session-context"
import { createLLMEventPublisher } from "../src/session/runner/publish-llm-event"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { Prompt } from "../src/session/prompt"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { WorkChildAuthority } from "../src/session/work-child-authority"
import { WorkChildAuthorityTable } from "../src/session/work-child-authority.sql"
import { WorkExecutionTable } from "../src/session/work-authority.sql"
import { WorkDispatchReservationTable } from "../src/session/work-authority.sql"
import { WorkRoutePolicy } from "../src/session/work-route-policy"
import { WorkToolPolicy } from "../src/session/work-tool-policy"
import { TaskRunAuthority } from "../src/session/task-run"
import { TaskRunTable } from "../src/session/sql"
import { V2ToolEffect } from "../src/session/runner/v2-tool-effect"
import { V2TaskRunReceiptTable } from "../src/session/runner/v2-task-run-receipt.sql"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { ToolRegistry } from "../src/tool/registry"
import { TaskTool } from "../src/tool/task"
import { admitTaskCall } from "../src/tool/task-policy"
import { ApplicationTools } from "../src/tool/application-tools"
import { ToolOutputStore } from "../src/tool-output-store"
import { Hash } from "../src/util/hash"
import { CanonicalJson } from "../src/util/canonical-json"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { EventInvestigationFixture } from "./fixture/event-investigation"
import { WorkProviderDispatchFixture } from "./fixture/work-provider-dispatch"
import { WorkRouteFixture } from "./fixture/work-route"

const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const binding = (): WorkAuthoritySchema.ProjectBinding => ({ ...EventInvestigationFixture.binding(),
  source: { ...EventInvestigationFixture.binding().source, kind: "server_operator" },
  profile: { id: "project_shared_root_v1", version: 1, hash: WorkAuthorityPolicy.SHARED_ROOT_PROFILE_HASH },
  toolPolicy: { ...EventInvestigationFixture.binding().toolPolicy,
    capabilities: [{ toolID: "task", definitionHash: "a".repeat(64), operations: ["delegate"] }] },
  budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget },
  provider: { ...EventInvestigationFixture.binding().provider,
    completion: { ...EventInvestigationFixture.binding().provider.completion, maxTokens: WorkAuthorityPolicy.PROJECT_PROFILE.budget.maxCompletionTokens } },
  childPolicy: { kind: "shared_root_v1", agents: ["explore"], toolIDs: [], maxConcurrent: 2,
    budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0, maxTotalTokens: 20_000 } },
})

test("shared-root profile is explicit and its derived child cannot broaden scope or delegate", () => {
  const parent = binding()
  expect(WorkAuthorityPolicy.validateBinding(parent).ok).toBe(true)
  expect(WorkAuthorityPolicy.validateBinding({ ...parent, profile: {
    id: "project_work_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH } }).ok).toBe(false)
  expect(WorkAuthorityPolicy.validateBinding({ ...parent, childPolicy: "deny_all" }).ok).toBe(false)
  const child = { ...parent, workID: "child-one", rootWorkID: parent.workID, parentWorkID: parent.workID,
    agentID: "explore", childPolicy: "deny_all" as const, budget: { ...parent.budget, maxChildren: 0, maxTotalTokens: 20_000 },
    toolPolicy: { ...parent.toolPolicy, capabilities: [] } }
  expect(WorkAuthorityPolicy.checkChild(parent, child).ok).toBe(true)
  expect(WorkAuthorityPolicy.checkChild(parent, { ...child, budget: { ...child.budget, maxTotalTokens: parent.budget.maxTotalTokens } }).ok).toBe(false)
  expect(WorkAuthorityPolicy.checkChild(parent, { ...child, agentID: "build" }).ok).toBe(false)
  expect(WorkAuthorityPolicy.checkChild(parent, { ...child, location: { directory: "/another-project" } }).ok).toBe(false)
  expect(WorkAuthorityPolicy.checkChild(parent, { ...child, toolPolicy: parent.toolPolicy }).ok).toBe(false)
})

test("a real canonical task receipt derives one durable child, retains its parent's live await and fences cancellation", async () => {
  const source = await WorkProviderDispatchFixture.create({ profile: "project" })
  const call = { description: "Known direct child", prompt: "Explain the approved project", subagent_type: "explore" }
  source.server.reload({ fetch: async (request) => {
    const body = await request.text()
    source.state.bodies.push(body)
    if (body.includes(call.prompt)) return new Response(
      'data: {"type":"response.output_text.delta","item_id":"child_text","delta":"Known child answer"}\n\n' +
      'data: {"type":"response.completed","response":{"id":"child_result","usage":{"input_tokens":41,"output_tokens":12,"output_tokens_details":{"reasoning_tokens":5}}}}\n\n',
      { headers: { "content-type": "text/event-stream" } })
    return new Response([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_child", call_id: "call_child", name: "task", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_child", delta: JSON.stringify(call) },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_child", call_id: "call_child", name: "task", arguments: JSON.stringify(call) } },
      { type: "response.completed", response: { id: "response_child", usage: { input_tokens: 41, output_tokens: 12,
        output_tokens_details: { reasoning_tokens: 5 } } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    await WorkProviderDispatchFixture.open(source, Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const events = yield* EventV2.Service
      const permissions = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })
      const registry = ToolRegistry.layer.pipe(Layer.provide(permissions), Layer.provide(ApplicationTools.layer),
        Layer.provide(ToolOutputStore.defaultLayer))
      const body = Effect.gen(function* () {
        yield* (yield* AgentV2.Service).update((editor) => editor.update(AgentV2.ID.make("explore"), (agent) => {
          agent.mode = "subagent"
          agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
        }))
        yield* Layer.build(TaskTool.layer)
        const materialization = yield* (yield* ToolRegistry.Service).materialize([{ action: "*", resource: "*", effect: "allow" }])
        const registered = ToolRegistry.inspect(materialization, "task")!
        expect(TaskTool.isNativeTask(registered.tool)).toBe(true)
        const root = { ...source.candidate.binding, ...binding(), location: source.candidate.binding.location,
          provider: source.candidate.binding.provider, source: { ...source.candidate.binding.source, kind: "server_operator" as const },
          auditedText: source.candidate.binding.auditedText, deadline: Date.now() + 100_000,
          toolPolicy: { ...binding().toolPolicy, capabilities: [{ toolID: "task", operations: ["delegate" as const], definitionHash: hash(registered.definition) }] },
          childPolicy: { kind: "shared_root_v1" as const, maxConcurrent: 2, agents: ["explore"], toolIDs: [],
            budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0, maxTotalTokens: 73,
              maxCompletionTokens: 32, maxDurationMs: 60_000 } },
          budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxTotalTokens: 256, maxCompletionTokens: 64 },
        } satisfies WorkAuthoritySchema.ProjectBinding
        const fixture = { ...source, candidate: { ...source.candidate, binding: root,
          request: LLM.updateRequest(source.candidate.request, { system: WorkAuthorityPolicy.SHARED_ROOT_PROFILE.instructions,
            tools: materialization.definitions }) } }
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        if (data.binding.schemaVersion !== "work-execution.v2") return yield* Effect.die("Missing shared project binding")
        const request = fixture.candidate.request
        // The canonical fixture prepares this exact real native advertisement, not a JSON grant.
        const prepare = (wireHash: string) => V2ProviderTurn.prepare({ receipt: data.committed.receipt,
          stableSystemParts: [data.selected.instructions], volatileSystemParts: [],
          historyMessages: [{ role: "user", content: WorkRouteFixture.TEXT }],
          contextSelectionID: data.selected.admission.selectionId, contextProjectionHash: data.selected.admission.projectionHash,
          contextReadiness: "unavailable", contextSelectedRefs: [], activityID: data.committed.receipt.activityId,
          providerTurnSeq: data.committed.receipt.providerTurnSeq, toolDefinitions: materialization.definitions,
          toolIDs: ["task"], toolChoice: null, toolResultReferences: [], samplingMaxOutputTokens: 32,
          userMessageID: data.committed.receipt.userMessageId,
          budget: { decision: "ok", estimatedFullRequestTokens: 41, physicalInputBudget: 8192,
            reservedOutputTokens: 32, safetyMargin: 0, provenance: "host_guard" } }, wireHash)
        const artifact: unknown[] = []
        const { LLMClient } = yield* Effect.promise(() => import("@deepagent-code/llm/route"))
        yield* V2ProviderTurn.stream({ service: yield* V2ProviderTurn.Service, receipt: data.committed.receipt, prepare,
          stream: LLMClient.stream(request).pipe(Stream.tap((event) => Effect.sync(() => artifact.push(event)))),
          outcomeArtifact: () => artifact, errorCode: () => "private_peer_failure" }).pipe(
          Stream.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Stream.runDrain)
        expect(source.state.bodies).toHaveLength(1)
        const context = { sessionID: SessionSchema.ID.make(data.binding.sessionID), agent: AgentV2.ID.make(data.binding.agentID),
          assistantMessageID: SessionMessage.ID.make("msg_real_task_call"), toolCallID: "call_child" }
        const effects = yield* V2ToolEffect.Service
        const admission = yield* effects.admit({ sessionId: context.sessionID, providerAttemptId: data.committed.receipt.providerAttemptId!,
          receiptId: data.committed.receipt.receiptId, toolCallId: context.toolCallID, toolName: "task", effectKind: "mutating",
          ownerToken: data.committed.receipt.ownerToken, now: Date.now() })
        const spec = { parentSessionID: context.sessionID, parentMessageID: context.assistantMessageID, toolCallID: context.toolCallID,
          deliveryMode: "foreground" as const, prompt: new Prompt({ text: call.prompt }), agent: "explore",
          child: { title: `task: ${call.description}`, location: { directory: AbsolutePath.make(data.binding.location.directory) }, permissions: [] } }
        const copied = yield* TaskRunAuthority.admitRun(db, spec).pipe(Effect.exit)
        expect(Exit.isFailure(copied)).toBe(true)
        expect((yield* db.select({ total: count() }).from(WorkChildAuthorityTable).get())?.total).toBe(0)
        const location = { directory: AbsolutePath.make(data.binding.location.directory),
          project: { id: Project.ID.make("global"), directory: AbsolutePath.make(data.binding.location.directory) } }
        const sessions = yield* SessionV2.Service
        const approved = yield* WorkChildAuthority.withAdmission({ binding: data.binding,
          controlRevision: 1, admission, context, location, materialization, input: call },
          Effect.gen(function* () {
            expect(Exit.isFailure(yield* WorkToolPolicy.requireCurrent(db, context.sessionID,
              { action: "write", resources: [call.subagent_type] }).pipe(Effect.exit))).toBe(true)
            expect(Exit.isFailure(yield* WorkToolPolicy.requireCurrent(db, context.sessionID,
              { action: "task", resources: ["another-agent"] }).pipe(Effect.exit))).toBe(true)
            expect(Exit.isFailure(yield* TaskRunAuthority.admitRun(db, { ...spec,
              prompt: new Prompt({ text: "A different child instruction" }) }).pipe(Effect.exit))).toBe(true)
            expect((yield* db.select({ total: count() }).from(WorkChildAuthorityTable).get())?.total).toBe(0)
            yield* WorkToolPolicy.requireCurrent(db, context.sessionID, { action: "task", resources: [call.subagent_type] })
            // The native leaf asserts permission BEFORE writing its task-call fan-out row.
            yield* admitTaskCall(db, { sessionID: context.sessionID, assistantMessageID: context.assistantMessageID, toolCallID: context.toolCallID })
            return yield* TaskRunAuthority.submit(db, events, sessions, spec)
          }))
        const retry = yield* TaskRunAuthority.submit(db, events, sessions, spec)
        expect(retry.exactRetry).toBe(true)
        expect(retry.run.runID).toBe(approved.run.runID)
        const child = (yield* WorkAuthority.lookupSession(db, approved.run.childSessionID))
        expect(child.kind).toBe("bound")
        if (child.kind !== "bound") return yield* Effect.die("Missing real derived child")
        expect(child.work.root_work_id).toBe(data.binding.workID)
        expect(child.work.admission_state).toBe("ready")
        expect(child.work.binding.childPolicy).toBe("deny_all")
        expect(child.work.binding.budget.maxChildren).toBe(0)
        yield* db.transaction((tx) => WorkToolPolicy.previous(tx, child.work), { behavior: "immediate" })
        expect((yield* db.select({ total: count() }).from(WorkChildAuthorityTable).get())?.total).toBe(1)
        expect((yield* db.select({ total: count() }).from(TaskRunTable).get())?.total).toBe(1)
        // This module oracle drives the original canonical provider/receipt/publisher and
        // TaskRun settlement directly. Process-global runner/Native acceptance is separate.
        const store = yield* SessionStore.Service
        const contexts = yield* SessionContext.Service
        const turns = yield* V2ProviderTurn.Service
        const capturedContext = yield* Effect.context<WorkProviderDispatchFixture.Services>()
        const resumes = { value: 0 }
        const drive = Effect.gen(function* () {
            const childID = SessionSchema.ID.make(child.work.session_id)
            const token = yield* store.claim(childID)
            if (!token) return yield* Effect.die("Child claim unavailable")
            yield* SessionInput.promoteNextQueued(db, events, childID)
            const selected = yield* SessionRunnerCanonical.admitRestrictedSelection({ db, contexts, sessionID: childID,
              workID: child.work.work_id, expectedRevision: 1 })
            const committed = yield* SessionRunnerCanonical.commitTurn({ db, contexts, sessionID: childID,
              admission: selected.admission, ownerToken: yield* turns.currentOwnerToken(), receipt: { sessionId: childID,
                userMessageId: child.work.input_id, historyPromptEpoch: 0, historySourceEndMessageId: child.work.input_id,
                requestInputHash: Hash.sha256("actual-child-request"), providerId: child.work.binding.provider.providerID,
                modelId: child.work.binding.provider.modelID, protocol: child.work.binding.provider.protocol, ownerMode: "v2" } })
            const request = LLM.request({ model: fixture.candidate.request.model,
              system: WorkAuthorityPolicy.SHARED_ROOT_PROFILE.instructions, prompt: call.prompt,
              generation: { maxTokens: 32 }, providerOptions: { openai: { store: false } } })
            const wire = yield* WorkRouteFixture.encoded(request)
            const dispatch = yield* WorkRouteFixture.dispatch(db, child.work.work_id, committed.receipt.receiptId)
            const input = { binding: child.work.binding, auditedText: call.prompt, wire, runtime: fixture.candidate.runtime, dispatch }
            const inspected = WorkRoutePolicy.inspect(input, { allowLoopbackHTTP: true })
            if (!inspected.ok) return yield* inspected.error
            const countBinding = WorkRoutePolicy.projectCountBinding({ ...dispatch, project: { rootWorkID: child.work.root_work_id,
              turn: { key: hash(["work-provider-turn.v1", child.work.work_id, childID, committed.receipt.activityId, committed.receipt.providerTurnSeq]),
                activityID: committed.receipt.activityId, providerTurnSeq: committed.receipt.providerTurnSeq,
                contextSelectionID: selected.admission.selectionId, contextProjectionHash: selected.admission.projectionHash,
                historyPromptEpoch: 0, historySourceEndMessageID: child.work.input_id }, predecessor: null,
              toolAdvertisementHash: inspected.value.toolAdvertisementHash } }, fixture.candidate.evidence, inspected.value)
            if (!countBinding) return yield* Effect.die("Child count binding missing")
            const receipt = { ...WorkRouteFixture.receipt(input, fixture.candidate.evidence),
              version: "native-project-count-receipt.v1", binding: countBinding }
            const { sql } = yield* Effect.promise(() => import("drizzle-orm"))
            yield* db.run(sql`INSERT INTO test_dispatch_evidence VALUES ('count',${JSON.stringify(receipt)}) ON CONFLICT(id) DO UPDATE SET value=excluded.value`)
            const publisher = createLLMEventPublisher(events, { sessionID: childID, agent: child.work.binding.agentID,
              model: ModelV2.Ref.make({ id: ModelV2.ID.make(child.work.binding.provider.modelID),
                providerID: ProviderV2.ID.make(child.work.binding.provider.providerID) }) })
            const artifact: LLMEvent[] = []
            yield* V2ProviderTurn.stream({ service: turns, receipt: committed.receipt,
              prepare: (wireHash) => V2ProviderTurn.prepare({ receipt: committed.receipt,
                stableSystemParts: [selected.instructions], volatileSystemParts: [], historyMessages: [{ role: "user", content: call.prompt }],
                contextSelectionID: selected.admission.selectionId, contextProjectionHash: selected.admission.projectionHash,
                contextReadiness: "unavailable", contextSelectedRefs: [], activityID: committed.receipt.activityId,
                providerTurnSeq: committed.receipt.providerTurnSeq, toolDefinitions: [], toolIDs: [], toolChoice: null,
                toolResultReferences: [], samplingMaxOutputTokens: 32, userMessageID: child.work.input_id,
                budget: { decision: "ok", estimatedFullRequestTokens: 41, physicalInputBudget: 8192, reservedOutputTokens: 32,
                  safetyMargin: 0, provenance: "host_guard" } }, wireHash),
              stream: LLMClient.stream(request).pipe(Stream.tap((event) => Effect.gen(function* () { artifact.push(event); yield* publisher.publish(event) }))),
              outcomeArtifact: () => artifact, errorCode: () => "private-child-peer" }).pipe(
                Stream.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Stream.runDrain)
            yield* publisher.flush()
            yield* db.transaction((tx) => Effect.gen(function* () {
              yield* WorkAuthority.completeInTransaction(tx, { workID: child.work.work_id, expectedRevision: 1,
                receiptID: committed.receipt.receiptId, assistantMessageID: publisher.currentAssistantMessageID()! })
              yield* contexts.settleActivity({ activityId: selected.admission.activityId, state: "settled", finalMessageId: publisher.currentAssistantMessageID()! })
            }), { behavior: "immediate" })
            yield* store.release(childID, token)
          }).pipe(Effect.tapCause((cause) => Effect.sync(() => console.error("CHILD_MODULE_FAILURE", Cause.pretty(cause)))), Effect.orDie)
        const registeredContext = yield* Layer.build(SessionV2.layer.pipe(Layer.provide(Layer.mergeAll(
          Layer.succeed(Database.Service, database), Layer.succeed(EventV2.Service, events),
          Layer.succeed(SessionStore.Service, store),
          projectLayer(Layer.succeed(Database.Service, database)),
          Layer.succeed(SessionExecution.Service, { active: Effect.succeed(new Set<SessionSchema.ID>()),
            resume: () => Effect.gen(function* () { resumes.value++; yield* drive }).pipe(Effect.provideContext(capturedContext)),
            wake: () => Effect.void, interrupt: () => Effect.void, awaitIdle: () => Effect.void }),
        )), Layer.fresh))
        const capturedSessions = Context.get(registeredContext, SessionV2.Service)
        ;(yield* TaskTool.DelegationSlot).service = capturedSessions
        const beforeResume = source.state.bodies.length
        const copiedService = yield* SessionV2.resumeTaskChild({ ...capturedSessions }, { sessionID: approved.run.childSessionID,
          runID: approved.run.runID, ownerToken: "copied", claimGeneration: 1 }).pipe(Effect.exit)
        expect(Exit.isFailure(copiedService)).toBe(true)
        const outsideFrame = yield* SessionV2.resumeTaskChild(capturedSessions, { sessionID: approved.run.childSessionID,
          runID: approved.run.runID, ownerToken: "outside", claimGeneration: 1 }).pipe(Effect.exit)
        expect(Exit.isFailure(outsideFrame)).toBe(true)
        const wrongChild = yield* WorkChildAuthority.withAdmission({ binding: data.binding, controlRevision: 1, admission,
          context, location, materialization, input: call }, SessionV2.resumeTaskChild(capturedSessions, {
            sessionID: SessionSchema.ID.make("ses_wrong_child"), runID: approved.run.runID, ownerToken: "wrong", claimGeneration: 1 })).pipe(Effect.exit)
        expect(Exit.isFailure(wrongChild)).toBe(true)
        expect(resumes.value).toBe(0)
        expect(source.state.bodies).toHaveLength(beforeResume)
        const recorded = yield* WorkChildAuthority.withAdmission({ binding: data.binding, controlRevision: 1, admission,
          context, location, materialization, input: call }, Effect.gen(function* () {
            expect(Exit.isFailure(yield* WorkChildAuthority.captureTaskOutput(db, Object.freeze({})).pipe(Effect.exit))).toBe(true)
            const actual = yield* materialization.settle({ sessionID: context.sessionID, agent: context.agent,
              assistantMessageID: context.assistantMessageID, call: LLMEvent.toolCall({ id: context.toolCallID, name: "task", input: call }), location })
            if (actual.result.type === "error") return yield* Effect.die(actual.result.value)
            expect(actual.result).toEqual({ type: "text", value: `Known child answer\ntask_id: "${child.work.session_id}"` })
            const terminal = { sessionId: context.sessionID, providerAttemptId: admission.providerAttemptId,
              receiptId: admission.receiptId, toolCallId: context.toolCallID, toolName: "task", effectKind: "mutating" as const,
              state: "settled" as const, outcomeHash: hash(actual.result), ownerToken: admission.ownerToken, now: Date.now() }
            if (data.binding.schemaVersion !== "work-execution.v2") return yield* Effect.die("Expected original project binding")
            const copiedFrame = { binding: data.binding, controlRevision: 1, admission, context, location, materialization,
              input: call, output: { taskRunID: approved.run.runID, hash: terminal.outcomeHash, consumed: false } }
            expect(Exit.isFailure(yield* WorkChildAuthority.withAdmission(copiedFrame, effects.record(terminal)).pipe(Effect.exit))).toBe(true)
            expect(Exit.isFailure(yield* effects.record({ ...terminal, outcomeHash: "a".repeat(64) }).pipe(Effect.exit))).toBe(true)
            expect(Exit.isFailure(yield* effects.record({ ...terminal, toolCallId: "call_other_admission" }).pipe(Effect.exit))).toBe(true)
            expect((yield* effects.listForSession(context.sessionID)).length).toBe(0)
            yield* db.transaction(() => Effect.gen(function* () {
              yield* WorkAuthority.control(db, { workID: data.binding.workID, requestID: "private-cancel-before-record",
                expectedRevision: 1, action: "cancel" })
              expect(Exit.isFailure(yield* effects.record(terminal).pipe(Effect.exit))).toBe(true)
              expect((yield* effects.listForSession(context.sessionID)).length).toBe(0)
              return yield* Effect.fail("rollback-private-current-root-cancel")
            })).pipe(Effect.exit)
            const original = yield* effects.record(terminal)
            expect(original.outcomeHash).toBe(hash(actual.result))
            expect((yield* effects.record(terminal)).effectId).toBe(original.effectId)
            expect(Exit.isFailure(yield* db.transaction((tx) => WorkChildAuthority.requireTaskSettlement(tx, {
              admissionID: admission.admissionId, sessionID: context.sessionID, receiptID: admission.receiptId,
              attemptID: admission.providerAttemptId, toolCallID: context.toolCallID, ownerToken: admission.ownerToken,
              outcomeHash: hash(actual.result) })).pipe(Effect.exit))).toBe(true)
            return original
          }))
        expect(recorded.toolName).toBe("task")
        expect((yield* effects.listForSession(context.sessionID)).length).toBe(1)
        expect(resumes.value).toBe(1)
        const actualRun = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, approved.run.runID)).get()
        if (!actualRun) return yield* Effect.die("Original TaskRun missing")
        const result = { outcome: actualRun.state, research: actualRun.output }
        expect(result.outcome).toBe("completed")
        expect(result.research).toBe("Known child answer")
        const parentWork = (yield* WorkAuthority.get(db, data.binding.workID))!
        yield* db.transaction((tx) => WorkChildAuthority.requireTerminal(tx, parentWork, {
          admissionID: admission.admissionId, inputHash: hash(call),
        }), { behavior: "immediate" })
        const proofControl = { workID: child.work.work_id, expectedRevision: 1 }
        expect((yield* db.transaction((tx) => WorkChildAuthority.requireTerminalProofControl(tx, proofControl))).work_id)
          .toBe(child.work.work_id)
        expect(Exit.isFailure(yield* db.transaction((tx) => WorkAuthority.requireCurrentControlInTransaction(tx, proofControl)).pipe(Effect.exit)))
          .toBe(true)
        expect(Exit.isFailure(yield* db.transaction((tx) => WorkChildAuthority.requireTerminalProofControl(tx, {
          workID: parentWork.work_id, expectedRevision: 1 })).pipe(Effect.exit))).toBe(true)
        for (const mutation of [
          (tx: WorkAuthority.Transaction) => tx.update(V2TaskRunReceiptTable).set({ child_session_id: "ses_other_child" })
            .where(eq(V2TaskRunReceiptTable.run_id, approved.run.runID)).run(),
          (tx: WorkAuthority.Transaction) => tx.update(TaskRunTable).set({ child_session_id: SessionSchema.ID.make("ses_other_child") })
            .where(eq(TaskRunTable.run_id, approved.run.runID)).run(),
          (tx: WorkAuthority.Transaction) => tx.update(WorkExecutionTable).set({ source_record_hash: "f".repeat(64) })
            .where(eq(WorkExecutionTable.work_id, child.work.work_id)).run(),
        ]) yield* db.transaction((tx) => Effect.gen(function* () {
          yield* mutation(tx)
          expect(Exit.isFailure(yield* WorkChildAuthority.requireTerminalProofControl(tx, proofControl).pipe(Effect.exit))).toBe(true)
          return yield* Effect.fail("rollback-private-proof-mismatch")
        })).pipe(Effect.exit)
        const charges = yield* db.select().from(WorkDispatchReservationTable)
        expect(charges.map((item) => item.charged_tokens).sort()).toEqual([53, 53])
        expect(charges.find((item) => item.work_id === child.work.work_id)?.reserved_total_tokens).toBe(73)
        expect(source.state.bodies).toHaveLength(2)
        yield* WorkAuthority.control(db, { workID: data.binding.workID, requestID: "cancel-real-parent",
          expectedRevision: 1, action: "cancel" })
        const cancelled = yield* db.transaction((tx) => WorkChildAuthority.requireCurrent(tx, child.work), { behavior: "immediate" }).pipe(Effect.exit)
        expect(Exit.isFailure(cancelled)).toBe(true)
        if (Exit.isFailure(cancelled)) expect(Cause.squash(cancelled.cause)).toBeInstanceOf(WorkAuthoritySchema.Error)
        expect(Exit.isFailure(yield* db.transaction((tx) => WorkChildAuthority.requireTerminalProofControl(tx, proofControl)).pipe(Effect.exit)))
          .toBe(true)
        expect(source.state.bodies).toHaveLength(2)
        expect((yield* db.select({ total: count() }).from(WorkChildAuthorityTable).get())?.total).toBe(1)
        console.info("WORK_CHILD_SAFE_FACTS", JSON.stringify({ generationRequests: source.state.bodies.length,
          countNetworkRequests: 0, counterEvidence: "controlled fixture service", derivedGrants: 1, taskRuns: 1,
          exactRetry: retry.exactRetry, childOutcome: (yield* WorkAuthority.get(db, child.work.work_id))?.outcome,
          taskOutcome: result.outcome, parentControl: (yield* WorkAuthority.get(db, data.binding.workID))?.control_state,
          rootCap: data.binding.budget.maxTotalTokens, childOwnCap: child.work.binding.budget.maxTotalTokens,
          charges: charges.map((item) => ({ scope: item.work_id === child.work.work_id ? "child" : "parent",
            state: item.state, reserved: item.reserved_total_tokens, charged: item.charged_tokens })),
          ordinaryGrant: false, terminalSQL: false, processGlobalRunnerAcceptance: false, nativeProductAcceptance: false }))
      }).pipe(Effect.provide(registry), Effect.provide(permissions),
        Effect.provide(AgentV2.layer), Effect.provide(TaskTool.delegationSlotLayer), Effect.provideService(Database.Service, database))
      yield* body.pipe(Effect.provide(V2ToolEffect.layer))
    }))
  } finally { await source.close() }
}, 15_000)
