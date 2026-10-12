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
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Server } from "@/server/server"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

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

const binding = {
  ...WorkAuthorityFixture.binding("http"),
  location: { directory },
  provider: { ...WorkAuthorityFixture.binding("http").provider, providerID: "fixture", modelID: "test-model" },
  deadline: Date.now() + 100_000,
}
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
  // Warm the HTTP Location before the refusal baseline. Native middleware necessarily resolves
  // placement before handlers; the oracle checks no additional keyed runtime, not zero lookups.
  const ordinary = await request("/api/session", "POST", {})
  assert.equal(ordinary.status, 200)
  assert(ordinary.body && typeof ordinary.body === "object" && "data" in ordinary.body)
  const ordinaryID = (ordinary.body.data as { id: string }).id
  cases.ordinaryNativeCreate = ordinary.status
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      yield* WorkAuthority.reserve((yield* Database.Service).db, { binding })
    }).pipe(Effect.provide(WorkAuthorityFixture.verifier)),
  )
  await rejected(
    "reservedCreate",
    "/api/session",
    "POST",
    { id: binding.sessionID },
    400,
    "kind",
    "WORK_BINDING_CONFLICT",
  )
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      // The host root exposes its bridge; SessionV2 uses that exact event authority internally.
      const events = yield* EventV2Bridge.Service
      return yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT }).pipe(
        Effect.provideService(EventV2.Service, EventV2.Service.of(events)),
        Effect.provide(WorkAuthorityFixture.verifier),
      )
    }),
  )
  const baseline = await facts()
  assert.equal(baseline.inputs.length, 1)
  assert.equal(baseline.inputs[0].id, binding.inputID)
  assert.equal(baseline.inputs[0].promoted_seq, null)
  assert(baseline.sessions.every((session) => session.execution_claim_token === null))
  assert.equal(baseline.attempts.length, 0)
  assert.equal(baseline.receipts.length, 0)
  assert.equal(baseline.active.length, 0)
  await Bun.write(path.join(root, "baseline.json"), JSON.stringify(baseline, null, 2))

  for (const route of [`/api/session/${binding.sessionID}`, `/session/${binding.sessionID}`]) {
    const existing = await request(route)
    assert.equal(existing.status, 200, `${route}: bound Session remains readable`)
  }
  assert.deepEqual(await facts(), baseline)

  await rejected("boundCreate", "/api/session", "POST", { id: binding.sessionID }, 400, "kind", "WORK_BINDING_CONFLICT")
  await rejected(
    "nativePromptAdmit",
    `/api/session/${binding.sessionID}/prompt`,
    "POST",
    {
      id: binding.inputID,
      prompt: { text: WorkAuthorityFixture.TEXT },
      delivery: "queue",
      resume: false,
    },
    503,
    "service",
    "PROFILE_UNAVAILABLE",
  )
  await rejected(
    "nativePromptResume",
    `/api/session/${binding.sessionID}/prompt`,
    "POST",
    {
      prompt: { text: "Public bypass attempt" },
      resume: true,
    },
    503,
    "service",
    "PROFILE_UNAVAILABLE",
  )
  await rejected(
    "nativeCompact",
    `/api/session/${binding.sessionID}/compact`,
    "POST",
    {
      providerID: "fixture",
      modelID: "test-model",
    },
    503,
    "service",
    "PROFILE_UNAVAILABLE",
  )
  await rejected(
    "compatUpdate",
    `/session/${binding.sessionID}`,
    "PATCH",
    { title: "forbidden" },
    409,
    "resource",
    "PROFILE_UNAVAILABLE",
  )
  await rejected(
    "compatRemove",
    `/session/${binding.sessionID}`,
    "DELETE",
    undefined,
    409,
    "resource",
    "PROFILE_UNAVAILABLE",
  )
  await rejected("compatFork", `/session/${binding.sessionID}/fork`, "POST", {}, 409, "resource", "PROFILE_UNAVAILABLE")
  await rejected("compatChild", "/session", "POST", { parentID: binding.sessionID }, 400, "kind", "PROFILE_UNAVAILABLE")

  const beforePrompt = await facts()
  const prompt = await request(`/session/${binding.sessionID}/message`, "POST", {
    parts: [{ type: "text", text: "Public compatibility bypass" }],
  })
  await Bun.write(path.join(root, "compatPrompt.json"), JSON.stringify(prompt, null, 2))
  assert.equal(prompt.status, 409, JSON.stringify(prompt.body))
  assert(prompt.body && typeof prompt.body === "object" && "message" in prompt.body)
  assert.match(String(prompt.body.message), /PROFILE_UNAVAILABLE/)
  assert.deepEqual(await facts(), beforePrompt)
  cases.compatPrompt = prompt.status

  const direct = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const instance = yield* (yield* InstanceStore.Service).load({ directory })
      return yield* (yield* Session.Service)
        .fork({ sessionID: SessionID.make(binding.sessionID), intentID: "blocked-direct-fork" })
        .pipe(Effect.provideService(InstanceRef, instance), Effect.exit)
    }),
  )
  assert(Exit.isFailure(direct))
  const error = Cause.squash(direct.cause)
  assert(error instanceof Session.ForkConflict)
  assert.match(error.reason, /PROFILE_UNAVAILABLE/)
  assert.deepEqual(await facts(), baseline)
  cases.directFork = "PROFILE_UNAVAILABLE"

  const accepted = await request(`/api/session/${ordinaryID}/prompt`, "POST", {
    prompt: { text: "ordinary admit only" },
    resume: false,
  })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  cases.ordinaryNativePrompt = accepted.status
  const compatibility = await request("/session", "POST", { title: "Ordinary compatibility control" })
  assert.equal(compatibility.status, 200, JSON.stringify(compatibility.body))
  assert(compatibility.body && typeof compatibility.body === "object" && "id" in compatibility.body)
  const compatibilityID = String(compatibility.body.id)
  cases.ordinaryCompatCreate = compatibility.status
  const updated = await request(`/session/${compatibilityID}`, "PATCH", { title: "Still writable" })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  cases.ordinaryCompatUpdate = updated.status
  const forked = await request(`/session/${compatibilityID}/fork`, "POST", {})
  assert.equal(forked.status, 200, JSON.stringify(forked.body))
  cases.ordinaryCompatFork = forked.status
  const final = await facts()
  assert.equal(final.inputs.filter((input) => input.session_id === ordinaryID).length, 1)
  assert.deepEqual(
    final.inputs.filter((input) => input.session_id === binding.sessionID),
    baseline.inputs,
  )
  assert.equal(final.attempts.length, 0)
  assert.equal(final.receipts.length, 0)
  assert.equal(final.active.length, 0)
  assert(final.sessions.every((session) => session.execution_claim_token === null))
  assert.equal(providerRequests.length, 0)
  await Bun.write(path.join(root, "final.json"), JSON.stringify(final, null, 2))
} finally {
  await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
  await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())))
}
await Bun.write(
  path.join(root, "result.json"),
  JSON.stringify(
    {
      pid: process.pid,
      database: path.join(root, "authority.sqlite"),
      cases,
      providerRequests: providerRequests.length,
      fixtureDevMint: true,
      trustedSource: "test_work_source/test_work_route only; no production operator proof",
      closed: true,
    },
    null,
    2,
  ),
)
