// Dedicated process: validates listener-local profile capture against an already-built shared root.
import assert from "node:assert/strict"
import { Database } from "@deepagent-code/core/database/database"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"

const headers = { authorization: `Basic ${btoa("operator:test-secret")}` }
const listeners: Awaited<ReturnType<typeof Server.listen>>[] = []
const capability = async (listener: Awaited<ReturnType<typeof Server.listen>>) => {
  const response = await fetch(new URL("/api/attention/capability", listener.url), { headers })
  assert.equal(response.status, 200)
  return response.json()
}
const listen = async () => {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  listeners.push(listener)
  return listener
}
try {
  const database = await AppRuntime.runPromise(Database.Service)
  const disabled = await Server.Default().app.request("/api/attention/capability", { headers })
  assert.equal(disabled.status, 200)
  assert.equal((await disabled.json()).reason, "profile_disabled")
  process.env.DEEPAGENT_CODE_ATTENTION_PROFILE = "implicit-local"
  const enabled = await listen()
  assert.deepEqual(await capability(enabled), {
    enabled: true,
    reason: "enabled",
    scope: "implicit-local",
    actor: "server",
  })
  const list = await fetch(new URL("/api/attention", enabled.url), { headers })
  assert.equal(list.status, 200)
  assert.deepEqual((await list.json()).data, [])
  delete process.env.DEEPAGENT_CODE_ATTENTION_PROFILE
  const off = await listen()
  assert.equal((await capability(off)).reason, "profile_disabled")
  assert.equal((await capability(enabled)).enabled, true)
  process.env.DEEPAGENT_CODE_ATTENTION_PROFILE = "implicit-local"
  process.env.DEEPAGENT_CODE_WORKSPACE_ID = "wrk_private"
  const workspace = await listen()
  const restricted = await capability(workspace)
  assert.deepEqual(restricted, { enabled: false, reason: "unsupported_host", scope: "implicit-local", actor: "server" })
  assert.equal(JSON.stringify(restricted).includes("wrk_private"), false)
  assert.equal(await AppRuntime.runPromise(Database.Service), database)
  assert.equal((await fetch(new URL("/api/attention", off.url), { headers })).status, 503)
  console.log("ATTENTION_HOST_PROFILE_PASS")
} finally {
  delete process.env.DEEPAGENT_CODE_ATTENTION_PROFILE
  delete process.env.DEEPAGENT_CODE_WORKSPACE_ID
  for (const listener of listeners) await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
}
