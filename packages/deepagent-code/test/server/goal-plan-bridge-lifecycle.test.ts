import { expect, test } from "bun:test"
import { createGoalPlanBridge } from "../../src/cli/tui/goal-plan-bridge"

test("real native ports isolate failed handshake timers and a worker exit releases only its owned requests", async () => {
  // This peer exercises the actual native transport lifecycle, not Goal Access minting.
  // Production Access/file authority is covered by the file-backed private-worker suite.
  const worker = new Worker(new URL("./fixture/goal-plan-bridge-peer.ts", import.meta.url))
  const bridge = await createGoalPlanBridge(worker, process.cwd())
  const query = { sessionID: "session", goalID: "goal", editID: "edit", requestID: "read" }
  try {
    expect(await bridge.transport.get(query)).toEqual({ nativeGeneration: 1 })
    const failed = bridge.reconnect()
    expect(bridge.reconnect()).toBe(failed)
    await expect(failed).rejects.toThrow("no confirmed")
    await bridge.reconnect()
    expect(await bridge.transport.get(query)).toEqual({ nativeGeneration: 3 })
    await Bun.sleep(6200)
    expect(await bridge.transport.get(query)).toEqual({ nativeGeneration: 3 })
    const pending = bridge.transport.get({ ...query, requestID: "hold" }).catch((error: unknown) => error)
    let settled = false
    const barrier = bridge.transport.whenSettled().then(() => {
      settled = true
    })
    await Bun.sleep(30)
    expect(settled).toBe(false)
    worker.terminate()
    const deadline = setTimeout(() => {
      throw new Error("Actual worker exit did not settle owned request")
    }, 3000)
    await barrier
    clearTimeout(deadline)
    expect(settled).toBe(true)
    expect(await pending).toBeInstanceOf(Error)
  } finally {
    bridge.close()
    worker.terminate()
  }
}, 12000)
