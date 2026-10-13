import assert from "node:assert/strict"
import { createGoalPlanBridge } from "../../../src/cli/tui/goal-plan-bridge"
import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import fs from "node:fs/promises"
import path from "node:path"
const root = process.env.DAC_GOAL_PLAN_FIXTURE_ROOT!
const worker = new Worker(new URL("./goal-plan-worker.ts", import.meta.url))
const requests: { kind: string; data: unknown }[] = []
const seed = new Promise<{ sessionID: string; goalID: string }>((resolve) =>
  worker.addEventListener("message", (event) => {
    if (event.data?.fixture === "seed") resolve({ sessionID: event.data.sessionID, goalID: event.data.goalID })
  }),
)
const bridgePromise = createGoalPlanBridge(worker, process.cwd())
worker.addEventListener("error", (event) => {
  console.error(event.message)
  process.exitCode = 1
})
async function probe(kind: string) {
  const value = new Promise<unknown>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.fixture === kind) {
        worker.removeEventListener("message", listener)
        resolve(event.data)
      }
    }
    worker.addEventListener("message", listener)
  })
  worker.postMessage({ fixture: kind })
  return value
}
try {
  const bridge = await bridgePromise
  const target = await seed
  requests.push({ kind: "unauthenticated-http", data: await probe("http-forgery") })
  const mode = process.env.DAC_GOAL_PLAN_FIXTURE_MODE ?? "allow"
  if (mode === "listener-before") {
    const before = await probe("snapshot")
    const observed = await probe("start-listener")
    assert(observed && typeof observed === "object" && "available" in observed && observed.available === false)
    await assert.rejects(
      bridge.transport.send({
        action: "begin",
        request: { ...target, expectedControlRevision: 1, requestID: "listener-denied" },
      }),
      /authenticated operator/,
    )
    await bridge.transport.whenSettled()
    assert.deepEqual(await probe("snapshot"), before)
    requests.push(
      { kind: "listener-denied", data: observed },
      { kind: "final-snapshot", data: await probe("snapshot") },
    )
    await fs.writeFile(path.join(root, "private-result.json"), JSON.stringify(requests))
    bridge.close()
    worker.postMessage({ fixture: "shutdown" })
    process.exitCode = 0
  } else {
    const begin = { ...target, expectedControlRevision: 1, requestID: "private-begin" }
    const first = GoalPlanClient.decode(await bridge.transport.send({ action: "begin", request: begin }))
    assert.equal(first.current.state, "ready")
    assert.equal(first.current.editID, await GoalPlanClient.locator(begin))
    const query = { ...target, editID: first.current.editID, requestID: begin.requestID }
    const before = await probe("snapshot")
    const get = GoalPlanClient.decode(await bridge.transport.get(query))
    assert.deepEqual(get.originalReceipt, first.originalReceipt)
    const after = await probe("snapshot")
    assert.deepEqual(after, before)
    const candidate = GoalPlanClient.candidate(get)
    const apply = {
      ...query,
      requestID: "private-apply",
      expectedEditRevision: get.current.revision,
      expectedControlRevision: get.current.controlRevision,
      expectedPlanRevision: get.current.planRevision,
      expectedDocVersion: get.current.editSource!.planDocument.version,
      expectedDocHash: get.current.editSource!.planDocHash,
      candidate: {
        ...candidate,
        steps: candidate.steps.map((step) =>
          step.status === "pending" ? { ...step, title: "Private local edit" } : step,
        ),
      },
      reason: "Explicit local fixture operator",
    }
    const outcome = bridge.transport.send({ action: "apply", request: apply }).then(
      (value) => ({ success: GoalPlanClient.decode(value) }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    if (mode !== "allow") {
      const started = Date.now()
      for (;;) {
        const value = await probe("permissions")
        if (value && typeof value === "object" && "data" in value && Array.isArray(value.data) && value.data.length)
          break
        if (Date.now() - started > 10000) throw new Error("Actual permission never became pending")
        await Bun.sleep(10)
      }
      requests.push({ kind: "before-await", data: await probe("snapshot") })
      if (mode === "ask-listener" || mode === "ask-listener-http") {
        const observed = await probe("start-listener")
        assert(observed && typeof observed === "object" && "available" in observed && observed.available === false)
        requests.push({ kind: "unsafe-listener-started-during-ask", data: observed })
        if (mode === "ask-listener") await probe("approve")
        if (mode === "ask-listener-http") {
          assert("url" in observed && typeof observed.url === "string")
          const endpoint = `/api/session/${encodeURIComponent(target.sessionID)}/permission`
          const listed = await fetch(new URL(endpoint, observed.url))
          assert.equal(listed.status, 200)
          const pending: unknown = await listed.json()
          assert(pending && typeof pending === "object" && "data" in pending && Array.isArray(pending.data))
          assert(pending.data.length === 1 && typeof pending.data[0].id === "string")
          const replied = await fetch(
            new URL(`${endpoint}/${encodeURIComponent(pending.data[0].id)}/reply`, observed.url),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reply: "once" }),
            },
          )
          assert.equal(replied.status, 204, await replied.text())
          requests.push({
            kind: "unauthenticated-permission-http-reply",
            data: { listStatus: listed.status, replyStatus: replied.status },
          })
        }
      }
      if (mode === "ask-close") bridge.close()
      if (mode === "ask-approve") await probe("approve")
    }
    const result = await outcome
    await bridge.transport.whenSettled()
    if (mode === "allow" || mode === "ask-approve") {
      assert("success" in result)
      assert.equal(result.success.current.state, "committed")
      assert.equal(result.success.current.execution, "paused")
      requests.push({ kind: "committed", data: result.success })
    } else {
      assert("error" in result)
      const remaining = await probe("permissions")
      assert(remaining && typeof remaining === "object" && "data" in remaining)
      assert.deepEqual(remaining.data, [])
      await probe("approve")
      const after = await probe("snapshot")
      assert.deepEqual(after, requests.find((entry) => entry.kind === "before-await")!.data)
      requests.push({ kind: "unknown-after-settled", data: result })
      if (mode === "ask-close") await bridge.reconnect()
      const current = GoalPlanClient.decode(await bridge.transport.get(query))
      assert.equal(current.current.state, "ready")
      assert.equal(current.originalReceipt?.action, "begin")
    }
    bridge.close()
    await assert.rejects(bridge.transport.get(query), /no confirmed/)
    requests.push({ kind: "final-snapshot", data: await probe("snapshot") })
    await fs.writeFile(path.join(root, "private-result.json"), JSON.stringify(requests))
    worker.postMessage({ fixture: "shutdown" })
  }
} finally {
  setTimeout(() => worker.terminate(), 1000).unref()
}
