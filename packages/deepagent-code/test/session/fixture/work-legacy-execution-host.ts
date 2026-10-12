// Actual AppRuntime/SessionExecution/canonical runner. Only the loopback provider is controlled.
// DEV_MINT belongs to this private fixture; it is not release or source authorization.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import net from "node:net"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { AgentV2 } from "@deepagent-code/core/agent"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { commandReg, makeRegistry, verifiedCommand } from "../../../../core/test/deepagent/event-fixture"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const phase = process.argv[3]!
const directory = path.join(root, "project")
const requests: unknown[] = []
const provider = createServer(async (request, response) => {
  assert.equal(request.url, "/v1/chat/completions")
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  requests.push(JSON.parse(Buffer.concat(parts).toString()))
  await Bun.write(path.join(root, `${phase}-provider.json`), JSON.stringify(requests, null, 2))
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const part of [
    { choices: [{ index: 0, delta: { role: "assistant" } }] },
    { choices: [{ index: 0, delta: { content: "Controlled ordinary response" } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ])
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-legacy", object: "chat.completion.chunk", created: 1, model: "test-model", ...part })}\n\n`,
    )
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
    provider: {
      fixture: {
        name: "Private fixture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: {
          "test-model": {
            name: "Fixture",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }),
)
const rg = Bun.which(process.platform === "win32" ? "rg.exe" : "rg")
assert(rg)
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, path.basename(rg)))

const facts = (sessionID: string) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return {
        session: yield* db.all(
          sql`SELECT id,execution_claim_token,agent,model,permission,metadata FROM session WHERE id=${sessionID}`,
        ),
        inputs: yield* db.all(sql`SELECT * FROM session_input WHERE session_id=${sessionID} ORDER BY id`),
        events: yield* db.all(sql`SELECT seq,type,data FROM event WHERE aggregate_id=${sessionID} ORDER BY seq`),
        activities: yield* db.all(
          sql`SELECT * FROM session_activity WHERE session_id=${sessionID} ORDER BY activity_id`,
        ),
        selections: yield* db.all(
          sql`SELECT * FROM session_context_selection WHERE session_id=${sessionID} ORDER BY selection_id`,
        ),
        receipts: yield* db.all(
          sql`SELECT * FROM session_v2_provider_turn_receipt WHERE session_id=${sessionID} ORDER BY receipt_id`,
        ),
        work: yield* db.all(sql`SELECT * FROM work_execution WHERE session_id=${sessionID}`),
      }
    }),
  )
const outcome = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : Cause.pretty(exit.cause)
}
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
try {
  await AppRuntime.runPromise(Database.Service)
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address()
  assert(port && typeof port !== "string")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  listener = await Server.listen({ hostname: "127.0.0.1", port: port.port })
  const legacyID =
    phase === "warm"
      ? await AppRuntime.runPromise(
          Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const sessions = yield* SessionV2.Service
            const legacy = yield* sessions.create({
              agent: AgentV2.ID.make("auto"),
              location: { directory: AbsolutePath.make(directory) },
              model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
            })
            const built = EventWorkEnvelope.build({
              event: verifiedCommand(makeRegistry()),
              registration: commandReg,
              resolution: {
                trust: { level: "verified", sourceRef: "fixture://old-event" },
                permission: { scopes: [], required: [], maxAutonomy: "medium" },
                egress: { allowedDomains: [], allowedSensitivities: ["public"] },
                budget: {
                  maxTokens: 16,
                  maxToolCalls: 0,
                  maxDurationMs: 10_000,
                  hourTokensMax: 16,
                  hourWindowMinutes: 60,
                  workspaceBudgetId: "old-budget",
                  agentBudgetId: "old-agent",
                  eventRoot: "goal://old",
                },
                securityNamespaceId: "old-namespace",
                projectScopeKey: "old-project",
                contextQuery: { intent: "related", query: "audited historical event" },
              },
              verifiedFacts: [],
            })
            if (!built.ok) throw new Error(built.message)
            yield* EventAdmission.admit(db, {
              envelope: built.envelope,
              sessionID: legacy.id,
              messageID: "msg_legacy_original",
              now: Date.now(),
              resume: false,
              adapter: {
                admit: (input) =>
                  sessions
                    .prompt({
                      id: SessionMessage.ID.make(input.messageID!),
                      sessionID: legacy.id,
                      prompt: new Prompt({ text: input.promptText }),
                      resume: false,
                    })
                    .pipe(Effect.map((message) => ({ messageID: message.id }))),
              },
            })
            return legacy.id
          }),
        )
      : SessionV2.ID.make((await Bun.file(path.join(root, "identity.json")).json()).legacyID)
  if (phase === "warm") await Bun.write(path.join(root, "identity.json"), JSON.stringify({ legacyID }))
  const before = await facts(legacyID)
  const classification = await AppRuntime.runPromise(
    Effect.gen(function* () {
      return yield* WorkAuthority.lookupSession((yield* Database.Service).db, legacyID)
    }),
  )
  const direct = await AppRuntime.runPromise(
    SessionExecution.Service.use((service) => service.resume(legacyID)).pipe(Effect.timeout("20 seconds"), Effect.exit),
  )
  const afterExecution = await facts(legacyID)
  const legacyRequests = requests.length
  const mutation = await AppRuntime.runPromise(
    SessionV2.Service.use((service) =>
      service.prompt({
        id: SessionMessage.ID.make(`msg_legacy_extra_${phase}`),
        sessionID: legacyID,
        prompt: new Prompt({ text: "must not be admitted" }),
        resume: false,
      }),
    ).pipe(Effect.exit),
  )
  const publicResume = await AppRuntime.runPromise(
    SessionV2.Service.use((service) => service.resume(legacyID)).pipe(Effect.timeout("20 seconds"), Effect.exit),
  )
  const directRunner = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap
      return yield* SessionRunner.Service.use((service) => service.run({ sessionID: legacyID, force: true })).pipe(
        Effect.provide(locations.get({ directory: AbsolutePath.make(directory) })),
      )
    }).pipe(Effect.timeout("20 seconds"), Effect.exit),
  )
  const otherMutations = await AppRuntime.runPromise(
    SessionV2.Service.use((service) =>
      Effect.gen(function* () {
        const operations: Record<string, Effect.Effect<unknown, unknown>> = {
          shell: service.shell({ sessionID: legacyID, command: "printf blocked", resume: false }),
          compact: service.compact({ sessionID: legacyID }),
          agent: service.switchAgent({ sessionID: legacyID, agent: "auto" }),
          model: service.switchModel({
            sessionID: legacyID,
            model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
          }),
          permission: service.setPermissions({
            sessionID: legacyID,
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          }),
          child: service.create({ parentID: legacyID, location: { directory: AbsolutePath.make(directory) } }),
        }
        return yield* Effect.forEach(Object.entries(operations), ([name, operation]) =>
          Effect.gen(function* () {
            return { name, outcome: outcome(yield* operation.pipe(Effect.asVoid, Effect.exit)) }
          }),
        )
      }),
    ),
  )
  await AppRuntime.runPromise(
    SessionExecution.Service.use((service) =>
      Effect.gen(function* () {
        yield* service.wake(legacyID)
        yield* service.awaitIdle(legacyID)
      }),
    ),
  )
  const afterMutations = await facts(legacyID)
  const readable = await AppRuntime.runPromise(
    SessionV2.Service.use((service) =>
      Effect.gen(function* () {
        const session = yield* service.get(legacyID)
        const messages = yield* service.messages({ sessionID: legacyID })
        yield* service.interrupt(legacyID)
        return { sessionID: session.id, messages: messages.length }
      }),
    ),
  )
  const ordinary = await AppRuntime.runPromise(
    SessionV2.Service.use((service) =>
      Effect.gen(function* () {
        const created = yield* service.create({
          agent: AgentV2.ID.make("auto"),
          location: { directory: AbsolutePath.make(directory) },
          model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
          metadata: {
            eventID: "fake",
            taskID: "fake",
            generation: 1,
            im: { groupID: "fake", agent: "auto" },
            workID: "fake",
          },
        })
        yield* service.prompt({
          sessionID: created.id,
          prompt: new Prompt({ text: "ordinary local user" }),
          resume: false,
        })
        const result = yield* service.resume(created.id).pipe(Effect.timeout("20 seconds"), Effect.exit)
        return { sessionID: created.id, outcome: outcome(result) }
      }),
    ),
  )
  const result = {
    phase,
    pid: process.pid,
    fixtureDevMint: true,
    classification,
    before,
    afterExecution,
    afterMutations,
    legacyRequests,
    direct: outcome(direct),
    mutation: outcome(mutation),
    publicResume: outcome(publicResume),
    directRunner: outcome(directRunner),
    otherMutations,
    readable,
    ordinary,
    requests: requests.length,
    ordinaryFacts: await facts(ordinary.sessionID),
  }
  await Bun.write(path.join(root, `${phase}-result.json`), JSON.stringify(result, null, 2))
} finally {
  if (listener) await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
}
