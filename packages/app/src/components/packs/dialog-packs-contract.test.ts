import { describe, expect, test } from "bun:test"
import { listPacks, setPackPinned } from "./dialog-packs"

type Call = { name: string; input?: unknown }

function client(calls: Call[], data?: Awaited<ReturnType<typeof listPacks>>) {
  return {
    deepagent: {
      packsAll: async () => {
        calls.push({ name: "packsAll" })
        return {
          data,
          response: new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        }
      },
      packsPin: async (input: { packId: string }) => {
        calls.push({ name: "packsPin", input })
      },
      packsUnpin: async (input: { packId: string }) => {
        calls.push({ name: "packsUnpin", input })
      },
    },
  }
}

describe("DeepAgent packs dialog SDK contract", () => {
  test("listPacks uses the generated packsAll SDK method and unwraps packs", async () => {
    const calls: Call[] = []
    const packs = [
      {
        id: "code.review",
        name: "Code Review",
        version: "1.0.0",
        risk: "medium" as const,
        domains: ["code"],
        builtin: true,
        pinned: false,
      },
    ]

    expect(await listPacks(client(calls, { packs }))).toEqual({ packs })
    expect(calls).toEqual([{ name: "packsAll" }])
  })

  test("listPacks tolerates a missing data field", async () => {
    const calls: Call[] = []
    expect(await listPacks(client(calls, undefined))).toEqual({ packs: [] })
  })

  test("setPackPinned uses generated pin and unpin SDK methods", async () => {
    const calls: Call[] = []
    await setPackPinned(client(calls, undefined), "pin", "code.review")
    await setPackPinned(client(calls, undefined), "unpin", "code.review")

    expect(calls).toEqual([
      { name: "packsPin", input: { packId: "code.review" } },
      { name: "packsUnpin", input: { packId: "code.review" } },
    ])
  })
})
