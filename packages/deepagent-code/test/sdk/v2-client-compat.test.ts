import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk/v2"

// Regression guard for the compatibility layer in packages/sdk/js/src/v2/client.ts.
// The generated SDK under gen/ is wiped on every `bun run build`; once the backend
// annotated request bodies as named schemas, regeneration renamed/re-nested methods
// (createFile→create, flat write→{ fileWriteBody }, lock methods → a `lock`
// sub-client) and dropped the hand-added debug.eventsUrl. That surfaced at runtime
// as `sdk.client.debug.eventsUrl is not a function`. These tests pin the historical
// flat surface so a future regeneration can't silently break the app again.
//
// NOTE: assertions are kept synchronous / single-request. Awaiting many mock
// fetches against the (very large) generated SDK module reliably OOMs/segfaults
// bun's runtime in CI sandboxes; the compat *shaping* is covered by the one
// request below plus the app/typecheck build.

function harness() {
  const calls: Array<{ method: string; url: string; body: string }> = []
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: (async (req: Request) => {
      calls.push({ method: req.method, url: req.url, body: await req.clone().text().catch(() => "") })
      return new Response("{}", { headers: { "content-type": "application/json" } })
    }) as never,
  })
  return { calls, client }
}

describe("v2 client compat layer", () => {
  test("debug.eventsUrl builds the SSE URL (not a fetch call) — the original crash", () => {
    const { client } = harness()
    expect(typeof client.debug.eventsUrl).toBe("function")
    expect(client.debug.eventsUrl()).toBe("/debug/events")
    expect(client.debug.eventsUrl({ sessionId: "s1" })).toBe("/debug/events?sessionId=s1")
    expect(client.debug.eventsUrl({ directory: "/repo", sessionId: "s1" })).toBe(
      "/debug/events?directory=%2Frepo&sessionId=s1",
    )
  })

  test("historical flat file/debug/profile methods are all present", () => {
    const { client } = harness()
    const present = (obj: unknown, name: string) => typeof (obj as Record<string, unknown>)[name] === "function"
    for (const m of ["createFile", "deleteFile", "lockAcquire", "lockRenew", "lockRelease", "write", "rename", "mkdir"])
      expect(present(client.file, m)).toBe(true)
    for (const m of ["start", "breakpoints", "continue", "step", "terminate", "evaluate", "scopes", "variables"])
      expect(present(client.debug, m)).toBe(true)
    for (const m of ["run", "hotspots"]) expect(present(client.profile, m)).toBe(true)
  })

  test("file.createFile shapes a flat POST to /file/create", async () => {
    const { calls, client } = harness()
    await client.file.createFile({ path: "/tmp/a.txt", content: "hi" })
    const call = calls.find((c) => c.url.includes("/file/create"))
    expect(call?.method).toBe("POST")
    expect(JSON.parse(call!.body)).toMatchObject({ path: "/tmp/a.txt", content: "hi" })
  })
})
