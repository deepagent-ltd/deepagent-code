// A real isolated HTTP/SQLite oracle. Trusted fixture setup is separate from the GET read census.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildFixture } from "../../../../core/test/fixture/goal-child"
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { Hash } from "@deepagent-code/core/util/hash"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Server } from "@/server/server"

const root = process.argv[2]!
const directory = path.join(root, "project")
const cases: Record<string, { status: number; ordinaryEligible?: boolean }> = {}
const providerRequests: string[] = []
const provider = createServer((request, response) => {
  providerRequests.push(request.url ?? "unknown")
  response.writeHead(500, { "content-type": "application/json" }).end('{"error":"unexpected provider request"}')
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
assert(address && typeof address !== "string")
await Bun.write(path.join(directory, "deepagent-code.json"), JSON.stringify({
  formatter: false,
  lsp: false,
  model: "fixture/test-model",
  provider: {
    fixture: {
      name: "Read-only tripwire",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
      models: { "test-model": { name: "Fixture", limit: { context: 100_000, output: 10_000 } } },
    },
  },
}))
const rg = Bun.which(process.platform === "win32" ? "rg.exe" : "rg")
assert(rg, "This offline fixture requires an installed ripgrep")
await fs.mkdir(path.join(root, "data/cache/bin"), { recursive: true })
await fs.copyFile(rg, path.join(root, "data/cache/bin", path.basename(rg)))
await AppRuntime.runPromise(WorkAuthorityFixture.initialize())
assert.equal(Database.path(), path.join(root, "authority.sqlite"))
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })

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

async function create(id?: string) {
  const result = await request("/api/session", "POST", id ? { id } : {})
  assert.equal(result.status, 200)
  assert(result.body && typeof result.body === "object" && "data" in result.body)
  assert(result.body.data && typeof result.body.data === "object" && "id" in result.body.data)
  assert.equal(typeof result.body.data.id, "string")
  assert.equal("ordinaryEligible" in result.body.data, false, "Core create keeps its existing DTO")
  return String(result.body.data.id)
}

const facts = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
  const rows = yield* Effect.forEach(tables, (table) => {
    assert.match(table.name, /^[a-zA-Z0-9_]+$/)
    return db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${table.name}"`))
      .pipe(Effect.map((rows) => ({ table: table.name, rows })))
  })
  return {
    durableHash: Hash.sha256(JSON.stringify(rows)),
    totalChanges: yield* db.all<{ count: number }>("SELECT total_changes() count"),
    active: [...(yield* (yield* SessionExecution.Service).active)].sort(),
    attempts: yield* db.all("SELECT * FROM session_provider_attempt"),
    receipts: yield* db.all("SELECT * FROM session_v2_provider_turn_receipt"),
    providerRequests: [...providerRequests],
  }
}))

const queryOnly = (enabled: boolean) => AppRuntime.runPromise(Database.Service.pipe(Effect.flatMap(({ db }) =>
  db.run(enabled ? "PRAGMA query_only=ON" : "PRAGMA query_only=OFF"))))

async function read(name: string, id: string, ordinaryEligible: boolean) {
  const before = await facts()
  const result = await request(`/session/${id}`)
  assert.equal(result.status, 200, name)
  assert(result.body && typeof result.body === "object" && "id" in result.body)
  assert.equal(result.body.id, id)
  assert("ordinaryEligible" in result.body)
  assert.equal(result.body.ordinaryEligible, ordinaryEligible, name)
  assert.deepEqual(await facts(), before, `${name}: GET changed durable/execution facts`)
  cases[name] = { status: result.status, ordinaryEligible }
}

try {
  // Normal middleware startup is warmed before the readonly request census.
  const ordinary = await create()
  const prefixHint = await create("ses_work_ordinary_prefix_only")
  const notAdopted = await create()
  const descendant = await create()
  const goalDescendant = await create()
  const binding = {
    ...WorkAuthorityFixture.binding("ordinary-read"),
    location: { directory },
    deadline: Date.now() + 100_000,
  }
  await AppRuntime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT }).pipe(
      Effect.provideService(EventV2.Service, EventV2.Service.of(events)),
      Effect.provide(WorkAuthorityFixture.verifier),
    )
    // Historical ancestry and non-adopted rows are fixture facts, never grants or execution witnesses.
    const db = (yield* Database.Service).db
    yield* db.run(sql`UPDATE session SET parent_id=${binding.sessionID} WHERE id=${descendant}`)
    yield* db.run(sql`UPDATE session SET v2_authority=0 WHERE id=${notAdopted}`)
  }))
  const goal = await AppRuntime.runPromise(Effect.gen(function* () {
    const setup = yield* GoalChildFixture.prepare(directory)
    return yield* GoalChild.admit((yield* Database.Service).db, yield* SessionV2.Service, setup.admission)
  }))
  await AppRuntime.runPromise(Database.Service.pipe(Effect.flatMap(({ db }) =>
    db.run(sql`UPDATE session SET parent_id=${goal.unit.child_session_id} WHERE id=${goalDescendant}`))))
  // The production root owns background maintenance too. Fence this private SQLite connection
  // during the GET census so unrelated timers cannot write between before/after observations.
  // A GET that attempted a write would fail on the actual connection instead of passing the oracle.
  await queryOnly(true)

  await read("ordinary", ordinary, true)
  await read("prefixIsNotAuthority", prefixHint, true)
  await read("boundSelf", binding.sessionID, false)
  await read("boundAncestor", descendant, false)
  await read("goalChild", goal.unit.child_session_id, false)
  await read("goalChildAncestor", goalDescendant, false)
  await read("notAdopted", notAdopted, false)

  const coreRead = await request(`/api/session/${binding.sessionID}`)
  assert.equal(coreRead.status, 200)
  assert(coreRead.body && typeof coreRead.body === "object" && "data" in coreRead.body)
  assert(coreRead.body.data && typeof coreRead.body.data === "object")
  assert.equal("ordinaryEligible" in coreRead.body.data, false, "Core GET DTO is unchanged")
  await queryOnly(false)
  const mutationBaseline = await facts()
  const mutation = await request(`/session/${binding.sessionID}`, "PATCH", { title: "not authorized by a display boolean" })
  assert.equal(mutation.status, 409)
  const mutationAfter = await facts()
  assert.equal(mutationAfter.durableHash, mutationBaseline.durableHash)
  assert.deepEqual(mutationAfter.active, mutationBaseline.active)
  assert.deepEqual(mutationAfter.attempts, mutationBaseline.attempts)
  assert.deepEqual(mutationAfter.receipts, mutationBaseline.receipts)
  assert.deepEqual(mutationAfter.providerRequests, mutationBaseline.providerRequests)
  // SQLite total_changes includes the rejected mutator's rolled-back transaction. The GETs above
  // compare both that counter and the full persisted rows; this mutator only promises rollback.
  cases.boundMutationStillRefused = { status: mutation.status }

  // Corrupt only this owned test record: an unexpected typed guard failure must be 503, not false/true.
  await AppRuntime.runPromise(Database.Service.pipe(Effect.flatMap(({ db }) =>
    db.run(sql`UPDATE goal_child_unit SET binding_hash=${"f".repeat(64)} WHERE unit_id=${goal.unit.unit_id}`))))
  await queryOnly(true)
  const typedBaseline = await facts()
  const typed = await request(`/session/${goal.unit.child_session_id}`)
  assert.equal(typed.status, 503)
  assert.deepEqual(typed.body, {
    _tag: "ServiceUnavailableError", service: "session.ordinary-eligibility", message: "Session eligibility could not be read",
  })
  assert.deepEqual(await facts(), typedBaseline)
  cases.unexpectedTyped = { status: typed.status }

  // A real failed SQL read exercises Effect.orDie; the GET must not turn a defect into eligibility.
  await queryOnly(false)
  await AppRuntime.runPromise(Database.Service.pipe(Effect.flatMap(({ db }) =>
    db.run("ALTER TABLE work_execution RENAME TO fixture_unavailable_work_execution"))))
  await queryOnly(true)
  try {
    const defectBaseline = await facts()
    const defect = await request(`/session/${ordinary}`)
    assert.equal(defect.status, 503)
    assert.deepEqual(defect.body, typed.body)
    assert.deepEqual(await facts(), defectBaseline)
    cases.storageDefect = { status: defect.status }
  } finally {
    await queryOnly(false)
    await AppRuntime.runPromise(Database.Service.pipe(Effect.flatMap(({ db }) =>
      db.run("ALTER TABLE fixture_unavailable_work_execution RENAME TO work_execution"))))
    await queryOnly(true)
  }
  const missingBaseline = await facts()
  const missing = await request("/session/ses_missing_ordinary_eligibility")
  assert.equal(missing.status, 404)
  assert.deepEqual(await facts(), missingBaseline)
  cases.missing = { status: missing.status }
  const final = await facts()
  assert.equal(final.providerRequests.length, 0)
  assert.equal(final.attempts.length, 0)
  assert.equal(final.receipts.length, 0)
  assert.equal(final.active.length, 0)
} finally {
  await queryOnly(false)
  await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
  await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
}
await Bun.write(path.join(root, "result.json"), JSON.stringify({
  pid: process.pid, database: path.join(root, "authority.sqlite"), cases,
  providerRequests: providerRequests.length, readsChangedDurableFacts: false,
  fixtureSetupWrites: true, sqliteReadCensusQueryOnly: true, productionCoreChanged: false, closed: true,
}, null, 2))
