import { describe, expect, test } from "bun:test"
import { KernelClient } from "@/im/kernel/client"

// Execute the installed SDK's actual cache implementation. Appending a test-only export keeps
// all SDK helpers intact, rather than reproducing its algorithm in a local mock.
await import("@/im/kernel/shims")
const installed = await Bun.file(new URL(import.meta.resolve("jugglechat-websdk"))).text()
const sdk = await import(
  `data:text/javascript;base64,${Buffer.from(`${installed}\nexport { MessageCacher as testCache };`).toString("base64")}`
)
const createCache = sdk.testCache as () => {
  add: (conversation: { conversationType: number; conversationId: string }, messages: unknown[]) => void
  isInclude: (message: {
    conversationType: number
    conversationId: string
    messageId: string
    sentTime: number
  }) => boolean
}

describe("installed jugglechat-websdk message-ID dedup patch", () => {
  test("different message IDs in the same millisecond both pass; redelivery at another time does not", () => {
    const cache = createCache()
    const first = { conversationType: 2, conversationId: "group", messageId: "one", sentTime: 1_700_000_000_000 }
    const second = { ...first, messageId: "two" }
    expect(cache.isInclude(first)).toBe(false)
    cache.add(first, [first])
    expect(cache.isInclude(second)).toBe(false)
    cache.add(second, [second])
    expect(cache.isInclude({ ...first, sentTime: first.sentTime + 1 })).toBe(true)
    expect(cache.isInclude({ ...first, conversationId: "another" })).toBe(false)
  })

  test("same-time real SDK notifications normalize into two distinct client messages", () => {
    const cache = createCache()
    const received = ["one", "two"].flatMap((messageId) => {
      const payload = {
        conversationType: 1,
        conversationId: "bob",
        messageId,
        sentTime: 1_700_000_000_000,
        name: "jg:text",
        sender: { id: "bob" },
        content: { content: "@general hello" },
      }
      if (cache.isInclude(payload)) return []
      cache.add(payload, [payload])
      const message = KernelClient.normalizeTextMessage(payload)
      return message ? [message] : []
    })
    expect(received.map((message) => message.messageID)).toEqual(["one", "two"])
  })
})
