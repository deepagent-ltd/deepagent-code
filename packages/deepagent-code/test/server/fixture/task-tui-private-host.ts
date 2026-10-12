import assert from "node:assert/strict"
import path from "node:path"
import { TaskHumanClient } from "@deepagent-code/core/session/task-human-client"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import { createTaskControlBridge } from "../../../src/cli/tui/task-control-bridge"

const root = process.argv[2]!
const worker = new Worker(new URL("./task-tui-private-worker.ts", import.meta.url))
worker.addEventListener("error", (event) => console.error("PRIVATE_TASK_WORKER_ERROR", event.message))
const bridge = await createTaskControlBridge(worker, process.cwd())
let sequence = 0
const probe = (action: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = sequence++
    const timer = setTimeout(() => {
      worker.removeEventListener("message", handle)
      reject(new Error("Fixture probe timeout"))
    }, 20000)
    function handle(event: MessageEvent<unknown>) {
      const value = event.data
      if (!value || typeof value !== "object" || !("probeResult" in value) || !("id" in value) || value.id !== id)
        return
      worker.removeEventListener("message", handle)
      clearTimeout(timer)
      if ("error" in value) {
        reject(new Error(String(value.error)))
        return
      }
      resolve("data" in value ? value.data : undefined)
    }
    worker.addEventListener("message", handle)
    worker.postMessage({ probe: action, id })
  })
const command = (
  item: AttentionSchema.Item,
  requestID: string,
  action: TaskHumanControlSchema.Action,
): TaskHumanControlSchema.Input => {
  assert(item.source.task)
  return {
    runID: item.source.task.runID,
    parentSessionID: item.source.task.parentSessionID,
    childSessionID: item.source.task.childSessionID,
    generation: item.source.task.generation,
    expectedVersion: item.source.task.version,
    itemID: item.id,
    itemRevision: item.revision,
    requestID,
    action,
    reason: "Actual private worker human control",
  }
}
const rejected = async (input: TaskHumanControlSchema.Input, code: string) => {
  const before = await probe("census")
  await assert.rejects(
    bridge.transport.control(input),
    (error: unknown) => error instanceof TaskHumanClient.RequestError && error.code === code && !error.unknown,
  )
  assert.deepEqual(await probe("census"), before)
}
try {
  const seed = await probe("seed")
  assert(
    seed &&
      typeof seed === "object" &&
      "local" in seed &&
      typeof seed.local === "string" &&
      "foreign" in seed &&
      typeof seed.foreign === "string",
  )
  const before = await probe("census")
  const local = await bridge.transport.get({ itemID: seed.local })
  assert.deepEqual(local.allowedActions, ["task_request_close", "task_resolve_failed", "task_resolve_closed"])
  assert.deepEqual(await probe("census"), before)
  const foreign = await bridge.transport.get({ itemID: seed.foreign })
  assert.deepEqual(foreign.allowedActions, [])
  await rejected(command(foreign, "foreign-denied", "resolve_closed"), "scope_changed")
  const close = command(local, "private-local-close", "resolve_closed")
  await rejected(Object.assign({}, close, { actor: { principal: "server:forged" } }), "invalid_request")
  await assert.rejects(
    bridge.transport.get(Object.assign({ itemID: seed.local }, { workspaceID: "foreign" })),
    (error: unknown) => error instanceof TaskHumanClient.RequestError && error.code === "invalid_request",
  )
  assert.deepEqual(await probe("census"), before)
  const url = await probe("listener")
  assert.equal(typeof url, "string")
  assert.deepEqual((await bridge.transport.get({ itemID: seed.local })).allowedActions, [])
  await rejected(close, "auth_required")
  const response = await fetch(new URL("/api/attention/task/control", String(url)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(close),
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await probe("census"), before)
  await probe("listener-close")
  const known = await bridge.transport.control(close)
  assert.equal(known.receipt.state, "closed")
  assert(known.receipt.authority.principal.startsWith("tui:"))
  assert.equal(known.receipt.authority.directory, process.cwd())
  const settled = await probe("census")
  await probe("reload")
  await bridge.reconnect()
  assert.deepEqual(await bridge.transport.control(close), { receipt: known.receipt, replayed: true })
  assert.deepEqual(await probe("census"), settled)
  await rejected({ ...close, reason: "Conflicting reuse" }, "request_conflict")
  const unknownSeed = await probe("unknown-seed")
  assert(
    unknownSeed &&
      typeof unknownSeed === "object" &&
      "itemID" in unknownSeed &&
      typeof unknownSeed.itemID === "string" &&
      "token" in unknownSeed,
  )
  const unknown = await bridge.transport.get({ itemID: unknownSeed.itemID })
  assert.deepEqual(unknown.allowedActions, ["task_request_close"])
  await rejected(command(unknown, "unknown-denied", "resolve_failed"), "custody_required")
  const intent = await bridge.transport.control(command(unknown, "unknown-close", "request_close"))
  assert.equal(intent.receipt.controlState, "close_requested")
  assert.equal(intent.receipt.state, "recovery_required")
  assert.equal(intent.receipt.terminalReceiptID, null)
  const actual = await probe("census")
  assert(actual && typeof actual === "object" && "token" in actual && "token" in unknownSeed)
  assert.equal(actual.token, unknownSeed.token)
  const cancellation = new AbortController()
  cancellation.abort()
  await assert.rejects(bridge.transport.control(close, cancellation.signal), TaskHumanClient.RequestError)
  await bridge.transport.whenSettled()
  assert.deepEqual(await probe("census"), actual)
  await probe("dispose")
  await Bun.write(
    path.join(root, "result.json"),
    JSON.stringify({
      state: known.receipt.state,
      exactRetry: true,
      ordinaryReadsUnchanged: true,
      foreignScopeDenied: true,
      unauthenticatedListenerDenied: true,
      rawHTTPStatus: response.status,
      unknownCustody: true,
      preAbortedUnchanged: true,
      census: actual,
      cleanup: true,
    }),
  )
  console.log(`PRIVATE_TASK_TUI_OK ${root}`)
} finally {
  bridge.close()
  worker.terminate()
}
