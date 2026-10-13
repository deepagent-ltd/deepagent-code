// Private real-server oracle, not a production grant endpoint. The SQL verifier is an
// explicitly trusted test boundary; DEV_MINT authorizes only this isolated fixture.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import net from "node:net"
import { Cause, Effect, Exit, RcMap } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildSchema } from "@deepagent-code/core/deepagent/goal-child.schema"
import { GoalChildFixture } from "../../../../core/test/fixture/goal-child"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Server } from "@/server/server"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"

const root = process.argv[2]!
const directory = path.join(root, "project")
const cases: Record<string, number | string> = {}
const providerRequests: string[] = []
const provider = createServer((request, response) => {
  providerRequests.push(request.url ?? "unknown")
  response.writeHead(500, { "content-type": "application/json" }).end('{"error":"unexpected provider request"}')
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
    provider: {
      fixture: {
        name: "Local refusal oracle",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: { "test-model": { name: "Fixture", limit: { context: 100_000, output: 10_000 } } },
      },
    },
  }),
)
// Tool registration may eagerly locate ripgrep. Copy an installed binary, never download it.
const rg = Bun.which(process.platform === "win32" ? "rg.exe" : "rg")
assert(rg, "This offline fixture requires an installed ripgrep")
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, path.basename(rg)))

await AppRuntime.runPromise(WorkAuthorityFixture.initialize())
assert.equal(Database.path(), path.join(root, "authority.sqlite"))
const probe = net.createServer()
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
const available = probe.address()
assert(available && typeof available !== "string")
await new Promise<void>((resolve) => probe.close(() => resolve()))
const listener = await Server.listen({ hostname: "127.0.0.1", port: available.port })

const facts = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const locations = yield* LocationServiceMap
      return {
        sessions: yield* db.all<Record<string, unknown>>("SELECT * FROM session ORDER BY id"),
        inputs: yield* db.all<Record<string, unknown>>("SELECT * FROM session_input ORDER BY id"),
        events: yield* db.all<Record<string, unknown>>(
          "SELECT aggregate_id,seq,type,data FROM event ORDER BY sync_seq",
        ),
        intents: yield* db.all<Record<string, unknown>>("SELECT * FROM session_intent ORDER BY intent_id"),
        forks: yield* db.all<Record<string, unknown>>("SELECT * FROM session_fork_intent ORDER BY intent_id"),
        compactions: yield* db.all<Record<string, unknown>>(
          "SELECT * FROM session_v2_compaction_request ORDER BY request_id",
        ),
        attempts: yield* db.all<Record<string, unknown>>("SELECT * FROM session_provider_attempt ORDER BY attempt_id"),
        receipts: yield* db.all<Record<string, unknown>>(
          "SELECT * FROM session_v2_provider_turn_receipt ORDER BY receipt_id",
        ),
        contexts: yield* db.all<Record<string, unknown>>(
          "SELECT * FROM session_context_selection ORDER BY selection_id",
        ),
        activities: yield* db.all<Record<string, unknown>>("SELECT * FROM session_activity ORDER BY activity_id"),
        work: yield* db.all<Record<string, unknown>>("SELECT * FROM work_execution ORDER BY work_id"),
        locations: Array.from(yield* RcMap.keys(locations.rcMap))
          .map((ref) => JSON.stringify(ref))
          .sort(),
        active: Array.from(yield* (yield* SessionExecution.Service).active).sort(),
        providerRequests: [...providerRequests],
      }
    }),
  )

async function request(route: string, method = "GET", body?: unknown) {
  const response = await fetch(new URL(route, listener.url), {
    method,
    headers: { "x-deepagent-code-directory": directory, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  const value: unknown = await response.json()
  return { status: response.status, body: value }
}

async function rejected(
  name: string,
  route: string,
  method: string,
  body: unknown,
  status: number,
  field: string,
  code: string,
) {
  const before = await facts()
  const result = await request(route, method, body)
  await Bun.write(path.join(root, `${name}.json`), JSON.stringify(result, null, 2))
  assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}`)
  assert(result.body && typeof result.body === "object" && field in result.body)
  assert.equal(Reflect.get(result.body, field), code, `${name}: error code`)
  assert.deepEqual(await facts(), before, `${name}: forbidden request changed durable/execution facts`)
  cases[name] = result.status
}

try {
  const ordinary = await request("/api/session", "POST", {})
  assert.equal(ordinary.status, 200)
  const admitted = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const setup = yield* GoalChildFixture.prepare(directory)
      return yield* GoalChild.admit((yield* Database.Service).db, yield* SessionV2.Service, setup.admission)
    }),
  )
  const id = admitted.unit.child_session_id
  const baseline = await facts()
  assert.equal(baseline.inputs.length, 1)
  assert(baseline.sessions.every((session) => session.execution_claim_token === null))
  for (const route of [`/api/session/${id}`, `/session/${id}`]) assert.equal((await request(route)).status, 200)
  assert.deepEqual(await facts(), baseline)
  await rejected("nativeAdopt", "/api/session", "POST", { id }, 400, "kind", "GOAL_CHILD_MANAGED")
  await rejected(
    "nativePrompt",
    `/api/session/${id}/prompt`,
    "POST",
    { prompt: { text: "forbidden" }, resume: false },
    409,
    "resource",
    "GOAL_CHILD_MANAGED",
  )
  await rejected(
    "nativeResumePrompt",
    `/api/session/${id}/prompt`,
    "POST",
    { prompt: { text: "forbidden" }, resume: true },
    409,
    "resource",
    "GOAL_CHILD_MANAGED",
  )
  await rejected(
    "nativeCompact",
    `/api/session/${id}/compact`,
    "POST",
    { providerID: "fixture", modelID: "test-model" },
    409,
    "resource",
    "GOAL_CHILD_MANAGED",
  )
  await rejected(
    "compatUpdate",
    `/session/${id}`,
    "PATCH",
    { title: "forbidden" },
    409,
    "resource",
    "GOAL_CHILD_MANAGED",
  )
  await rejected("compatRemove", `/session/${id}`, "DELETE", undefined, 409, "resource", "GOAL_CHILD_MANAGED")
  await rejected("compatFork", `/session/${id}/fork`, "POST", {}, 409, "resource", "GOAL_CHILD_MANAGED")
  await rejected("compatChild", "/session", "POST", { parentID: id }, 409, "resource", "GOAL_CHILD_MANAGED")
  const prompt = await request(`/session/${id}/message`, "POST", { parts: [{ type: "text", text: "forbidden" }] })
  assert.equal(prompt.status, 409, JSON.stringify(prompt))
  assert.match(JSON.stringify(prompt.body), /GOAL_CHILD_MANAGED/)
  cases.compatPrompt = prompt.status
  assert.deepEqual(await facts(), baseline)
  const direct = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const instance = yield* (yield* InstanceStore.Service).load({ directory })
      const session = yield* Session.Service
      const sid = SessionID.make(id)
      const messageID = MessageID.make("msg_forbidden")
      const partID = PartID.make("prt_forbidden")
      const operations: Effect.Effect<unknown, unknown>[] = [
        session.touch(sid),
        session.setPreview({ sessionID: sid, preview: "" }),
        session.setWorkspace({ sessionID: sid, workspaceID: undefined }),
        session.clearRevert(sid),
        session.setShare({ sessionID: sid, share: undefined }),
        session.updateMessage({
          id: messageID,
          sessionID: sid,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("test-model") },
        }),
        session.updatePart({ id: partID, sessionID: sid, messageID, type: "text", text: "forbidden" }),
        session.publishMessageProjection({ sessionID: sid, messageID }),
        session.updatePartDelta({ sessionID: sid, messageID, partID, field: "text", delta: "forbidden" }),
        session.removePart({ sessionID: sid, messageID, partID }),
        session.removeMessage({ sessionID: sid, messageID }),
        session.create({ id: sid }),
        session.create({ parentID: sid }),
        session.setTitle({ sessionID: sid, title: "forbidden" }),
        session.setMetadata({ sessionID: sid, metadata: { internal: true } }),
        session.setArchived({ sessionID: sid, time: Date.now() }),
        session.setDirectory({ sessionID: sid, directory: root }),
        session.setRevert({ sessionID: sid, revert: undefined, summary: undefined }),
        session.setSummary({ sessionID: sid, summary: { additions: 1, deletions: 0, files: 0 } }),
        session.remove(sid),
        session.fork({ sessionID: sid, intentID: "forbidden-fork" }),
      ]
      const errors: string[] = []
      for (const operation of operations) {
        const exit = yield* operation.pipe(Effect.provideService(InstanceRef, instance), Effect.exit)
        assert(Exit.isFailure(exit))
        const error = Cause.squash(exit.cause)
        const description =
          error instanceof GoalChildSchema.Error
            ? error.code
            : String(error instanceof Error ? JSON.stringify(error) : error)
        assert.match(description, /GOAL_CHILD_MANAGED/)
        errors.push(description)
      }
      // Resolve an actual production Location runner, then call it directly without SessionExecution.
      // The guard inside runDrain must still refuse before Agent/model/context/provider work.
      const locations = yield* LocationServiceMap
      const info = yield* (yield* SessionV2.Service).get(SessionSchema.ID.make(id))
      const exit = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: info.id, force: true })).pipe(
        Effect.provide(locations.get(info.location)),
        Effect.exit,
      )
      assert(Exit.isFailure(exit))
      const error = Cause.squash(exit.cause)
      assert(error instanceof GoalChildSchema.Error)
      assert.equal(error.code, "GOAL_CHILD_RECOVERY_REQUIRED")
      return errors
    }),
  )
  assert.deepEqual(await facts(), baseline)
  cases.directMutators = direct.length
  cases.directMainRunner = "GOAL_CHILD_RECOVERY_REQUIRED"
  const ordinaryID = (ordinary.body as { data: { id: string } }).data.id
  assert.equal(
    (await request(`/api/session/${ordinaryID}/prompt`, "POST", { prompt: { text: "ordinary" }, resume: false }))
      .status,
    200,
  )
  assert.equal((await request(`/session/${ordinaryID}`, "PATCH", { title: "ordinary updated" })).status, 200)
  cases.ordinary = 200
  assert.equal(providerRequests.length, 0)
  await Bun.write(path.join(root, "final.json"), JSON.stringify(await facts(), null, 2))
} finally {
  await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
  await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())))
}
await Bun.write(
  path.join(root, "result.json"),
  JSON.stringify(
    { pid: process.pid, database: Database.path(), cases, providerRequests: providerRequests.length, closed: true },
    null,
    2,
  ),
)
