import { expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

type Methods = { echo: (input: { value: number }) => { value: number } }

test("the original worker acknowledges its installed listener before the first request", async () => {
  const worker = new Worker(new URL("../fixture/rpc-ready-worker.ts", import.meta.url), { env: {} })
  const client = Rpc.client<Methods>(worker, { requireReady: true, timeoutMs: 1_000 })
  try {
    await expect(client.call("echo", { value: 1 })).rejects.toThrow("worker is not ready")
    await client.ready
    expect(await client.call("echo", { value: 2 })).toEqual({ value: 2 })
  } finally {
    client.close()
    worker.terminate()
  }
})

for (const mode of ["close", "error"]) {
  test(`worker ${mode} rejects readiness and prevents subsequent requests`, async () => {
    const worker = new Worker(new URL("../fixture/rpc-ready-worker.ts", import.meta.url), {
      env: { DAC_RPC_READY_FIXTURE: mode },
    })
    const client = Rpc.client<Methods>(worker, { requireReady: true, timeoutMs: 1_000 })
    worker.addEventListener("close", () => client.close(new Error("Owned worker exited")), { once: true })
    worker.onerror = (event) => {
      event.preventDefault()
      client.close(new Error("Owned worker failed"))
    }
    try {
      await expect(client.ready).rejects.toThrow(mode === "close" ? "worker exited" : "worker failed")
      await expect(client.call("echo", { value: 1 })).rejects.toThrow("RPC client closed")
    } finally {
      client.close()
      worker.terminate()
    }
  })
}

test("readiness has a finite timeout and closing it releases the client", async () => {
  const worker = new Worker(new URL("../fixture/rpc-ready-worker.ts", import.meta.url), {
    env: { DAC_RPC_READY_FIXTURE: "never" },
  })
  const client = Rpc.client<Methods>(worker, { requireReady: true, timeoutMs: 60 })
  try {
    await expect(client.ready).rejects.toThrow("RPC worker ready timed out after 60ms")
    await expect(client.call("echo", { value: 1 })).rejects.toThrow("RPC client closed")
  } finally {
    client.close()
    worker.terminate()
  }
})
