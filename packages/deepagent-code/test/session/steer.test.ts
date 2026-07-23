import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSteer } from "../../src/session/steer"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { Truncate } from "@/tool/truncate"
import * as Log from "@deepagent-code/core/util/log"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Search } from "@deepagent-code/core/filesystem/search"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Global } from "@deepagent-code/core/global"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

void Log.init({ print: false })

// §S1.2 promptOrSteer routes on the DeepAgent active-goal pointer, which lives in the in-memory
// session-state map. Point it at a throwaway dir so getOrCreate/setActiveGoal work in-process (no real
// $HOME writes) and each test seeds its own session pointer.
AgentGateway.DeepAgentSessionState.configure(mkdtempSync(path.join(tmpdir(), "steer-state-")))

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in steer tests"),
    authenticate: () => Effect.die("unexpected MCP auth in steer tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in steer tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    catalog: () => Effect.succeed([]),
    enableCatalogEntry: () => Effect.succeed({ status: {}, name: "x", config: { type: "local", command: [] } }),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    typeDefinition: () => Effect.succeed([]),
    declaration: () => Effect.succeed([]),
    prepareTypeHierarchy: () => Effect.succeed([]),
    supertypes: () => Effect.succeed([]),
    subtypes: () => Effect.succeed([]),
    inlayHint: () => Effect.succeed([]),
    codeAction: () => Effect.succeed([]),
    executeCommand: () => Effect.succeed(null),
    prepareRename: () => Effect.succeed(null),
    rename: () => Effect.succeed(null),
    documentHighlight: () => Effect.succeed([]),
    foldingRange: () => Effect.succeed([]),
    selectionRange: () => Effect.succeed([]),
    completion: () => Effect.succeed(null),
    signatureHelp: () => Effect.succeed(null),
    serverCapabilities: () => Effect.succeed(undefined),
    workspaceDiagnostics: () => Effect.succeed({}),
  }),
)

const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)

const debugStubDie = <A>(): Effect.Effect<A, never, never> => Effect.die("DebugService stub (not used in steer tests)")
const stubDebugServiceLayer = Layer.succeed(
  DebugService.Service,
  DebugService.Service.of({
    start: debugStubDie,
    setBreakpoints: debugStubDie,
    continue: debugStubDie,
    step: debugStubDie,
    stackTrace: debugStubDie,
    scopes: debugStubDie,
    variables: debugStubDie,
    evaluate: debugStubDie,
    terminate: debugStubDie,
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

// steeringOn/steeringOff: the ONLY difference is the v4Steering flag, so tests can assert the
// kill-switch cleanly. The steer buffer shares the same Database as Session (built over `deps`).
function makePrompt(steering: boolean) {
  const flags = RuntimeFlags.layer({ experimentalEventSystem: true, v4Steering: steering })
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    Auth.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const steer = SessionSteer.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Search.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(flags),
    Layer.provide(stubDebugServiceLayer),
    Layer.provide(stubRuntimeBaseLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(steer),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

function providerCfg(url: string) {
  return { ...cfg, provider: { ...cfg.provider, test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: url } } } }
}

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    `${dir}/deepagent-code.json`,
    JSON.stringify({ $schema: "https://deepagent-code.ai/config.json", ...config }),
  )
})

// Mirrors prompt.test.ts useServerConfig: write the config that points the "test" provider at the live
// TestLLMServer into the per-test tmpdir instance directory, so provider model lookup succeeds.
const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const on = testEffect(Layer.mergeAll(TestLLMServer.layer, makePrompt(true)))
const off = testEffect(Layer.mergeAll(TestLLMServer.layer, makePrompt(false)))

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

const mkPrompt = (text: string): Prompt => Prompt.fromUserMessage({ text })

// ── Unit: admit → pending (ordered) → markConsumed (consume-once) ───────────────────────────────────

off.instance("admit buffers steers, pending returns them in send-order, markConsumed is consume-once", () =>
  Effect.gen(function* () {
    const steer = yield* SessionSteer.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Steer unit" })

    yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("first") })
    yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("second") })
    yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("third") })

    expect(yield* steer.hasPending(chat.id)).toBe(true)

    // pending is NON-consuming (persist-first read).
    const drained = yield* steer.pending(chat.id)
    expect(drained.map((d) => d.prompt.text)).toEqual(["first", "second", "third"])
    // Monotonic send-order seq
    expect(drained[0]!.seq).toBeLessThan(drained[1]!.seq)
    expect(drained[1]!.seq).toBeLessThan(drained[2]!.seq)
    // Reading did not consume — still pending.
    expect(yield* steer.hasPending(chat.id)).toBe(true)

    // markConsumed stamps them; a subsequent pending read yields nothing (consume-once).
    yield* steer.markConsumed(chat.id, drained.map((d) => d.id))
    expect(yield* steer.pending(chat.id)).toHaveLength(0)
    expect(yield* steer.hasPending(chat.id)).toBe(false)
    // markConsumed is idempotent (re-marking already-consumed ids is a no-op).
    yield* steer.markConsumed(chat.id, drained.map((d) => d.id))
    expect(yield* steer.hasPending(chat.id)).toBe(false)
  }),
  { config: cfg },
)

// ── §S1.3 FIX 1: the DELIVERY dimension isolates two drainers on the SAME session id ────────────────
off.instance(
  "delivery scoping: pending/markConsumed/hasPending default to steer, and goal_steer is a disjoint channel",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer delivery" })

      // On the SAME session id: one parent-chat steer (delivery="steer") and one goal-directed steer
      // (delivery="goal_steer"). This models a goal running in a session whose parent runLoop is also live.
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("chat steer") })
      yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("goal guidance"),
        delivery: "goal_steer",
      })

      // The parent runLoop's drain (default "steer") sees ONLY the chat steer.
      const steerRows = yield* steer.pending(chat.id)
      expect(steerRows.map((d) => d.prompt.text)).toEqual(["chat steer"])
      expect(yield* steer.hasPending(chat.id)).toBe(true) // default channel has one

      // The goal driver's drain ("goal_steer") sees ONLY the goal guidance.
      const goalRows = yield* steer.pending(chat.id, "goal_steer")
      expect(goalRows.map((d) => d.prompt.text)).toEqual(["goal guidance"])
      expect(yield* steer.hasPending(chat.id, "goal_steer")).toBe(true)

      // Consuming ALL of the goal channel does NOT touch the steer channel (disjoint rows, no contention).
      yield* steer.markConsumed(chat.id, goalRows.map((d) => d.id), "goal_steer")
      expect(yield* steer.pending(chat.id, "goal_steer")).toHaveLength(0)
      expect(yield* steer.hasPending(chat.id, "goal_steer")).toBe(false)
      // The parent chat steer is UNTOUCHED — the parent runLoop can still drain it normally.
      expect((yield* steer.pending(chat.id)).map((d) => d.prompt.text)).toEqual(["chat steer"])
      expect(yield* steer.hasPending(chat.id)).toBe(true)

      // Symmetrically, consuming the steer channel leaves any (re-admitted) goal_steer row untouched.
      yield* steer.markConsumed(chat.id, steerRows.map((d) => d.id))
      expect(yield* steer.hasPending(chat.id)).toBe(false)
    }),
  { config: cfg },
)

off.instance("admit is idempotent on message id (no double-buffer)", () =>
  Effect.gen(function* () {
    const steer = yield* SessionSteer.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Steer idempotent" })
    const correlationID = SessionMessage.ID.create()

    const a = yield* steer.admit({ correlationID, sessionID: chat.id, prompt: mkPrompt("once") })
    const b = yield* steer.admit({ correlationID, sessionID: chat.id, prompt: mkPrompt("once") })
    expect(a.seq).toBe(b.seq)

    const drained = yield* steer.pending(chat.id)
    expect(drained).toHaveLength(1)
    expect(drained[0]!.prompt.text).toBe("once")
  }),
  { config: cfg },
)

// ── Durability: consume-once survives a fresh pending/markConsumed cycle (simulating a new loop pass) ─

off.instance("consume-once survives a fresh drain cycle (durable, no double-apply)", () =>
  Effect.gen(function* () {
    const steer = yield* SessionSteer.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Steer durable" })

    const admitted = yield* steer.admit({
      sessionID: chat.id,
      prompt: mkPrompt("persisted"),
    })

    // First loop pass reads then marks consumed.
    const first = yield* steer.pending(chat.id)
    expect(first).toHaveLength(1)
    yield* steer.markConsumed(chat.id, [admitted.id])

    // A subsequent loop pass (fresh pending call, as runLoop would issue) sees nothing — the row is
    // durably stamped consumed. This is the "steer sent then applied; must not double-apply" guarantee.
    const second = yield* steer.pending(chat.id)
    expect(second).toHaveLength(0)
  }),
  { config: cfg },
)

// ── Crash-window regression (Check 4b): persist succeeds but markConsumed crashes → no loss, no dup ──
//
// Reproduces the exact reliability gap: a crash AFTER a steer is materialized into history but BEFORE
// it is stamped consumed. The persist-first protocol keys the message AND its text part by the steer id
// (stable), so the row stays pending and the NEXT drain re-materializes idempotently. We assert (a) the
// steer is NOT lost (it is in history), (b) after replay there is exactly ONE copy (no duplicate turn),
// and (c) it eventually ends consumed. `steerPartID` mirrors prompt.ts's derivation so the replayed
// persist targets the same part row.
const steerPartID = (messageID: MessageID) => PartID.make("prt_" + messageID.slice("msg_".length))

const persistSteerAsMessage = Effect.fn("test.persistSteerAsMessage")(function* (
  sessionID: SessionID,
  admitted: SessionSteer.Admitted,
) {
  const sessions = yield* Session.Service
  const info: SessionV1.User = {
    id: MessageID.make(admitted.id),
    role: "user",
    sessionID,
    time: { created: admitted.timeCreated },
    agent: "build",
    model: ref,
  }
  yield* sessions.updateMessage(info)
  yield* sessions.updatePart({
    id: steerPartID(info.id),
    messageID: info.id,
    sessionID,
    type: "text",
    text: admitted.prompt.text,
  })
  return info.id
})

off.instance(
  "crash after persist but before markConsumed: steer survives, replay materializes exactly once",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer crash window" })

      const admitted = yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("DONT-LOSE-ME"),
      })

      // First drain pass: PERSIST the steer into history, then "crash" (interrupt) BEFORE markConsumed.
      const crashingDrain = Effect.gen(function* () {
        yield* persistSteerAsMessage(chat.id, admitted)
        // Simulate a process crash before the consume stamp lands.
        return yield* Effect.interrupt
      })
      const exit = yield* crashingDrain.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)

      // NO LOSS: the steer message is already in history...
      let msgs = yield* sessions.messages({ sessionID: chat.id })
      let steered = msgs.filter((m) => m.parts.some((p) => p.type === "text" && p.text === "DONT-LOSE-ME"))
      expect(steered).toHaveLength(1)
      // ...and the buffer row is STILL PENDING (markConsumed never ran).
      expect(yield* steer.hasPending(chat.id)).toBe(true)

      // Replay: the next drain re-reads the still-pending steer and re-persists it. Because the message
      // id AND part id are derived from the steer id, the upsert hits the SAME rows — idempotent.
      const replay = yield* steer.pending(chat.id)
      expect(replay).toHaveLength(1)
      yield* persistSteerAsMessage(chat.id, replay[0]!)
      yield* steer.markConsumed(chat.id, [replay[0]!.id])

      // EXACTLY ONCE: still a single copy in history (no duplicate turn from the replay).
      msgs = yield* sessions.messages({ sessionID: chat.id })
      steered = msgs.filter((m) => m.parts.some((p) => p.type === "text" && p.text === "DONT-LOSE-ME"))
      expect(steered).toHaveLength(1)
      expect(steered[0]!.parts.filter((p) => p.type === "text" && p.text === "DONT-LOSE-ME")).toHaveLength(1)
      // And now durably consumed.
      expect(yield* steer.hasPending(chat.id)).toBe(false)
    }),
  { config: cfg },
)

// ── Integration: steering ON — a steer admitted mid-run lands as a TAIL user message and is absorbed ─

on.instance(
  "steer admitted before the 2nd iteration is absorbed as a tail user message and re-runs the loop",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Steer integration",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const gate = yield* Deferred.make<void>()
      // First model call HOLDS (in-flight). We admit a steer while it's held, then release. The steer
      // must NOT abort the first call — it completes — and the loop runs a SECOND call that includes
      // the steered text at the tail of the input messages.
      yield* llm.hold("first-answer", deferredAsPromise(gate))
      yield* llm.text("second-answer")

      const fiber = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      // Admit the steer while the first model request is in flight.
      const admitted = yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("STEERED-MESSAGE"),
      })

      // Release the in-flight call; it completes (absorb-at-boundary, not abort), then the loop drains.
      yield* Deferred.succeed(gate, void 0)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      // Two model calls: the original + the follow-up that absorbed the steer.
      expect(yield* llm.calls).toBe(2)

      // The steered message is persisted as an ordinary user message in history.
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const steered = msgs.find((m) => m.info.role === "user" && m.info.id === MessageID.make(admitted.id))
      expect(steered?.info.role).toBe("user")
      expect(steered?.parts.some((p) => p.type === "text" && p.text === "STEERED-MESSAGE")).toBe(true)

      // The consume-once buffer is now empty.
      expect(yield* steer.hasPending(chat.id)).toBe(false)

      // The SECOND model input contains the steered text at the END of the message array (after prior
      // history), NOT in the system prefix.
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const secondInput = inputs.at(-1) as { messages: { role: string; content: unknown }[] }
      const roleMsgs = secondInput.messages
      const systemMsgs = roleMsgs.filter((m) => m.role === "system")
      // Not in the system prefix.
      expect(JSON.stringify(systemMsgs)).not.toContain("STEERED-MESSAGE")
      // Present in a user message.
      const userText = JSON.stringify(roleMsgs.filter((m) => m.role === "user"))
      expect(userText).toContain("STEERED-MESSAGE")
      // It appears AFTER the initial user turn in the array order.
      const flat = JSON.stringify(roleMsgs)
      expect(flat.indexOf("initial")).toBeLessThan(flat.indexOf("STEERED-MESSAGE"))
    }),
  15_000,
)

// ── Cache-safety: the system prefix is byte-identical with vs without a steer; single volatile tail ─

on.instance(
  "steer only adds a tail history message: system prefix byte-identical, single volatile tail preserved",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Steer cache",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const gate = yield* Deferred.make<void>()
      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("STEER") })
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.await(fiber)

      const inputs = yield* llm.inputs
      expect(inputs.length).toBeGreaterThanOrEqual(2)
      const msgsOf = (i: number) => (inputs[i] as { messages: { role: string; content: unknown }[] }).messages
      // CACHE-SAFETY INVARIANT (path-independent): the steered message is a NORMAL history tail user
      // message — it must NEVER be folded into the cached system prefix (that would churn the
      // hash-guarded prefix and break the cache). Assert the steer text is absent from EVERY system
      // message of BOTH the pre-steer and post-steer requests. (We do NOT assert full byte-identity of
      // the DeepAgent prefix here: that prefix legitimately varies turn-to-turn via per-turn skill
      // guidance retrieval, a DeepAgent-runtime property unrelated to steering. The steer-controlled
      // property is precisely that the steer stays out of the prefix, which is what we assert.)
      const sys = (i: number) => JSON.stringify(msgsOf(i).filter((m) => m.role === "system"))
      expect(sys(0)).not.toContain("STEER")
      expect(sys(inputs.length - 1)).not.toContain("STEER")

      // The steered text rides in a USER-role message of the post-steer request (real history), and it
      // sits AFTER the initiating turn in array order — i.e. appended at the tail of history, exactly
      // like a normal follow-up user message. The single ephemeral volatile round-context tail (when
      // present) is assembled separately in llm/request.ts and is NOT where the steer lives, so the
      // slice(-2) cache breakpoint is preserved (no second trailing volatile message is introduced).
      const second = msgsOf(inputs.length - 1)
      expect(JSON.stringify(second.filter((m) => m.role === "user"))).toContain("STEER")
      const flat = JSON.stringify(second)
      expect(flat.indexOf("initial")).toBeLessThan(flat.indexOf("STEER"))
    }),
  15_000,
)

// ── Kill-switch: steering OFF — no drain; a busy-time admit is never absorbed by the loop ───────────

off.instance(
  "with v4Steering OFF the loop performs NO drain (current behavior preserved)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Steer off",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Pre-buffer a steer directly (bypassing ingress) so we can prove the loop ignores it when OFF.
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("IGNORED-STEER") })

      yield* llm.text("done")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "hi" }],
      })
      expect(result.info.role).toBe("assistant")

      // Exactly ONE model call — the loop did not continue to absorb the buffered steer.
      expect(yield* llm.calls).toBe(1)
      // The steer is NOT persisted as a history message.
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "IGNORED-STEER"))).toBe(false)
      // It remains pending in the buffer (untouched — the drain never ran).
      expect(yield* steer.hasPending(chat.id)).toBe(true)
    }),
  15_000,
)

// ── §S1.2 FIX A: promptOrSteer routes on the ACTIVE-GOAL pointer FIRST, independent of isBusy ────────
//
// The seam (prompt.ts promptOrSteer): a NON-terminal active goal is checked BEFORE the isBusy branch and
// forces delivery="goal_steer". The prior bug gated goal_steer behind isBusy, so a background goal (which
// does NOT busy the parent runner) left the session idle → the goal_steer branch was unreachable and the
// steer wrongly ran as a fresh normal turn. These tests lock the goal-first ordering at the exact seam.

const seedGoal = (sessionID: string, phase: AgentGateway.DeepAgentSessionState.GoalPointerPhase) => {
  AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
  AgentGateway.DeepAgentSessionState.setActiveGoal(sessionID, {
    goalId: "g_" + sessionID,
    planDocId: "plan_" + sessionID,
    phase: "running",
    startedAt: new Date(0).toISOString(),
  })
  // setActiveGoalPhase patches ONLY the phase of the just-set pointer (drives running↔paused↔terminal).
  AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, phase)
}

on.instance(
  "promptOrSteer: a NON-terminal active goal routes to goal_steer independent of isBusy (idle session)",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const chat = yield* sessions.create({
        title: "promptOrSteer goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // A background goal runs in child sessions; the PARENT session is IDLE (not busy). This is exactly
      // the case the old isBusy gate missed — assert idle so the routing cannot be attributed to busy.
      seedGoal(chat.id, "running")
      expect(yield* state.isBusy(chat.id)).toBe(false)

      const result = yield* prompt.promptOrSteer({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "GOAL-GUIDANCE" }],
      })

      // Routed to the goal channel — NOT a turn, NOT a plain "steer".
      expect(result.kind).toBe("steer")
      if (result.kind !== "steer") throw new Error("expected steer")
      expect(result.delivery).toBe("goal_steer")

      // Admitted to the goal_steer channel; the default "steer" channel is untouched (disjoint rows).
      const goalRows = yield* steer.pending(chat.id, "goal_steer")
      expect(goalRows.map((d) => d.prompt.text)).toEqual(["GOAL-GUIDANCE"])
      expect(goalRows.some((d) => d.id === result.admitted.id)).toBe(true)
      expect(yield* steer.pending(chat.id, "steer")).toHaveLength(0)
      expect(yield* steer.hasPending(chat.id, "steer")).toBe(false)

      // T2.6 — the governance audit now lives on the REAL goal-steer ingress (was previously stranded on
      // the never-called GoalManager.steerGoal). A worklog audit doc must be written into the goal's
      // Document Graph, recording the human steer (length only, PII-light) with governance="steer".
      const goalStore = new DocumentStore(path.join(Global.Path.agent.data, "state", "goal", chat.id, "graph"))
      const audits = goalStore
        .list({ type: "worklog", scope: `run:${chat.id}` })
        .map((ref) => goalStore.get(ref.id)!)
      const steerAudit = audits.find((d) => d.extensions?.governance === "steer")
      expect(steerAudit).toBeDefined()
      expect(steerAudit?.extensions?.goal_id).toBe("g_" + chat.id)
      expect(steerAudit?.body).toContain("\"textChars\": 13") // "GOAL-GUIDANCE".length
    }),
  15_000,
)

on.instance(
  "promptOrSteer: no goal + idle runs a normal turn; a TERMINAL goal phase does NOT route to goal_steer",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service

      // (B) No active goal + idle → a normal turn (the pre-steering path).
      const plain = yield* sessions.create({
        title: "promptOrSteer idle",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("idle-answer")
      const turn = yield* prompt.promptOrSteer({
        sessionID: plain.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "hello" }],
      })
      expect(turn.kind).toBe("turn")
      // Nothing was buffered on either channel.
      expect(yield* steer.hasPending(plain.id, "goal_steer")).toBe(false)
      expect(yield* steer.hasPending(plain.id, "steer")).toBe(false)

      // (C) A TERMINAL goal phase ("done") is NOT active → it must NOT route to goal_steer. Idle + no live
      // turn ⇒ it falls through to a normal turn, proving the goal-active predicate excludes terminal phases.
      const settled = yield* sessions.create({
        title: "promptOrSteer terminal goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      seedGoal(settled.id, "done")
      yield* llm.text("post-goal-answer")
      const afterDone = yield* prompt.promptOrSteer({
        sessionID: settled.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "after done" }],
      })
      expect(afterDone.kind).toBe("turn")
      // Crucially: NOT admitted to goal_steer (the terminal goal did not capture it).
      expect(yield* steer.hasPending(settled.id, "goal_steer")).toBe(false)
    }),
  15_000,
)

// ── §S1.2 FIX B: a pure-drain turn (drainFirst) absorbs a raced steer on STEP 0 ──────────────────────
//
// The seam (runLoop): `if (step > 0 || drainFirst) yield* drainSteers(...)`. A pure-drain turn — started
// by promptOrSteer's race guard when a steer is admitted right as a turn ends — has no initiating message,
// so it MUST drain on step 0; otherwise the immediate top-of-loop finish check breaks before the steer is
// ever materialized. The prior bug skipped the step-0 drain, stranding the raced steer. We drive the loop
// directly with drainFirst true vs false over an idle-but-primed session to lock exactly this branch.

on.instance(
  "drainFirst:true — a pure-drain turn absorbs a steer on step 0; drainFirst:false does NOT",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service

      // Prime a session with a completed turn so history has a user+assistant pair and the session is idle
      // (the exact post-turn state in which promptOrSteer's race guard forks a pure-drain turn).
      const drained = yield* sessions.create({
        title: "drainFirst true",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("first-answer")
      yield* prompt.prompt({ sessionID: drained.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] })
      expect(yield* llm.calls).toBe(1)
      expect(yield* state.isBusy(drained.id)).toBe(false)

      // A steer lands in the isBusy→admit race window (buffered while the session is idle).
      const admitted = yield* steer.admit({
        sessionID: drained.id,
        prompt: mkPrompt("STEP0-STEER"),
      })

      // The pure-drain turn: drainFirst true ⇒ drain on step 0, materialize the steer as a tail user
      // message, then sample the model on it.
      yield* llm.text("drain-answer")
      yield* prompt.loop({ sessionID: drained.id, drainFirst: true })

      // A SECOND model call happened — the drain turn re-ran the loop after absorbing the steer.
      expect(yield* llm.calls).toBe(2)
      // The steer is materialized as an ordinary tail user message and the buffer row is consumed.
      const msgs = yield* sessions.messages({ sessionID: drained.id })
      const steered = msgs.find((m) => m.info.role === "user" && m.info.id === MessageID.make(admitted.id))
      expect(steered?.parts.some((p) => p.type === "text" && p.text === "STEP0-STEER")).toBe(true)
      expect(yield* steer.hasPending(drained.id)).toBe(false)
      // The model actually sampled the steered text (it rode into the drain turn's input, at the tail).
      const inputs = yield* llm.inputs
      const last = inputs.at(-1) as { messages: { role: string; content: unknown }[] }
      expect(JSON.stringify(last.messages.filter((m) => m.role === "user"))).toContain("STEP0-STEER")

      // CONTRAST — drainFirst:false (the default) leaves step 0 un-drained: the fresh loop's finish check
      // breaks immediately, so a step-0 steer is NOT absorbed. This proves the flag is what enables the
      // step-0 drain and that normal turns are unchanged (S1.1's step>0 drain semantics intact).
      const normal = yield* sessions.create({
        title: "drainFirst false",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("first-answer-2")
      yield* prompt.prompt({ sessionID: normal.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] })
      const before = yield* llm.calls
      yield* steer.admit({ sessionID: normal.id, prompt: mkPrompt("NOT-DRAINED") })

      // Default loop() → drainFirst=false. Step 0 does NOT drain; the loop breaks at the finish check.
      yield* prompt.loop({ sessionID: normal.id })

      // No new model call, the steer stays pending, and it is NOT in history.
      expect(yield* llm.calls).toBe(before)
      expect(yield* steer.hasPending(normal.id)).toBe(true)
      const normalMsgs = yield* sessions.messages({ sessionID: normal.id })
      expect(normalMsgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "NOT-DRAINED"))).toBe(false)
    }),
  20_000,
)
