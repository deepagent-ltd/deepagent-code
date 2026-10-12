import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { Backup } from "@deepagent-code/core/database/backup"
import { Flag } from "@deepagent-code/core/flag/flag"
import { MaintenancePaths } from "../../../src/server/routes/instance/httpapi/groups/maintenance"

const mode = process.argv[2]
const root = process.env.HOME!
const observations: { name: string; available: boolean }[] = []
const listeners: Awaited<ReturnType<typeof Server.listen>>[] = []
const password = "isolated-listener-authority-password"
const headers = { authorization: `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}` }
function check(name: string, expected: boolean) {
  const available = Server.privateGoalWritesAvailable()
  observations.push({ name, available })
  assert.equal(available, expected, name)
}
async function wait(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out: ${label}`)
}
async function start(file: string) {
  Flag.DEEPAGENT_CODE_DB = path.join(root, file)
  const opening = Server.listen({ hostname: "127.0.0.1", port: 0 })
  check(`pending:${file}`, false)
  const listener = await opening
  listeners.push(listener)
  return listener
}
async function status(listener: Awaited<ReturnType<typeof Server.listen>>, authenticated = false) {
  const response = await fetch(new URL("/session", listener.url), {
    headers: authenticated ? headers : undefined,
    signal: AbortSignal.timeout(2_000),
  })
  await response.arrayBuffer()
  return response.status
}
async function stop(listener: Awaited<ReturnType<typeof Server.listen>>) {
  await listener.stop(true)
}

try {
  check("no-listener", true)
  if (mode === "matrix") {
    delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
    const anonymous = await start("anonymous.db")
    check("anonymous-listener", false)
    assert.equal(await status(anonymous), 200)
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = password
    check("environment-does-not-secure-old-listener", false)
    assert.equal(await status(anonymous), 200)
    const authenticated = await start("authenticated.db")
    check("one-anonymous-among-two", false)
    assert.equal(await status(authenticated), 401)
    assert.equal(await status(authenticated, true), 200)
    const socket = net.createConnection({ host: "127.0.0.1", port: anonymous.port })
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.write("GET /session HTTP/1.1\r\nHost: localhost\r\n")
    const closing = anonymous.stop()
    check("close-request-with-live-socket", false)
    await closing
    await wait(() => Server.privateGoalWritesAvailable(), "anonymous actual close")
    socket.destroy()
    check("only-authenticated-remains", true)
    delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
    check("environment-does-not-unsecure-old-listener", true)
    assert.equal(await status(authenticated), 401)
    const empty = await start("empty.db")
    check("new-empty-listener", false)
    assert.equal(await status(empty), 200)
    await stop(empty)
    await wait(() => Server.privateGoalWritesAvailable(), "empty actual close")
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
    const address = blocker.address()
    assert(address && typeof address !== "string")
    const failed = Server.listen({ hostname: "127.0.0.1", port: address.port })
    check("failed-bind-pending", false)
    await assert.rejects(failed)
    check("failed-bind-never-bound", true)
    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())))
    await assert.rejects(Server.listen({ hostname: "127.0.0.1", port: -1 }))
    check("synchronous-bind-rejected", true)
    await stop(authenticated)
    await wait(() => Server.privateGoalWritesAvailable(), "all actual close")
    check("all-listeners-closed", true)
  } else if (mode === "shared") {
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = password
    Flag.DEEPAGENT_CODE_DB = path.join(root, "shared.db")
    await AppRuntime.runPromise(Database.Service)
    const first = await start("shared.db")
    check("shared-root-first", true)
    assert.equal(await status(first), 401)
    delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
    const second = await start("shared.db")
    // The route's four fixed auth layers are still held by the first listener's
    // shared MemoMap. Observe that exact cached config, not the new environment.
    check("shared-root-cached-password", true)
    assert.equal(await status(second), 401)
    assert.equal(await status(second, true), 200)
    await stop(first)
    check("shared-root-second-survives", true)
    await stop(second)
    await wait(() => Server.privateGoalWritesAvailable(), "shared listeners close")
  } else {
    assert(mode === "restore" || mode === "restore-fallback")
    const filename = path.join(root, "restore.db")
    await Effect.runPromise(Database.Service.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))
    await fs.mkdir(path.join(root, "backups"))
    const backup = await Effect.runPromise(
      Backup.create({
        sourcePath: filename,
        destDir: path.join(root, "backups"),
        buildId: "private-goal-listener-test",
      }),
    )
    await fs.writeFile(filename, "isolated invalid sqlite")
    await fs.rm(`${filename}-wal`, { force: true })
    await fs.rm(`${filename}-shm`, { force: true })
    delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
    const empty = await start("restore.db")
    check("empty-maintenance", false)
    await stop(empty)
    await wait(() => Server.privateGoalWritesAvailable(), "empty maintenance close")
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = password
    let attempts = 0
    let fallbackObserved = false
    Flag.DEEPAGENT_CODE_DB = filename
    const opening = Server.listen({
      hostname: "127.0.0.1",
      port: 0,
      restorePrepare: async () => {
        check("warm-prepare-pending", false)
        if (attempts > 0) {
          fallbackObserved = true
          assert.equal(Server.privateGoalWritesAvailable(), false)
        }
      },
      restoreRebind: async () => {
        check("restore-rebind-pending", false)
        attempts++
        if (mode === "restore-fallback" && attempts === 1) {
          delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
          throw new Error("isolated rebind failure")
        }
      },
    })
    check("maintenance-start-pending", false)
    const listener = await opening
    listeners.push(listener)
    check("authenticated-maintenance", true)
    const response = await fetch(new URL(MaintenancePaths.backupRestore, listener.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        backup_manifest_ref: Backup.manifestPathFor(backup.backup.filePath),
        target: filename,
        dry_run: false,
      }),
    })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
    if (mode === "restore-fallback") {
      await wait(async () => {
        if (attempts !== 1) return false
        const response = await fetch(new URL(MaintenancePaths.bootstrapStatus, listener.url), {
          signal: AbortSignal.timeout(1_000),
        }).catch(() => undefined)
        if (!response) return false
        await response.arrayBuffer()
        return response.status === 423
      }, "unauthenticated fallback maintenance")
      check("actual-empty-fallback-maintenance", false)
    }
    await wait(async () => (await status(listener, true).catch(() => 0)) === 200, "restored business listener")
    if (mode === "restore-fallback") {
      assert.equal(fallbackObserved, true)
      assert.equal(attempts, 2)
      // Warm routes built outside the listener's fresh ConfigProvider retain
      // the ambient cached password. The later listener must report that exact
      // config, even though its environment still contains no password.
      check("restored-actual-warm-cached-config", true)
      assert.equal(await status(listener), 401)
      assert.equal(process.env.DEEPAGENT_CODE_SERVER_PASSWORD, undefined)
    } else {
      check("restored-authenticated-listener", true)
      assert.equal(await status(listener), 401)
    }
    await stop(listener)
    await wait(() => Server.privateGoalWritesAvailable(), "restored listener close")
    check("restored-listener-closed", true)
  }
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ mode, observations }))
} finally {
  await Promise.all(listeners.map((listener) => listener.stop(true).catch(() => undefined)))
  await AppRuntime.dispose()
}
