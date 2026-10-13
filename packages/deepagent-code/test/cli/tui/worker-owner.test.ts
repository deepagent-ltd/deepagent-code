import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import type { rpc } from "../../../src/cli/tui/worker"
import { Rpc } from "../../../src/util/rpc"
import { Database } from "@deepagent-code/core/database/database"
import { tmpdir } from "../../fixture/fixture"
import { ServerAuth } from "../../../src/server/auth"
import { validateSession } from "../../../src/cli/tui/validate-session"
import { createOpencodeClient } from "@deepagent-code/sdk"

test("the original TUI worker shares its file database between the listener and CLI operations", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "tui.sqlite")
  const worker = new Worker(new URL("../../../src/cli/tui/worker.ts", import.meta.url), {
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      DEEPAGENT_CODE_TEST_HOME: path.join(tmp.path, "home"),
      DEEPAGENT_CODE_HOME: path.join(tmp.path, "data"),
      DEEPAGENT_CODE_DB: filename,
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
      DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
      DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1",
      DEEPAGENT_CODE_PURE: "1",
      DEEPAGENT_CODE_SERVER_USERNAME: "tui-owner-test",
      DEEPAGENT_CODE_SERVER_PASSWORD: "isolated-worker-owner-test",
    },
  })
  const client = Rpc.client<typeof rpc>(worker, { requireReady: true, timeoutMs: 20_000 })
  worker.addEventListener("close", () => client.close(new Error("Owned TUI worker exited")), { once: true })
  worker.onerror = (event) => {
    event.preventDefault()
    client.close(new Error(event.message))
  }
  try {
    await client.ready
    const listener = await client.call("server", { port: 0, hostname: "127.0.0.1" })
    const lock = await fs.readFile(path.join(`${filename}.runtime.lock`, "meta.json"), "utf8")
    await client.call("checkUpgrade", { directory: tmp.path })
    const embedded = await client.call("fetch", {
      url: "http://deepagent-code.internal/global/health", method: "GET", headers: {},
    })
    expect(embedded.status).toBe(200)
    expect(JSON.parse(embedded.body).healthy).toBe(true)
    const headers = ServerAuth.headers({ username: "tui-owner-test", password: "isolated-worker-owner-test" })
    expect((await fetch(`${listener.url}/global/health`)).status).toBe(401)
    const external = await fetch(`${listener.url}/global/health`, { headers })
    expect(external.status).toBe(200)
    expect((await external.json()).healthy).toBe(true)
    const session = await createOpencodeClient({ baseUrl: listener.url, directory: tmp.path, headers }).session.create()
    expect(session.data).toBeDefined()
    await expect(validateSession({ url: listener.url, directory: tmp.path, sessionID: session.data!.id })).rejects.toBeDefined()
    await expect(validateSession({ url: listener.url, directory: tmp.path, sessionID: session.data!.id, headers })).resolves.toBeUndefined()
    expect(await fs.readFile(path.join(`${filename}.runtime.lock`, "meta.json"), "utf8")).toBe(lock)
    const competing = await Database.bootstrap(filename)
    expect(competing.ready).toBe(false)
    expect(competing.issues.some((issue) => issue.code === "another_process_active")).toBe(true)
    await client.call("shutdown", undefined)
    expect(await fs.stat(`${filename}.runtime.lock`).then(() => true, () => false)).toBe(false)
    expect((await Database.bootstrap(filename)).ready).toBe(true)
  } finally {
    client.close()
    worker.terminate()
  }
}, 30_000)
