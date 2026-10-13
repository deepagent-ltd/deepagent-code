import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { McpAuthJournal } from "../../src/mcp/auth-journal"
import { McpAuthJournalSchema } from "../../src/mcp/auth-journal-schema"
import { McpAuthJournalStore } from "../../src/mcp/auth-journal-store"
import { PrivateSqlite } from "@deepagent-code/core/database/private-sqlite"

const configured = process.env.DAC_CALLBACK_ROOT
assert(configured && path.basename(configured).startsWith("dac-mcp-callback-"))
const root = await fs.realpath(configured)
assert.equal(root, configured)
const mode = process.argv[2]
const name = process.argv[3] ?? "one"
const tag = "1".repeat(64)
const slot = "2".repeat(64)
const file = path.join(root, "private", "journal.sqlite")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function barrier(key: string) {
  const deadline = Date.now() + 25000
  while (
    !(await fs.stat(path.join(root, key)).then(
      () => true,
      () => false,
    ))
  ) {
    assert(Date.now() < deadline, `Callback fixture barrier timed out: ${key}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

if (mode.startsWith("journal-")) {
  if (mode === "journal-seed") {
    const store = await McpAuthJournal.open(file, tag, "write")
    assert(store)
    const now = Date.now()
    const handle = store.begin({
      slot,
      explicit: false,
      binding: {
        version: 1,
        installationID: "storage-only-fixture",
        namespace: "sec_fixture",
        location: "loc_fixture",
        project: "prj_fixture",
        rootTag: tag,
        principal: { kind: "local", selectionRevision: 0 },
        name: "fixture",
        resource: "http://127.0.0.1:1/mcp",
        sourceTag: tag,
        configurationTag: tag,
        credentialTag: tag,
      },
      flow: {
        version: 1,
        id: randomBytes(32).toString("hex"),
        owner: randomBytes(32).toString("hex"),
        state: randomBytes(32).toString("hex"),
        phase: "preparing",
        createdAt: now,
        expiresAt: now + 300000,
        redirectUri: "http://127.0.0.1:1/callback",
      },
    })
    store.updateFlow(handle, {
      discovery: { authorizationServerUrl: "http://127.0.0.1:1" },
      verifier: "v".repeat(43),
      discoveryTag: tag,
      phase: "awaiting_callback",
    })
    store.settle(store.dispatch(handle, { kind: "exchange", requestTag: tag, endpointTag: tag }), {
      phase: "committed",
      credentials: {
        clientInfo: { clientId: "retained-client", issuer: "http://127.0.0.1:1" },
        tokens: { accessToken: "fixture-token", refreshToken: "fixture-refresh", issuer: "http://127.0.0.1:1" },
      },
      outcome: { code: "committed" },
    })
    store.updateFlow(handle, { phase: "connected" })
    store.close()
    // Construct a populated predecessor from its unchanged SQL, with identical rows.
    const source = new PrivateSqlite.Database(file, { readwrite: true, create: false })
    const rows = {
      meta: source.query("SELECT * FROM mcp_auth_meta").all(),
      slots: source.query("SELECT * FROM mcp_auth_slot").all(),
      operations: source.query("SELECT * FROM mcp_oauth_operation").all(),
    }
    source.close()
    await fs.unlink(file)
    await fs.writeFile(file, "", { mode: 0o600 })
    const previous = new PrivateSqlite.Database(file, { readwrite: true, create: false })
    previous.exec(McpAuthJournalSchema.SQL)
    for (const [table, values] of [
      ["mcp_auth_meta", rows.meta],
      ["mcp_auth_slot", rows.slots],
      ["mcp_oauth_operation", rows.operations],
    ] as const) {
      for (const row of values) {
        const value = row as Record<string, string | number | null>
        previous
          .query(
            `INSERT INTO ${table}(${Object.keys(value).join(",")}) VALUES(${Object.keys(value)
              .map(() => "?")
              .join(",")})`,
          )
          .run(...Object.values(value))
      }
    }
    previous.exec("PRAGMA user_version=1")
    previous.close()
    await fs.writeFile(path.join(root, "v1-rows.json"), JSON.stringify(rows), { mode: 0o600 })
    console.log(JSON.stringify({ mode, schemaHash: hash(Buffer.from(McpAuthJournalSchema.SQL)), populated: true }))
    process.exit(0)
  }
  const before = hash(await fs.readFile(file))
  const identity = await fs.stat(file)
  if (mode === "journal-read") {
    const store = await McpAuthJournal.open(file, tag, "read")
    assert.equal(store?.read(slot)?.credentials.tokens?.accessToken, "fixture-token")
    store?.close()
    assert.equal(hash(await fs.readFile(file)), before)
    console.log(
      JSON.stringify({
        mode,
        pid: process.pid,
        before,
        after: before,
        readonly: true,
        dev: identity.dev,
        inode: identity.ino,
      }),
    )
    process.exit(0)
  }
  if (mode === "journal-commit-loss") {
    const exec = PrivateSqlite.Database.prototype.exec
    const count = { commits: 0 }
    PrivateSqlite.Database.prototype.exec = function (text: string) {
      const result = exec.call(this, text)
      if (text === "COMMIT" && ++count.commits === 1)
        throw new Error("fixture lost COMMIT return after actual native SQLite commit")
      return result
    }
    try {
      await assert.rejects(
        () => McpAuthJournalStore.open(file, tag, "write"),
        (error) => error instanceof McpAuthJournalSchema.Error && error.reason === "unknown",
      )
    } finally {
      PrivateSqlite.Database.prototype.exec = exec
    }
    assert.equal(count.commits, 1)
    const readonly = await McpAuthJournalStore.open(file, tag, "read")
    assert(readonly)
    readonly.read((db) =>
      assert.equal((db.query("PRAGMA user_version").get() as { user_version: number }).user_version, 2),
    )
    readonly.close()
    console.log(
      JSON.stringify({
        mode,
        commitReturnFaultInjected: true,
        actualCommitCount: 1,
        result: "unknown",
        readonlyVersion: 2,
        pid: process.pid,
      }),
    )
    process.exit(0)
  }
  if (mode === "journal-invalid" || mode === "journal-capacity") {
    const db = new PrivateSqlite.Database(file, { readwrite: true, create: false })
    if (mode === "journal-invalid") {
      if (name === "partial") db.exec(McpAuthJournalSchema.EXTENSION_SQL)
      if (name === "extra") db.exec("CREATE TABLE unexpected(id INTEGER)")
      if (name === "shape")
        db.query("UPDATE mcp_auth_slot SET credentials=?").run('{"tokens":{"accessToken":"fixture"}}')
    } else {
      const original = db.query("SELECT * FROM mcp_auth_slot").get() as Record<string, string | number | null>
      const target = McpAuthJournalSchema.LIMITS.logicalBytes - 256
      const used = () =>
        Number(
          (
            db
              .query(
                "SELECT (SELECT COALESCE(SUM(length(CAST(binding AS BLOB))+length(CAST(credentials AS BLOB))+length(CAST(flow AS BLOB))+512),0) FROM mcp_auth_slot)+(SELECT COALESCE(SUM(length(CAST(outcome AS BLOB))+1024),0) FROM mcp_oauth_operation) total",
              )
              .get() as { total: number }
          ).total,
        )
      db.exec("BEGIN IMMEDIATE")
      for (let count = 1; used() < target; count++) {
        assert(count < 256)
        const fixed = Buffer.byteLength(String(original.binding)) + 4 + 512
        const credentials = {
          tokens: { accessToken: "a".repeat(16000), refreshToken: "r".repeat(16000), issuer: "http://127.0.0.1:1" },
          clientInfo: { clientId: "c".repeat(16000), clientSecret: "s".repeat(16000), issuer: "http://127.0.0.1:1" },
        }
        const available = target - used() - fixed
        const full = Buffer.byteLength(JSON.stringify(credentials))
        if (available < full) {
          let remove = full - available
          for (const [object, key] of [
            [credentials.clientInfo, "clientSecret"],
            [credentials.clientInfo, "clientId"],
            [credentials.tokens, "refreshToken"],
            [credentials.tokens, "accessToken"],
          ] as const) {
            const previous = object[key as keyof typeof object] as string
            const length = Math.min(previous.length, remove)
            Object.assign(object, { [key]: previous.slice(length) })
            remove -= length
          }
          assert.equal(remove, 0)
        }
        const value = {
          ...original,
          slot_key: count.toString(16).padStart(64, "0"),
          credentials: JSON.stringify(credentials),
          flow: "null",
        }
        db.query(
          `INSERT INTO mcp_auth_slot(${Object.keys(value).join(",")}) VALUES(${Object.keys(value)
            .map(() => "?")
            .join(",")})`,
        ).run(...Object.values(value))
      }
      assert.equal(used(), target)
      db.exec("COMMIT")
    }
    const originalRows = db.query("SELECT * FROM mcp_auth_slot ORDER BY slot_key").all()
    const originalSchema = db.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all()
    db.close()
    const beforeFailure = hash(await fs.readFile(file))
    await assert.rejects(
      () => McpAuthJournalStore.open(file, tag, "write"),
      (error) =>
        error instanceof McpAuthJournalSchema.Error &&
        error.reason === (mode === "journal-capacity" ? "capacity" : "invalid"),
    )
    const after = new PrivateSqlite.Database(file, { readonly: true, create: false })
    assert.equal((after.query("PRAGMA user_version").get() as { user_version: number }).user_version, 1)
    assert.deepEqual(after.query("SELECT * FROM mcp_auth_slot ORDER BY slot_key").all(), originalRows)
    assert.deepEqual(after.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all(), originalSchema)
    after.close()
    assert.equal(hash(await fs.readFile(file)), beforeFailure)
    console.log(
      JSON.stringify({
        mode,
        name,
        rejected: true,
        rollbackByteIdentical: true,
        before: beforeFailure,
        pid: process.pid,
      }),
    )
    process.exit(0)
  }
  const store = await McpAuthJournalStore.open(file, tag, "write")
  assert(store)
  const rows = store.read((db) => ({
    meta: db.query("SELECT * FROM mcp_auth_meta").all(),
    slots: db.query("SELECT * FROM mcp_auth_slot").all(),
    operations: db.query("SELECT * FROM mcp_oauth_operation").all(),
  }))
  assert.equal(JSON.stringify(rows), await fs.readFile(path.join(root, "v1-rows.json"), "utf8"))
  store.read((db) => {
    assert.equal((db.query("PRAGMA user_version").get() as { user_version: number }).user_version, 2)
    assert.equal(db.query("SELECT * FROM mcp_auth_extension").all().length, 1)
  })
  assert.throws(() =>
    store.transaction((db) => {
      db.query("UPDATE mcp_auth_extension SET created_at=created_at+1").run()
      throw new Error("actual transaction rollback")
    }),
  )
  store.transaction((db) => {
    for (const [field, value] of [
      ["id", Buffer.from("1")],
      ["version", Buffer.from("2")],
      ["base_schema_sha256", Buffer.from(tag)],
      ["created_at", -1],
    ] as const)
      assert.throws(() => db.query(`UPDATE mcp_auth_extension SET ${field}=?`).run(value as never))
  })
  store.close()
  assert.equal((await fs.stat(file)).ino, identity.ino)
  console.log(
    JSON.stringify({
      mode,
      pid: process.pid,
      rowsRetained: true,
      version: 2,
      rollback: true,
      dev: identity.dev,
      inode: identity.ino,
    }),
  )
  process.exit(0)
}

const { Effect, Layer } = await import("effect")
const { MCP } = await import("../../src/mcp/index")
const { InstanceStore } = await import("../../src/project/instance-store")
const { InstanceBootstrap } = await import("../../src/project/bootstrap-service")
const { McpAuthScope } = await import("../../src/mcp/auth-scope")
const { Config } = await import("../../src/config/config")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { Flag } = await import("@deepagent-code/core/flag/flag")
const directory = path.join(root, "project")
const journalPath = path.join(root, "home", ".deepagent", "code", "mcp-oauth", "journal.sqlite")
const layer = Layer.mergeAll(
  MCP.defaultLayer,
  McpAuthScope.defaultLayer,
  Config.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void }))),
)

function run(owner: string) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const instances = yield* InstanceStore.Service
        const instance = yield* instances.load({ directory })
        yield* Effect.addFinalizer(() => instances.dispose(instance))
        return yield* instances.provide(
          { directory },
          Effect.gen(function* () {
            const mcp = yield* MCP.Service
            if (mode === "cold-read") {
              const before = hash(yield* Effect.promise(() => fs.readFile(journalPath)))
              assert.deepEqual((yield* mcp.status()).probe, {
                status: "disconnected",
                authStatus: "unknown",
                reason: "unknown_outcome",
              })
              assert.equal((yield* mcp.connect("probe").pipe(Effect.exit))._tag, "Failure")
              assert.equal((yield* mcp.startAuth("probe").pipe(Effect.exit))._tag, "Failure")
              assert.equal(McpOAuthCallback.isRunning(), false)
              assert.equal(hash(yield* Effect.promise(() => fs.readFile(journalPath))), before)
              const db = new PrivateSqlite.Database(journalPath, { readonly: true, create: false })
              const operations = db
                .query("SELECT kind,phase,COUNT(*) n FROM mcp_oauth_operation GROUP BY kind,phase")
                .all()
              db.close()
              const identity = yield* Effect.promise(() => fs.stat(journalPath))
              yield* Effect.promise(() =>
                fs.writeFile(
                  path.join(root, `${owner}.result.json`),
                  JSON.stringify({
                    pid: process.pid,
                    operations,
                    dev: identity.dev,
                    inode: identity.ino,
                    unchanged: true,
                    listener: false,
                  }),
                ),
              )
              return
            }
            const start = yield* mcp.startAuth("probe")
            assert(start.authorizationUrl)
            const redirectUri = new URL(start.authorizationUrl).searchParams.get("redirect_uri")!
            if (new URL(redirectUri).protocol === "https:") assert.equal(McpOAuthCallback.isRunning(), false)
            yield* Effect.promise(() =>
              fs.writeFile(path.join(root, `${owner}.ready.json`), JSON.stringify({ pid: process.pid, redirectUri })),
            )
            yield* Effect.promise(() => barrier(`go-${owner}`))
            const response = yield* Effect.promise(() => fetch(start.authorizationUrl, { redirect: "manual" }))
            assert.equal(response.status, 302)
            const callback = new URL(response.headers.get("location")!)
            assert.equal(callback.searchParams.get("state"), start.oauthState)
            const automatic =
              callback.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(callback.hostname)
            if (automatic) {
              for (const mutation of ["wrong-path", "duplicate-state", "wrong-issuer"]) {
                const bad = new URL(callback)
                if (mutation === "wrong-path") bad.pathname += "/wrong"
                if (mutation === "duplicate-state") bad.searchParams.append("state", start.oauthState)
                if (mutation === "wrong-issuer") bad.searchParams.set("iss", "https://wrong.invalid")
                assert.equal((yield* Effect.promise(() => fetch(bad))).status, 400)
              }
              assert.equal((yield* Effect.promise(() => fetch(callback))).status, 200)
              assert.equal((yield* Effect.promise(() => fetch(callback))).status, 400)
            }
            const finished = yield* mcp.finishAuth(
              "probe",
              callback.searchParams.get("code")!,
              start.oauthState,
              callback.searchParams.get("iss") ?? undefined,
            )
            assert.equal(finished.status, "connected")
            if (mode === "reuse") {
              const { createServer } = yield* Effect.promise(() => import("node:http"))
              const occupied = createServer()
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => {
                    occupied.once("error", reject)
                    occupied.listen(Number(new URL(redirectUri).port), "127.0.0.1", resolve)
                  }),
              )
              const blocked = yield* mcp.startAuth("probe").pipe(Effect.exit)
              assert.equal(blocked._tag, "Failure")
              assert.equal(yield* mcp.hasStoredTokens("probe"), true)
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) =>
                    occupied.close((error) => (error ? reject(error) : resolve())),
                  ),
              )
              const repeat = yield* mcp.startAuth("probe")
              assert.equal(new URL(repeat.authorizationUrl).searchParams.get("redirect_uri"), redirectUri)
              assert.notEqual(repeat.oauthState, start.oauthState)
              assert.equal((yield* Effect.promise(() => fetch(callback))).status, 400)
              const auth = yield* Effect.promise(() => fetch(repeat.authorizationUrl, { redirect: "manual" }))
              const reply = new URL(auth.headers.get("location")!)
              assert.equal((yield* Effect.promise(() => fetch(reply))).status, 200)
              assert.equal(
                (yield* mcp.finishAuth(
                  "probe",
                  reply.searchParams.get("code")!,
                  repeat.oauthState,
                  reply.searchParams.get("iss")!,
                )).status,
                "connected",
              )
              yield* mcp.disconnect("probe")
              const raw = new PrivateSqlite.Database(journalPath, { readwrite: true, create: false })
              raw.exec("BEGIN IMMEDIATE")
              raw
                .query(
                  "UPDATE mcp_auth_slot SET credentials=json_remove(credentials,'$.clientInfo.registeredRedirectUris') WHERE json_extract(flow,'$.redirectUri')=?",
                )
                .run(redirectUri)
              raw
                .query(
                  "UPDATE mcp_auth_slot SET credentials=json_set(credentials,'$.tokens.expiresAt',?) WHERE json_extract(flow,'$.redirectUri')=?",
                )
                .run(Math.floor(Date.now() / 1000) - 1, redirectUri)
              const expired = raw
                .query(
                  "SELECT json_extract(credentials,'$.tokens.accessToken') token FROM mcp_auth_slot WHERE json_extract(flow,'$.redirectUri')=?",
                )
                .get(redirectUri) as { token: string }
              raw.exec("COMMIT")
              raw.close()
              yield* Effect.promise(() =>
                fetch(new URL("/fixture-expire", start.authorizationUrl), {
                  method: "POST",
                  headers: { authorization: `Bearer ${expired.token}` },
                }),
              )
              yield* mcp.connect("probe")
              assert.equal((yield* mcp.status()).probe.status, "connected")
              const checked = new PrivateSqlite.Database(journalPath, { readonly: true, create: false })
              const preserved = checked
                .query("SELECT credentials FROM mcp_auth_slot WHERE json_extract(flow,'$.redirectUri')=?")
                .get(redirectUri)
              assert.equal((yield* mcp.startAuth("probe").pipe(Effect.exit))._tag, "Failure")
              assert.deepEqual(
                checked
                  .query("SELECT credentials FROM mcp_auth_slot WHERE json_extract(flow,'$.redirectUri')=?")
                  .get(redirectUri),
                preserved,
              )
              checked.close()
            }
            const db = new PrivateSqlite.Database(journalPath, { readonly: true, create: false })
            const rows = db
              .query(
                "SELECT slot_key,json_extract(binding,'$.namespace') namespace,json_extract(binding,'$.location') location,json_extract(credentials,'$.clientInfo.registeredRedirectUris') registered FROM mcp_auth_slot ORDER BY slot_key",
              )
              .all()
            db.close()
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(root, `${owner}.result.json`),
                JSON.stringify({ owner, pid: process.pid, redirectUri, automatic, connected: true, rows }),
              ),
            )
            yield* Effect.promise(() => barrier(`close-${owner}`))
          }),
        )
      }),
    ).pipe(Effect.provide(layer)),
  ).then(() =>
    fs.writeFile(path.join(root, `${owner}.closed.json`), JSON.stringify({ pid: process.pid, closed: true })),
  )
}

if (mode === "two-roots") {
  Flag.DEEPAGENT_CODE_DB = path.join(root, "home", ".deepagent", "code", "a.sqlite")
  const first = run("a")
  await Promise.race([
    barrier("a.ready.json"),
    first.then(() => {
      throw new Error("first Root ended before readiness")
    }),
  ])
  Flag.DEEPAGENT_CODE_DB = path.join(root, "home", ".deepagent", "code", "b.sqlite")
  const second = run("b")
  await Promise.all([first, second])
} else await run(name)
console.log(JSON.stringify({ mode, pid: process.pid, completed: true }))
