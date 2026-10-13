import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp/index"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { McpAuthScope } from "../../src/mcp/auth-scope"
import { PrivateSqlite } from "@deepagent-code/core/database/private-sqlite"
import { Global } from "@deepagent-code/core/global"
import { Config } from "../../src/config/config"

const root = process.env.DAC_MCP_COLD_ROOT
assert(root && path.basename(root).startsWith("dac-mcp-oauth-cold-"))
assert.equal(await fs.realpath(root), root)
const mode = process.argv[2]
const dbPath = process.env.DEEPAGENT_CODE_DB
assert(dbPath)
assert(
  ["authority.sqlite", "authority-two.sqlite"].some(
    (name) => dbPath === path.join(root, "home", ".deepagent", "code", name),
  ),
)
const layer = Layer.mergeAll(
  MCP.defaultLayer,
  McpAuthScope.defaultLayer,
  Config.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void }))),
)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const instances = yield* InstanceStore.Service
      const instance = yield* instances.load({ directory: path.join(root, "project") })
      yield* Effect.addFinalizer(() => instances.dispose(instance))
      return yield* instances.provide(
        { directory: instance.directory },
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          if (mode === "namespace-a" || mode === "namespace-b") {
            const configuration = (yield* (yield* Config.Service).mcpSnapshot!()).config.mcp?.cold
            assert(configuration && "type" in configuration)
            const flow = yield* (yield* McpAuthScope.Service).begin("cold", configuration, false)
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await flow.revoke()
                flow.close()
              }),
            )
            const file = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
            const inspect = () => {
              const storage = new PrivateSqlite.Database(file, { readonly: true, create: false })
              try {
                return storage
                  .query(
                    "SELECT slot_key, json_extract(binding,'$.namespace') namespace, json_extract(binding,'$.location') location, json_extract(binding,'$.project') project, json_extract(binding,'$.installationID') installation, json_extract(flow,'$.state') state, json_extract(flow,'$.phase') phase FROM mcp_auth_slot ORDER BY namespace",
                  )
                  .all()
              } finally {
                storage.close()
              }
            }
            yield* Effect.promise(() =>
              fs.writeFile(path.join(root, `${mode}.ready`), JSON.stringify({ pid: process.pid, rows: inspect() }), {
                mode: 0o600,
              }),
            )
            const deadline = Date.now() + 15000
            while (
              !(yield* Effect.promise(() =>
                fs.stat(path.join(root, `${mode}.continue`)).then(
                  () => true,
                  () => false,
                ),
              ))
            ) {
              assert(Date.now() < deadline, "namespace barrier timed out")
              yield* Effect.sleep(20)
            }
            if (mode === "namespace-a") return
            assert.equal(yield* Effect.promise(flow.current), true)
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(root, "namespace-result.json"),
                JSON.stringify({ pid: process.pid, rows: inspect(), current: true }),
                { mode: 0o600 },
              ),
            )
            return
          }
          if (mode === "exchange") {
            const pending = yield* mcp.startAuth("cold")
            yield* Effect.promise(() =>
              fs.writeFile(path.join(root, "pending.json"), JSON.stringify({ oauthState: pending.oauthState }), {
                mode: 0o600,
              }),
            )
            yield* mcp.finishAuth("cold", "synthetic-authorization-code", pending.oauthState)
            throw new Error("fixture expected an externally blocked token response")
          }
          const file = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
          const before = yield* Effect.promise(() => fs.readFile(file))
          const status = yield* mcp.status()
          assert.deepEqual(status.cold, { status: "disconnected", authStatus: "unknown", reason: "unknown_outcome" })
          const pending = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(root, "pending.json"), "utf8")))
          const callback = yield* mcp.finishAuth("cold", "late-code", pending.oauthState).pipe(Effect.exit)
          assert.equal(callback._tag, "Failure")
          const reconnect = yield* mcp.connect("cold").pipe(Effect.exit)
          assert.equal(reconnect._tag, "Failure")
          const after = yield* Effect.promise(() => fs.readFile(file))
          assert.deepEqual(after, before)
          const storage = new PrivateSqlite.Database(file, { readonly: true, create: false })
          const operations = storage
            .query("SELECT kind,phase,COUNT(*) n FROM mcp_oauth_operation GROUP BY kind,phase")
            .all()
          const facts = storage.query("SELECT COUNT(*) n,SUM(credential_revision) revision FROM mcp_auth_slot").get()
          storage.close()
          const identity = yield* Effect.promise(() => fs.stat(file))
          const business = yield* Effect.promise(() => fs.stat(dbPath))
          console.log(
            JSON.stringify({
              mode,
              pid: process.pid,
              status,
              operations,
              facts,
              file: { path: file, dev: identity.dev, inode: identity.ino },
              business: { path: dbPath, dev: business.dev, inode: business.ino },
              unchanged: true,
              coldCallbackRejected: true,
            }),
          )
        }),
      )
    }),
  ).pipe(Effect.provide(layer)),
)
