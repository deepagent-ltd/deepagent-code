// The host, roster, Context registry, Session input, coordinator and provider runner are real.
// Only the loopback model's HTTP response is deterministic; no external credentials are loaded.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const scenario = process.argv[3]!
const phase = process.argv[4] ?? "live"
const directory = path.join(root, "project")
const requests: unknown[] = []
let loads = 0
const provider = createServer(async (request, response) => {
  assert.equal(request.url, "/v1/chat/completions")
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  requests.push(JSON.parse(Buffer.concat(parts).toString()))
  response.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (value: unknown) =>
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-selection",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        ...Object(value),
      })}\n\n`,
    )
  emit({ choices: [{ index: 0, delta: { role: "assistant", content: "Selection completed" } }] })
  emit({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  })
  response.end("data: [DONE]\n\n")
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
assert(address && typeof address !== "string")
await Bun.write(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    model: "fixture/test-model",
    permission: { "*": "deny" },
    agent: { alpha: { mode: "primary", prompt: "Agent alpha" }, beta: { mode: "primary", prompt: "Agent beta" } },
    provider: {
      fixture: {
        name: "Selection fixture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: Object.fromEntries(
          ["test-model", "other-model"].map((id) => [
            id,
            {
              name: id,
              tool_call: false,
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
            },
          ]),
        ),
      },
    },
  }),
)
const rg = Bun.which(process.platform === "win32" ? "rg.exe" : "rg")
assert(rg)
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, path.basename(rg)))
const scope = await Effect.runPromise(Scope.make())
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
try {
  const database = await AppRuntime.runPromise(Database.Service)
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const sessions = await AppRuntime.runPromise(SessionV2.Service)
  const location = { directory: AbsolutePath.make(directory), workspaceID: undefined }
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap
      // Real independent build registration is deliberately distinct from the fallback alias.
      if (scenario === "independent" || (scenario === "cold" && phase === "live")) {
        yield* AgentV2.Service.use((agents) =>
          agents.update((editor) =>
            editor.update(AgentV2.ID.make("build"), (agent) => {
              agent.mode = "primary"
              agent.system = "Independent build identity"
            }),
          ),
        ).pipe(Effect.provide(locations.get(location)), Effect.provideService(Scope.Scope, scope))
      }
    }),
  )
  const previous: { sessionID: string } | undefined =
    phase === "cold" ? await Bun.file(path.join(root, "session.json")).json() : undefined
  const session = previous
    ? await AppRuntime.runPromise(sessions.get(SessionV2.ID.make(previous.sessionID)))
    : await AppRuntime.runPromise(
        sessions.create({
          location,
          agent: AgentV2.ID.make(["alias", "independent", "cold"].includes(scenario) ? "build" : "alpha"),
        }),
      )
  await Bun.write(path.join(root, "session.json"), JSON.stringify({ sessionID: session.id }))
  const warmRequests: unknown[] = []
  if (scenario.startsWith("old-")) {
    await AppRuntime.runPromise(
      sessions.prompt({
        sessionID: session.id,
        prompt: new Prompt({ text: "Establish the historical epoch" }),
        resume: false,
      }),
    )
    await AppRuntime.runPromise(sessions.resume(session.id))
    assert.equal(requests.length, 1)
    warmRequests.push(...requests)
    requests.length = 0
  }
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap
      yield* SystemContextRegistry.Service.use((registry) =>
        registry.register({
          key: SystemContext.Key.make("test/selection"),
          load: Effect.succeed(
            SystemContext.make({
              key: SystemContext.Key.make("test/selection"),
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.gen(function* () {
                loads++
                if (loads > 4) return yield* Effect.die(new Error("UNBOUNDED_SELECTION_REBUILD"))
                if (scenario === "error" || scenario === "old-error")
                  return yield* Effect.die(new Error("CONTEXT_SOURCE_FAILED"))
                if (scenario === "cancel" || scenario === "old-cancel") return yield* Effect.interrupt
                if (scenario === "churn" || scenario === "old-churn" || (scenario === "switch" && loads === 1)) {
                  yield* sessions.switchAgent({ sessionID: session.id, agent: loads % 2 ? "beta" : "alpha" })
                }
                if (scenario === "old-aba" && loads === 1) {
                  yield* sessions.switchAgent({ sessionID: session.id, agent: "beta" })
                  yield* sessions.switchAgent({ sessionID: session.id, agent: "alpha" })
                }
                if (scenario === "old-stable") {
                  yield* database.db.run("UPDATE session_context_epoch SET revision=revision+1").pipe(Effect.orDie)
                }
                return "Actual registered context"
              }).pipe(Effect.orDie),
              baseline: String,
              update: (_old, value) => value,
            }),
          ),
        }),
      ).pipe(Effect.provide(locations.get(location)), Effect.provideService(Scope.Scope, scope))
    }),
  )
  await AppRuntime.runPromise(
    sessions.prompt({
      sessionID: session.id,
      prompt: new Prompt({
        text: phase === "cold" ? "Cold continuation" : "First prompt",
        ...(["pending", "mixed"].includes(scenario) ? { agent: "beta" } : {}),
      }),
      resume: false,
    }),
  )
  if (scenario === "mixed")
    await AppRuntime.runPromise(
      sessions.prompt({
        sessionID: session.id,
        prompt: new Prompt({ text: "Choose model only", model: { providerID: "fixture", id: "other-model" } }),
        resume: false,
      }),
    )
  const exit = await AppRuntime.runPromise(sessions.resume(session.id).pipe(Effect.exit))
  const facts = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return {
        sessions: yield* db.all<Record<string, unknown>>("SELECT id,agent,model,execution_claim_token FROM session"),
        inputs: yield* db.all<Record<string, unknown>>("SELECT id,session_id,prompt,promoted_seq FROM session_input"),
        epochs: yield* db.all<Record<string, unknown>>("SELECT * FROM session_context_epoch"),
        receipts: yield* db.all<Record<string, unknown>>("SELECT state FROM session_v2_provider_turn_receipt"),
      }
    }),
  )
  const result = {
    pid: process.pid,
    requests,
    warmRequests,
    loads,
    exit: exit._tag,
    ...(Exit.isFailure(exit) ? { cause: Cause.pretty(exit.cause), interrupted: Cause.hasInterrupts(exit.cause) } : {}),
    facts,
  }
  await Bun.write(path.join(root, `${phase}-result.json`), JSON.stringify(result, null, 2))
  if (["error", "cancel", "churn", "old-error", "old-cancel", "old-churn", "old-stable"].includes(scenario)) {
    assert(Exit.isFailure(exit))
    assert.equal(requests.length, 0)
    assert.equal(facts.inputs.filter((row) => row.promoted_seq === null).length, 1)
    if (scenario === "old-stable") assert.equal(loads, 1)
    if (scenario === "churn" || scenario === "old-churn" || scenario === "old-stable")
      assert.match(result.cause ?? "", /AgentSelectionUnstable/)
    if (scenario === "error" || scenario === "old-error") assert.match(result.cause ?? "", /CONTEXT_SOURCE_FAILED/)
    if (scenario === "cancel" || scenario === "old-cancel") assert.equal(result.interrupted, true)
  } else {
    assert(Exit.isSuccess(exit), JSON.stringify(result))
    assert.equal(requests.length, 1)
    assert.equal(
      facts.epochs[0].agent,
      scenario === "independent" || (scenario === "cold" && phase === "live")
        ? "build"
        : ["alias", "cold"].includes(scenario)
          ? "auto"
          : ["pending", "mixed", "switch"].includes(scenario)
            ? "beta"
            : "alpha",
    )
    assert.equal(
      facts.inputs.every((row) => row.promoted_seq !== null),
      true,
    )
  }
} finally {
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await listener?.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
}
