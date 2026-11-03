import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { McpAuthJournal } from "../../src/mcp/auth-journal"
import { McpAuthJournalStore } from "../../src/mcp/auth-journal-store"
import { McpAuthJournalSchema } from "../../src/mcp/auth-journal-schema"
import type { McpWindowsStorage } from "../../src/mcp/windows-storage"
import { Global } from "@deepagent-code/core/global"

const configuredRoot = process.env.DAC_MCP_JOURNAL_ROOT
assert(configuredRoot && path.basename(configuredRoot).startsWith("dac-mcp-journal-"))
const root = await fs.realpath(configuredRoot)

export async function main() {
  if (process.platform !== "win32") return journal()
  const { NativeWindowsBootstrap } = await import("../../src/installation/windows-native-bootstrap")
  await NativeWindowsBootstrap.installFixedEntry()
  const { Context, Effect, Layer } = await import("effect")
  const { NativeInstallation } = await import("../../src/installation/native-installation")
  const { NativeWindowsWorkFactory } = await import("../../src/installation/windows-work-factory")
  const { McpWindowsStorage } = await import("../../src/mcp/windows-storage")
  const { EffectFlock } = await import("@deepagent-code/core/util/effect-flock")
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const installation = yield* NativeInstallation.current()
        const bootstrap = yield* NativeWindowsBootstrap.make(installation)
        assert.equal(bootstrap.description.preloaded, true)
        assert(NativeWindowsBootstrap.describe(bootstrap.capture))
        const native = Layer.succeed(NativeWindowsBootstrap.Service, bootstrap)
        const { WindowsSettingsStorage } = yield* Effect.promise(() => import("../../src/installation/windows-settings-storage"))
        const { WindowsPrivateStorage } = yield* Effect.promise(() => import("../../src/installation/windows-private-storage"))
        yield* Layer.build(WindowsSettingsStorage.layer.pipe(Layer.provide(native)))
        yield* WindowsPrivateStorage.make("mcp_secret_envelopes", true).pipe(
          Effect.asVoid, Effect.scoped, Effect.provideService(NativeWindowsBootstrap.Service, bootstrap),
          Effect.catchTag("WindowsPrivateStorageError", () => Effect.void),
        )
        const work = yield* Layer.build(NativeWindowsWorkFactory.layer.pipe(Layer.provide(native)))
        const storage = yield* Layer.build(
          McpWindowsStorage.layer.pipe(
            Layer.provide(native),
            Layer.provide(Layer.succeedContext(work)),
            Layer.provide(EffectFlock.defaultLayer),
          ),
        )
        const port = Context.get(storage, McpWindowsStorage.Current)
        assert(port)
        return yield* Effect.promise(() => journal(port))
      }),
    ),
  )
}

async function journal(nativePort?: McpWindowsStorage.Port) {
  const mode = process.argv[2]
  const file = nativePort
    ? path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
    : path.join(root, "private", "auth.sqlite")
  const tag = "1".repeat(64)
  const slot = "2".repeat(64)
  const binding = {
    version: 1 as const,
    installationID: "synthetic-storage-fixture",
    namespace: "sec_fixture",
    location: "loc_fixture",
    project: "prj_fixture",
    rootTag: tag,
    principal: { kind: "local" as const, selectionRevision: 0 },
    name: "fixture",
    resource: "http://127.0.0.1:1/mcp",
    sourceTag: tag,
    configurationTag: tag,
    credentialTag: tag,
  }
  const freshFlow = () => ({
    version: 1 as const,
    id: randomBytes(32).toString("hex"),
    owner: randomBytes(32).toString("hex"),
    state: randomBytes(32).toString("hex"),
    phase: "preparing" as const,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300000,
    redirectUri: "http://127.0.0.1:1/callback",
  })

  if (process.platform === "win32" && !nativePort) {
    await assert.rejects(() => McpAuthJournal.open(file, tag, "read"), McpAuthJournalSchema.Error)
    console.log(JSON.stringify({ mode, pid: process.pid, nativeRequired: true }))
    return
  }
  if (mode === "missing-read") {
    assert.equal(await McpAuthJournal.open(file, tag, "read", nativePort), undefined)
    assert.equal(
      await fs.stat(path.dirname(file)).then(
        () => true,
        () => false,
      ),
      false,
    )
    console.log(JSON.stringify({ mode, pid: process.pid, created: false }))
    return
  }

  const journal = await McpAuthJournal.open(file, tag, mode === "read" ? "read" : "write", nativePort)
  assert(journal)
  try {
    if (mode === "contend") {
      try {
        const handle = journal.begin({ slot, binding, flow: freshFlow(), explicit: false })
        await fs.writeFile(path.join(root, "handle.json"), JSON.stringify(handle), { flag: "wx", mode: 0o600 })
        console.log(JSON.stringify({ mode, pid: process.pid, admitted: true }))
      } catch (error) {
        assert(error instanceof McpAuthJournalSchema.Error)
        assert.equal(error.reason, "conflict")
        console.log(JSON.stringify({ mode, pid: process.pid, admitted: false, reason: error.reason }))
      }
    }
    if (mode === "dispatch-kill") {
      const handle = JSON.parse(await fs.readFile(path.join(root, "handle.json"), "utf8")) as McpAuthJournal.Handle
      journal.updateFlow(handle, {
        discovery: {
          authorizationServerUrl: "http://127.0.0.1:1",
          authorizationServerMetadata: {
            issuer: "http://127.0.0.1:1",
            authorization_endpoint: "http://127.0.0.1:1/authorize",
            token_endpoint: "http://127.0.0.1:1/token",
            response_types_supported: ["code"],
          },
        },
        verifier: "v".repeat(43),
        discoveryTag: tag,
        phase: "awaiting_callback",
      })
      journal.dispatch(handle, { kind: "exchange", requestTag: tag, endpointTag: tag })
      const stat = await fs.stat(file)
      await fs.writeFile(
        path.join(root, "dispatched.json"),
        JSON.stringify({ pid: process.pid, device: stat.dev, inode: stat.ino, file }),
      )
      await new Promise<void>(() => {})
    }
    if (mode === "read") {
      const snapshot = journal.read(slot)
      assert(snapshot)
      const handle = JSON.parse(await fs.readFile(path.join(root, "handle.json"), "utf8")) as McpAuthJournal.Handle
      assert.throws(
        () => journal.current(handle),
        (error) => error instanceof McpAuthJournalSchema.Error && error.reason === "unknown",
      )
      const stat = await fs.stat(file)
      console.log(
        JSON.stringify({
          mode,
          pid: process.pid,
          device: stat.dev,
          inode: stat.ino,
          unknown: true,
          credentialRevision: snapshot.row.credential_revision,
          networkCalls: 0,
        }),
      )
    }
    if (mode === "retry") {
      assert.throws(() => journal.begin({ slot, binding, flow: freshFlow(), explicit: false }))
      console.log(JSON.stringify({ mode, pid: process.pid, automaticRetry: false }))
    }
    if (mode === "primitive") {
      const store = await McpAuthJournalStore.open(file, tag, "write", nativePort)
      assert(store)
      try {
        store.transaction((db) => {
          assert.throws(() => db.query("UPDATE mcp_auth_meta SET installation_tag=?").run(Buffer.from(tag) as never))
          assert.throws(() => db.query("UPDATE mcp_auth_meta SET id=?").run(Buffer.from("1") as never))
        })
        const handle = journal.begin({ slot, binding, flow: freshFlow(), explicit: false })
        store.transaction((db) => {
          assert.throws(() =>
            db.query("UPDATE mcp_auth_slot SET generation=? WHERE slot_key=?").run(Buffer.from(tag) as never, slot),
          )
          assert.throws(() => db.query("UPDATE mcp_auth_slot SET credentials='[]' WHERE slot_key=?").run(slot))
          assert.throws(() => db.query("UPDATE mcp_auth_slot SET flow='true' WHERE slot_key=?").run(slot))
          assert.throws(() => db.query("UPDATE mcp_auth_slot SET updated_at=-1 WHERE slot_key=?").run(slot))
        })
        store.transaction((db) =>
          db
            .query("UPDATE mcp_auth_slot SET credentials=? WHERE slot_key=?")
            .run('{"tokens":{"accessToken":"synthetic"}}', slot),
        )
        assert.throws(
          () => journal.read(slot),
          (error) => error instanceof McpAuthJournalSchema.Error,
        )
        store.transaction((db) => db.query("UPDATE mcp_auth_slot SET credentials='{}' WHERE slot_key=?").run(slot))
        assert.equal(journal.current(handle).row.credential_revision, 0)
        assert.throws(() =>
          store.transaction((db) => {
            db.query("UPDATE mcp_auth_slot SET credential_revision=2 WHERE slot_key=?").run(slot)
            throw new McpAuthJournalSchema.Error("conflict")
          }),
        )
        assert.equal(journal.current(handle).row.credential_revision, 0)
        console.log(
          JSON.stringify({
            mode,
            pid: process.pid,
            blobRejected: true,
            objectShapeRejected: true,
            runtimeShapeRejected: true,
            transactionRollback: true,
          }),
        )
      } finally {
        store.close()
      }
    }
    if (mode === "init") console.log(JSON.stringify({ mode, pid: process.pid, initialized: true }))
    if (mode === "refresh") {
      const handle = journal.begin({ slot, binding, flow: freshFlow(), explicit: false })
      journal.updateFlow(handle, {
        discovery: { authorizationServerUrl: "http://127.0.0.1:1" },
        verifier: "v".repeat(43),
        discoveryTag: tag,
        phase: "awaiting_callback",
      })
      const credentials = {
        tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", issuer: "http://127.0.0.1:1" },
      }
      journal.settle(journal.dispatch(handle, { kind: "exchange", requestTag: tag, endpointTag: tag }), {
        phase: "committed",
        credentials,
        outcome: { code: "committed" },
      })
      journal.updateFlow(handle, { phase: "connected" })
      assert.equal(journal.current(handle).row.credential_revision, 1)
      journal.settle(journal.dispatch(handle, { kind: "refresh", requestTag: tag, endpointTag: tag }), {
        phase: "committed",
        credentials,
        outcome: { code: "committed" },
      })
      assert.equal(journal.current(handle).row.credential_revision, 2)
      const unknown = journal.dispatch(handle, { kind: "refresh", requestTag: tag, endpointTag: tag })
      journal.settle(unknown, { phase: "unknown", outcome: { code: "network" } })
      assert.throws(() => journal.dispatch(handle, { kind: "refresh", requestTag: tag, endpointTag: tag }))
      assert.throws(() => journal.begin({ slot, binding, flow: freshFlow(), explicit: false }))
      journal.revoke(handle, false)
      const current = journal.begin({ slot, binding, flow: freshFlow(), explicit: true })
      assert.equal(journal.current(current).credentials.tokens, undefined)
      if (nativePort) journal.close()
      const store = await McpAuthJournalStore.open(file, tag, "read", nativePort)
      assert(store)
      try {
        assert.deepEqual(
          store.read((db) =>
            db
              .query(
                "SELECT source_revision,phase FROM mcp_oauth_operation WHERE kind='refresh' ORDER BY source_revision",
              )
              .all().map((row) => {
                assert(row && typeof row === "object" && "source_revision" in row && "phase" in row)
                return { source_revision: row.source_revision, phase: row.phase }
              }),
          ),
          [
            { source_revision: 1, phase: "committed" },
            { source_revision: 2, phase: "unknown" },
          ],
        )
      } finally {
        store.close()
      }
      console.log(
        JSON.stringify({
          mode,
          pid: process.pid,
          revisions: [1, 2],
          unknownRetryRejected: true,
          oldUnknownRetained: true,
        }),
      )
    }
    if (mode === "capacity") {
      const handle = journal.begin({ slot, binding, flow: freshFlow(), explicit: false })
      journal.updateFlow(handle, { phase: "connected" })
      const store = await McpAuthJournalStore.open(file, tag, "write", nativePort)
      assert(store)
      try {
        store.transaction((db) => {
          for (const index of Array.from({ length: 255 }, (_, index) => index))
            db.query(
              "INSERT INTO mcp_auth_slot SELECT ?,binding,generation,revision,credential_revision,credentials,flow,created_at,updated_at FROM mcp_auth_slot WHERE slot_key=?",
            ).run(index.toString(16).padStart(64, "0"), slot)
        })
        assert.throws(
          () =>
            store.transaction((db) =>
              db
                .query(
                  "INSERT INTO mcp_auth_slot SELECT ?,binding,generation,revision,credential_revision,credentials,flow,created_at,updated_at FROM mcp_auth_slot WHERE slot_key=?",
                )
                .run("f".repeat(64), slot),
            ),
          (error) => error instanceof McpAuthJournalSchema.Error && error.reason === "capacity",
        )
        assert.throws(
          () =>
            store.transaction((db) =>
              db.query("UPDATE mcp_auth_slot SET flow=json_set(flow,'$.phase','preparing')").run(),
            ),
          (error) => error instanceof McpAuthJournalSchema.Error && error.reason === "capacity",
        )
        const credentials = JSON.stringify({
          tokens: { accessToken: "a".repeat(16384), refreshToken: "b".repeat(16384), issuer: "http://127.0.0.1:1" },
          clientInfo: { clientId: "c".repeat(12000), clientSecret: "d".repeat(12000), issuer: "http://127.0.0.1:1" },
        })
        assert.throws(
          () => store.transaction((db) => db.query("UPDATE mcp_auth_slot SET credentials=?").run(credentials)),
          (error) => error instanceof McpAuthJournalSchema.Error && error.reason === "capacity",
        )
        assert.equal(journal.current(handle).credentials.tokens, undefined)
        const now = Date.now()
        assert.throws(
          () =>
            store.transaction((db) => {
              for (const index of Array.from({ length: 1025 }, (_, index) => index)) {
                const id = index.toString(16).padStart(64, "0")
                db.query(
                  `INSERT INTO mcp_oauth_operation VALUES(?,?,?,?,?,NULL,'exchange','unknown',?,?,?, ?,?,?,'{}')`,
                ).run(id, slot, id, handle.owner, handle.generation, tag, tag, now, now + 1000, now, now)
              }
            }),
          (error) => error instanceof McpAuthJournalSchema.Error && error.reason === "capacity",
        )
        const operations = store.read((db) => db.query("SELECT COUNT(*) AS n FROM mcp_oauth_operation").get())
        assert(operations && typeof operations === "object" && "n" in operations)
        assert.equal(operations.n, 0)
        const slots = store.read((db) => db.query("SELECT COUNT(*) AS n FROM mcp_auth_slot").get())
        assert(slots && typeof slots === "object" && "n" in slots)
        assert.equal(slots.n, 256)
        console.log(
          JSON.stringify({
            mode,
            pid: process.pid,
            slots: 256,
            rejected: ["slot257", "active65", "logical4MiB", "operation1025"],
            rollback: true,
          }),
        )
      } finally {
        store.close()
      }
    }
    if (mode === "security") {
      const acl = nativePort
        ? async (arguments_: string[]) => {
            const { spawnSync } = await import("node:child_process")
            const command = path.join(process.env.SystemRoot!, "System32", "icacls.exe")
            const result = spawnSync(command, [file, ...arguments_], { stdio: "pipe", windowsHide: true, shell: false })
            assert.equal(result.status, 0, result.stderr.toString())
          }
        : undefined
      if (acl) await acl(["/grant:r", "*S-1-1-0:(W)"])
      else await fs.chmod(file, 0o644)
      assert.throws(
        () => journal.read(slot),
        (error) => error instanceof McpAuthJournalSchema.Error,
      )
      if (acl) await acl(["/remove:g", "*S-1-1-0"])
      else await fs.chmod(file, 0o600)
      const store = await McpAuthJournalStore.open(file, tag, "write", nativePort)
      assert(store)
      try {
        assert.throws(() =>
          store.transaction((db) => db.exec("CREATE INDEX unapproved_index ON mcp_auth_slot(updated_at)")),
        )
        assert.equal(journal.read(slot), undefined)
      } finally {
        store.close()
      }
      const link = path.join(root, "private", "linked.sqlite")
      await fs.link(file, link)
      await assert.rejects(() => McpAuthJournal.open(file, tag, "read", nativePort))
      await fs.unlink(link)
      await fs.symlink(file, link)
      await assert.rejects(() => McpAuthJournal.open(link, tag, "read", nativePort))
      console.log(
        JSON.stringify({
          mode,
          pid: process.pid,
          aclRejected: true,
          hardlinkRejected: true,
          symlinkRejected: true,
          unexpectedSchemaRolledBack: true,
        }),
      )
    }
  } finally {
    journal.close()
  }
}

if (import.meta.main && !process.env.DAC_NATIVE_NODE_COHORT_ROOT) await journal()
