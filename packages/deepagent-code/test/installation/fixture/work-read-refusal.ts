// Controlled SQL/capability boundary, not a provider or Native execution claim. Actual registry,
// Work admission, host MAC sealer, durable terminal and cold verifier run without network IO.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-work-read-refusal-"))
process.env.DEEPAGENT_CODE_TEST_HOME = directory
await import("@deepagent-code/core/session")
const { Database } = await import("@deepagent-code/core/database/database")
const { WorkProviderDispatchFixture } = await import("../../../../core/test/fixture/work-provider-dispatch")
const { WorkRouteFixture } = await import("../../../../core/test/fixture/work-route")
const { LLM, LLMEvent } = await import("@deepagent-code/llm")
const { EventV2 } = await import("@deepagent-code/core/event")
const { ModelV2 } = await import("@deepagent-code/core/model")
const { ProviderV2 } = await import("@deepagent-code/core/provider")
const { RequestExecutor } = await import("@deepagent-code/llm/route")
const { V2ProviderTurn } = await import("@deepagent-code/core/session/runner/v2-provider-turn")
const { createLLMEventPublisher } = await import("@deepagent-code/core/session/runner/publish-llm-event")
const { WorkAuthorityFixture } = await import("../../../../core/test/fixture/work-authority")
const { EventInvestigationFixture } = await import("../../../../core/test/fixture/event-investigation")
const { WorkAuthority } = await import("@deepagent-code/core/session/work-authority")
const { WorkAuthorityPolicy } = await import("@deepagent-code/core/session/work-authority-policy")
const { WorkFileCapability } = await import("@deepagent-code/core/session/work-file-capability")
const { WorkToolPolicy } = await import("@deepagent-code/core/session/work-tool-policy")
const { V2ToolEffect } = await import("@deepagent-code/core/session/runner/v2-tool-effect")
const { SessionMessage } = await import("@deepagent-code/core/session/message")
const { SessionSchema } = await import("@deepagent-code/core/session/schema")
const { AgentV2 } = await import("@deepagent-code/core/agent")
const { Project } = await import("@deepagent-code/core/project")
const { AbsolutePath } = await import("@deepagent-code/core/schema")
const { ToolRegistry } = await import("@deepagent-code/core/tool/registry")
const { ReadTool } = await import("@deepagent-code/core/tool/read")
const { FileSystem } = await import("@deepagent-code/core/filesystem")
const { Image } = await import("@deepagent-code/core/image")
const { PermissionV2 } = await import("@deepagent-code/core/permission")
const { CanonicalJson } = await import("@deepagent-code/core/util/canonical-json")
const { Hash } = await import("@deepagent-code/core/util/hash")
const { LocalAuthority } = await import("../../../src/installation/local-authority")
const { WorkLeafProof } = await import("../../../src/installation/work-leaf-proof")
const database = WorkAuthorityFixture.database(path.join(directory, "authority.sqlite"))
const mode = process.argv[2] ?? "known"
const state = { reads: 0, filesystem: 0, permission: 0, nativeCurrent: mode !== "native_unknown", stage: "init",
  readOptions: undefined as { offset: number; bytes: number; scanLimit: number } | undefined }
const files = Layer.succeed(WorkFileCapability.Service, {
  open: () => Effect.acquireRelease(Effect.promise(() => fs.open(directory, "r")).pipe(
    Effect.map((file) => Object.freeze({ file }) as unknown as import("@deepagent-code/core/session/work-file-capability").Root)),
    (root) => Effect.promise(() => (root as unknown as { file: FileHandle }).file.close())),
  current: () => state.nativeCurrent ? Effect.void : Effect.fail(new WorkFileCapability.Error({ code: "WORK_FILE_CHANGED", message: "Controlled current failure" })),
  read: (_root, input) => {
    state.reads++
    state.readOptions = { offset: input.offset, bytes: input.bytes, scanLimit: input.scanLimit }
    if (mode !== "default") return Effect.fail(new WorkFileCapability.Error({ code: "WORK_FILE_UNKNOWN", message: "No native read in this fixture" }))
    // Controlled IO port: exercise the real registry/admission/defaulting path and
    // actual owned file bytes. This branch does not seal a Native read proof.
    return Effect.promise(async () => ({ text: (await fs.readFile(path.join(directory, input.relative))).subarray(input.offset, input.offset + input.bytes).toString(),
      next: null, observation: Object.freeze({}) as import("@deepagent-code/core/session/work-file-capability").Observation }))
  },
  describe: () => undefined, live: () => ({ helpers: 0, queued: 0, inFlight: 0, observations: 0 }),
})
const unused = () => Effect.sync(() => { state.filesystem++; throw new Error("Ordinary filesystem must not execute") })
const filesystem = Layer.succeed(FileSystem.Service, { read: unused, resolveReadPath: unused, readTool: unused,
  resolveRoot: unused, list: unused, resolveList: unused, listResolved: unused, listPage: unused,
  listPageResolved: unused, find: unused, grep: unused, isIgnored: () => false })
const permission = Layer.succeed(PermissionV2.Service, { assert: () => Effect.sync(() => { state.permission++ }).pipe(Effect.andThen(mode === "permission_denied"
    ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void)),
  ask: () => Effect.die("unused"), reply: () => Effect.die("unused"), get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"), list: () => Effect.die("unused") })
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const dependencies = Layer.mergeAll(files, registry, filesystem, permission,
  Layer.succeed(Image.Service, { normalize: () => Effect.die("unused") }))
const layer = Layer.mergeAll(dependencies, ReadTool.layer.pipe(Layer.provide(dependencies)),
  WorkLeafProof.layer.pipe(Layer.provide(dependencies)), V2ToolEffect.layer)
const canonical = (input: unknown) => Hash.sha256(CanonicalJson.stringify(input))
try {
  await fs.mkdir(path.join(directory, "project"))
  if (mode === "default") await fs.writeFile(path.join(directory, "input.ts"), "hello", { mode: 0o600 })
  await Effect.runPromise(LocalAuthority.initializeInstallation())
  await Effect.runPromise(WorkAuthorityFixture.initialize().pipe(Effect.provide(database), Effect.scoped))
  const fixture = { root: directory, filename: path.join(directory, "authority.sqlite"), candidate: WorkRouteFixture.candidate(),
    state: { bodies: [] as string[], reads: 0, streams: 0, mode: "complete" } }
  const original = await WorkProviderDispatchFixture.open(fixture, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const materialization = yield* (yield* ToolRegistry.Service).materialize([{ action: "*", resource: "*", effect: "allow" }])
    const registered = ToolRegistry.inspect(materialization, "read")!
    const root = yield* Effect.promise(() => fs.stat(path.join(directory, "project"), { bigint: true }))
    const source = EventInvestigationFixture.binding("read-refusal")
    const candidate = { ...fixture.candidate, binding: { ...source, provider: fixture.candidate.binding.provider,
      source: { ...source.source, kind: "server_operator" as const },
      profile: { id: "project_work_v1" as const, version: 1 as const, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
      projectScope: { ...source.projectScope, rootIdentity: { kind: "posix" as const, device: String(root.dev), inode: String(root.ino) } },
      auditedText: fixture.candidate.binding.auditedText,
      toolPolicy: { ...source.toolPolicy,
        fileScope: { ...source.toolPolicy.fileScope, ...(mode === "default" ? { maxReadBytes: 7, maxHashBytes: 5 } : mode === "zero_budget" ? { maxReadBytes: 0 } : {}) },
        capabilities: [{ toolID: "read", operations: ["read" as const], definitionHash: canonical(registered.definition) }] },
      budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxCompletionTokens: 64 }, deadline: Date.now() + 100_000 },
      request: LLM.updateRequest(fixture.candidate.request, { system: WorkAuthorityPolicy.PROJECT_PROFILE.instructions, tools: materialization.definitions }) }
    state.stage = "initialize"
    const data = yield* WorkProviderDispatchFixture.initialize({ ...fixture, candidate })
    const binding = data.binding
    if (binding.schemaVersion !== "work-execution.v2") throw new Error("Missing controlled project Work")
    const receiptID = data.committed.receipt.receiptId
    const input = mode === "permission_denied" ? { path: "input.ts", byteOffset: 0, pageBytes: 51200 }
      : mode === "default" || mode === "zero_budget" ? { path: "input.ts" } : { path: "." }
    const call = LLMEvent.toolCall({ id: "call_refused", name: "read", input })
    const ending = LLMEvent.finish({ reason: "tool-calls", usage: { inputTokens: 41, outputTokens: 12, totalTokens: 53 } })
    const artifact = [call, ending]
    const turns = yield* V2ProviderTurn.Service
    const prepared = V2ProviderTurn.prepare({ receipt: data.committed.receipt,
      stableSystemParts: [data.selected.instructions], volatileSystemParts: [],
      historyMessages: [{ role: "user", content: WorkRouteFixture.TEXT }],
      userMessageID: binding.inputID, activityID: data.committed.receipt.activityId,
      providerTurnSeq: data.committed.receipt.providerTurnSeq,
      contextSelectionID: data.selected.admission.selectionId, contextProjectionHash: data.selected.admission.projectionHash,
      contextReadiness: "unavailable", contextSelectedRefs: [], toolDefinitions: materialization.definitions,
      toolIDs: ["read"], toolChoice: null, toolResultReferences: [], samplingMaxOutputTokens: 32,
      budget: { decision: "ok", estimatedFullRequestTokens: 41, physicalInputBudget: 8192, reservedOutputTokens: 32,
        safetyMargin: 0, provenance: "host_guard" } }, data.wire.wireHash)
    state.stage = "controlled-turn"
    const sealed = yield* turns.seal(data.committed.receipt, prepared, data.wire).pipe(Effect.provideService(RequestExecutor.CurrentRetryLimit, 0), Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"))
    const streaming = yield* turns.markStreaming(sealed)
    yield* turns.settle({ receipt: streaming, outcome: "settled", outcomeArtifact: artifact })
    const publisher = createLLMEventPublisher(yield* EventV2.Service, { sessionID: SessionSchema.ID.make(binding.sessionID),
      agent: binding.agentID, model: ModelV2.Ref.make({ id: ModelV2.ID.make(binding.provider.modelID), providerID: ProviderV2.ID.make(binding.provider.providerID) }) })
    yield* publisher.publish(call)
    yield* publisher.publish(ending)
    yield* publisher.flush()
    const context = { sessionID: SessionSchema.ID.make(binding.sessionID), agent: AgentV2.ID.make(binding.agentID),
      assistantMessageID: publisher.currentAssistantMessageID()!, toolCallID: call.id }
    const effects = yield* V2ToolEffect.Service
    const admission = yield* effects.admit({ sessionId: binding.sessionID, providerAttemptId: data.committed.receipt.providerAttemptId!,
      receiptId: receiptID, toolCallId: call.id, toolName: "read", effectKind: "read_only", ownerToken: data.committed.receipt.ownerToken, now: Date.now() })
    const location = { directory: AbsolutePath.make(binding.location.directory), project: { id: Project.ID.make(binding.projectScope.projectID), directory: AbsolutePath.make(binding.location.directory) } }
    state.stage = "registry"
    const settlement = yield* WorkToolPolicy.withAdmission(db, { binding, controlRevision: 1, admission, context,
      location, materialization, input }, Effect.gen(function* () {
      const result = yield* materialization.settle({ ...context, call })
      if (mode === "default") {
        assert.notEqual(result.result.type, "error")
        assert.deepEqual(input, { path: "input.ts" })
        assert.deepEqual(state.readOptions, { offset: 0, bytes: 5, scanLimit: 5 })
        assert.equal(state.reads, 1); assert.equal(state.filesystem, 0); assert.equal(state.permission, 1)
        assert.equal(WorkToolPolicy.readRefusalReason({ path: "input.ts" }, binding), "invalid_pagination")
        for (const invalid of [{ byteOffset: -1 }, { pageBytes: 0 }, { pageBytes: 51201 }, { offset: 0 }, { limit: 1 }, { reference: {} }])
          assert.equal(WorkToolPolicy.readRefusalReason({ path: "input.ts", ...invalid }, binding), "invalid_pagination")
        assert.equal(WorkToolPolicy.readRefusalReason({ path: "../input.ts" }, binding), "invalid_path")
        return { kind: "default" as const }
      }
      if (mode === "permission_denied") {
        assert.equal(result.result.type, "error")
        assert.equal(yield* WorkToolPolicy.isKnownRefusal(result.result), false)
        assert.equal(Exit.isFailure(yield* WorkToolPolicy.sealCurrent(canonical(result.result)).pipe(Effect.exit)), true)
        return { kind: "unknown" as const }
      }
      assert.deepEqual(result.result, { type: "error", value: WorkToolPolicy.READ_REFUSED })
      assert.equal(yield* WorkToolPolicy.isKnownRefusal(result.result), true)
      const outcomeHash = canonical(result.result)
      assert.equal(Exit.isFailure(yield* WorkToolPolicy.describeKnownRead(Object.freeze({}) as import("@deepagent-code/core/session/work-tool-policy").Witness, outcomeHash).pipe(Effect.exit)), true)
      const record = yield* effects.record({ sessionId: binding.sessionID, providerAttemptId: data.committed.receipt.providerAttemptId!,
        receiptId: receiptID, toolCallId: call.id, toolName: "read", effectKind: "read_only", state: "settled",
        outcomeHash, ownerToken: admission.ownerToken, now: Date.now() })
      return { kind: "known" as const, result, record }
    }).pipe(Effect.exit))
    if (mode === "default") {
      assert.equal(Exit.isSuccess(settlement) && settlement.value.kind, "default")
      assert.equal((yield* db.get<{ count: number }>("SELECT count(*) count FROM session_v2_tool_effect"))?.count, 0)
      return { kind: "default" as const }
    }
    if (mode !== "known" && mode !== "zero_budget") {
      if (mode === "native_unknown") assert.equal(Exit.isFailure(settlement), true)
      if (mode === "permission_denied") assert.equal(Exit.isSuccess(settlement) && settlement.value.kind, "unknown")
      assert.equal((yield* db.get<{ count: number }>("SELECT count(*) count FROM session_v2_tool_effect"))?.count, 0)
      assert.equal((yield* db.get<{ count: number }>("SELECT count(*) count FROM session_v2_tool_effect_admission"))?.count, 1)
      assert.equal(state.reads, 0); assert.equal(state.filesystem, 0)
      return { kind: "unknown" as const }
    }
    const result = yield* settlement
    if (result.kind !== "known") throw new Error("Original known refusal was not recorded")
    state.stage = "project"
    yield* publisher.publish(LLMEvent.toolResult({ id: call.id, name: "read", result: result.result.result }))
    yield* publisher.flush()
    const proof = yield* WorkToolPolicy.LeafProof
    state.stage = "verify"
    const known = yield* proof.verify(result.record.effectId)
    assert.equal(known.toolID, "read"); assert.equal("outcome" in known && known.outcome, "refused_before_read")
    assert.equal("fileIdentity" in known, false); assert.equal("observedHash" in known, false)
    const original = yield* db.get<{ known_read_proof: string }>(sql`SELECT known_read_proof FROM session_v2_tool_effect WHERE effect_id=${result.record.effectId}`)
    assert.ok(original?.known_read_proof)
    assert.equal(state.reads, 0); assert.equal(state.filesystem, 0); assert.equal(state.permission, 0)
    yield* WorkToolPolicy.preparePrevious(db, binding.sessionID)
    const work = yield* WorkAuthority.get(db, binding.workID)
    assert.ok(work)
    const prior = yield* db.transaction((tx) => WorkToolPolicy.previous(tx, work), { behavior: "immediate" })
    assert.equal(prior?.receipt.receipt_id, receiptID)
    return { kind: "known" as const, effectID: result.record.effectId, proof: original.known_read_proof, workID: binding.workID, sessionID: binding.sessionID }
  }).pipe(Effect.provide(layer), Effect.scoped))
  state.stage = "cold"
  if (original.kind === "known") await WorkProviderDispatchFixture.open(fixture, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const proof = yield* WorkToolPolicy.LeafProof
    assert.equal(Exit.isFailure(yield* proof.requireVerified(original.effectID).pipe(Effect.exit)), true)
    const known = yield* proof.verify(original.effectID)
    assert.equal("outcome" in known && known.outcome, "refused_before_read")
    assert.equal((yield* proof.requireVerified(original.effectID)).inputHash, known.inputHash)
    const work = yield* WorkAuthority.get(db, original.workID)
    assert.ok(work)
    assert.equal((yield* db.transaction((tx) => WorkToolPolicy.previous(tx, work), { behavior: "immediate" }))?.receipt.session_id, original.sessionID)
    assert.equal(Exit.isFailure(yield* db.run(sql`UPDATE session_v2_tool_effect SET known_read_proof=json_set(known_read_proof,'$.mac',${"0".repeat(64)}) WHERE effect_id=${original.effectID}`).pipe(Effect.exit)), true)
    assert.equal((yield* db.get<{ proof: string }>(sql`SELECT known_read_proof proof FROM session_v2_tool_effect WHERE effect_id=${original.effectID}`))?.proof, original.proof)
    assert.equal("outcome" in (yield* proof.verify(original.effectID)), true)
    yield* db.run("UPDATE test_work_source SET enabled=0")
    assert.equal(Exit.isFailure(yield* proof.verify(original.effectID).pipe(Effect.exit)), true)
    assert.equal((yield* db.get<{ count: number }>("SELECT count(*) count FROM session_v2_tool_effect"))?.count, 1)
  }).pipe(Effect.provide(layer), Effect.scoped))
  console.log(JSON.stringify({ ok: true, mode, terminal: original.kind, assertions: "registry/admission/originalHostMAC/cold/immutable/current/opaque", reads: state.reads, filesystem: state.filesystem, permission: state.permission, provider: 0 }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, stage: state.stage })); throw error
} finally { await fs.rm(directory, { recursive: true, force: true }) }
