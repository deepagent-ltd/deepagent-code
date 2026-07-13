// §S1.2 FIX C (sink side) — the Server Edition AgentReplySink must report a STEERED agent result as
// status:"steered" with NO content, so the gateway hub does not post an empty success message on the
// user's behalf. The prior bug: a steered result (success:true, empty content) computed status "success"
// and forwarded empty content. These tests drive the REAL ServerAgentReplySinkLive layer (via
// GATEWAY_CALLBACK_URL) and capture the HTTP callback body by stubbing global fetch — no network.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { AgentReplySinkService } from "@deepagent-code/core/im/agent-reply-sink"
import { ServerAgentReplySinkLive } from "@/im/agent-reply-sink-server"

type CapturedCall = { url: string; body: any }

const CALLBACK = "http://gateway.internal/callback"

describe("§S1.2 ServerAgentReplySink — steered result", () => {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.GATEWAY_CALLBACK_URL
  const originalToken = process.env.DEEPAGENT_CODE_SERVER_PASSWORD
  let calls: CapturedCall[]

  beforeEach(() => {
    calls = []
    process.env.GATEWAY_CALLBACK_URL = CALLBACK
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "tok"
    // Capture the callback body without touching the network. Return a 200 so notify treats it as ok.
    globalThis.fetch = (async (url: any, init?: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(null, { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.GATEWAY_CALLBACK_URL
    else process.env.GATEWAY_CALLBACK_URL = originalUrl
    if (originalToken === undefined) delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
    else process.env.DEEPAGENT_CODE_SERVER_PASSWORD = originalToken
  })

  const notify = (result: {
    success: boolean
    timeout: boolean
    steered?: boolean
    content?: string
    error?: { code: string; message: string; retryable: boolean }
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* AgentReplySinkService
        yield* sink.notify({ groupID: "grp-1", messageID: "msg-1", agentID: "code-agent", result })
      }).pipe(Effect.provide(ServerAgentReplySinkLive)),
    )

  it("a steered result reports status:steered with content undefined", async () => {
    await notify({ success: true, timeout: false, steered: true, content: "" })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${CALLBACK}/im/agent-reply`)
    // The seam: steered wins over success — status is "steered", not "success"/"failed".
    expect(calls[0].body.status).toBe("steered")
    // No content is forwarded (the running turn replies through its own path; the hub must not post an
    // empty message). `success && !steered ? content : undefined` ⇒ undefined here.
    expect(calls[0].body.content).toBeUndefined()
    // Kernel-native correlation keys are carried through unchanged.
    expect(calls[0].body).toMatchObject({
      groupId: "grp-1",
      triggerMessageId: "msg-1",
      agentName: "code-agent",
    })
  })

  it("contrast: a plain success still reports status:success WITH content (steered gate is precise)", async () => {
    await notify({ success: true, timeout: false, content: "here is your code" })

    expect(calls).toHaveLength(1)
    expect(calls[0].body.status).toBe("success")
    expect(calls[0].body.content).toBe("here is your code")
  })
})
