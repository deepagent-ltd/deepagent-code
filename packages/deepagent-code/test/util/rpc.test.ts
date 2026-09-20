import { describe, expect, test } from "bun:test"
import { Rpc } from "@/util/rpc"

type Methods = {
  echo: (input: { value: number }) => { value: number }
}

function endpoint() {
  const sent: string[] = []
  return {
    sent,
    target: {
      onmessage: null as ((event: MessageEvent<unknown>) => unknown) | null,
      postMessage(data: string) {
        sent.push(data)
      },
    },
  }
}

describe("worker RPC client", () => {
  test("resolves replies and rejects remote errors", async () => {
    const fake = endpoint()
    const client = Rpc.client<Methods>(fake.target, { timeoutMs: 1_000 })
    const success = client.call("echo", { value: 1 })
    const request = JSON.parse(fake.sent[0]) as { id: number }
    fake.target.onmessage?.({
      data: JSON.stringify({ type: "rpc.result", result: { value: 1 }, id: request.id }),
    } as MessageEvent<string>)
    expect(await success).toEqual({ value: 1 })

    const failure = client.call("echo", { value: 2 })
    const failedRequest = JSON.parse(fake.sent[1]) as { id: number }
    fake.target.onmessage?.({
      data: JSON.stringify({ type: "rpc.result", error: "worker exploded", id: failedRequest.id }),
    } as MessageEvent<string>)
    await expect(failure).rejects.toThrow("worker exploded")
    client.close()
  })

  test("times out lost replies and bounds pending requests", async () => {
    const fake = endpoint()
    const client = Rpc.client<Methods>(fake.target, { timeoutMs: 10, maxPending: 1 })
    const pending = client.call("echo", { value: 1 })
    await expect(client.call("echo", { value: 2 })).rejects.toThrow("pending request limit exceeded")
    await expect(pending).rejects.toThrow('RPC request "echo" timed out')
    client.close()
  })

  test("bounds subscriptions, removes empty sets, and rejects pending work on close", async () => {
    const fake = endpoint()
    const client = Rpc.client<Methods>(fake.target, { timeoutMs: 1_000, maxListeners: 1 })
    const values: number[] = []
    const off = client.on<number>("tick", (value) => values.push(value))
    expect(() => client.on("tick", () => {})).toThrow("listener limit exceeded")
    fake.target.onmessage?.({ data: JSON.stringify({ type: "rpc.event", event: "tick", data: 3 }) } as MessageEvent<string>)
    expect(values).toEqual([3])
    off()
    const offAgain = client.on("tick", () => {})
    offAgain()

    const pending = client.call("echo", { value: 1 })
    client.close(new Error("worker stopped"))
    await expect(pending).rejects.toThrow("worker stopped")
    await expect(client.call("echo", { value: 2 })).rejects.toThrow("RPC client closed")
  })
})
