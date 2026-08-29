import { describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { ContextSessionEvent, Message, OpencodeClient, Part, SessionMessageResponse, ToolPart } from "@deepagent-code/sdk"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import * as ACPService from "@/acp/service"
import { Directory } from "@/acp/directory"
import { ACPSession } from "@/acp/session"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type ToolSessionUpdateParams = SessionUpdateParams & {
  update: Extract<SessionUpdateParams["update"], { sessionUpdate: "tool_call" | "tool_call_update" }>
}
type GlobalEventEnvelope = {
  payload?: { type?: string; properties?: Record<string, unknown> }
}

// §16.5 API-APP-PACKAGE P4 — the ACP control-plane now consumes the durable per-session
// journal (boundary events are full-value; deltas are live-only and no longer delivered
// through the volatile global stream). These tests drive Subscription.deliver() with
// journal payloads and assert the same ACP sessionUpdate vocabulary; the legacy
// metadata-fetch/delta tests were superseded by the journal boundary contract.

const pollUntil = async (
  check: () => boolean | Promise<boolean>,
  message: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > (opts?.timeoutMs ?? 2000)) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(ACPSession.defaultLayer).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createEventStream() {
  const queue: GlobalEventEnvelope[] = []
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []
  const state = { closed: false }

  const push = (event: GlobalEventEnvelope) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    queue.push(event)
  }

  const close = () => {
    state.closed = true
    for (const waiter of waiters.splice(0)) {
      waiter(undefined)
    }
  }

  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (state.closed) return
      const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => {
        waiters.push(resolve)
        signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return
      yield value
    }
  }

  return { push, close, stream }
}

function createHarness(messages: Record<string, SessionMessageResponse> = {}) {
  const updates: SessionUpdateParams[] = []
  const calls = {
    eventSubscribe: 0,
    message: 0,
  }
  const events = createEventStream()
  const sdk = {
    global: {
      event: (options?: { signal?: AbortSignal }) => {
        calls.eventSubscribe++
        return Promise.resolve({ stream: events.stream(options?.signal) })
      },
    },
    session: {
      message: (input: { messageID: string }) => {
        calls.message++
        return Promise.resolve({ data: messages[input.messageID] })
      },
      get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
      messages: () => Promise.resolve({ data: [] }),
    },
    context: {
      eventsCursor: async () => ({ watermark: 0, cursor: 0, floor: 0 }),
      events: async () => ({ events: [], floor: 0 }),
    },
  } as unknown as OpencodeClient
  const connection = {
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const session = makeSessionService()
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  return { calls, connection, events, sdk, session, subscription, updates }
}

const journal = (type: string, sessionID: string, extra: Record<string, unknown> = {}): ContextSessionEvent => ({
  id: `${type}_${sessionID}`,
  type,
  seq: 1,
  data: { sessionID, ...extra },
})

function textEnded(sessionID: string, messageID: string, partID: string, text: string): ContextSessionEvent {
  return journal("session.next.text.ended", sessionID, { assistantMessageID: messageID, textID: partID, text })
}

function reasoningEnded(sessionID: string, messageID: string, partID: string, text: string): ContextSessionEvent {
  return journal("session.next.reasoning.ended", sessionID, { assistantMessageID: messageID, reasoningID: partID, text })
}

function toolCalled(sessionID: string, callID: string, tool = "bash"): ContextSessionEvent {
  return journal("session.next.tool.called", sessionID, { callID, tool, input: { cmd: "printf hello" } })
}

function toolProgress(sessionID: string, callID: string, output: string): ContextSessionEvent {
  return journal("session.next.tool.progress", sessionID, {
    callID,
    structured: {},
    content: [{ type: "text", text: output }],
  })
}

function toolSuccess(sessionID: string, callID: string, output: string, extra: Record<string, unknown> = {}): ContextSessionEvent {
  return journal("session.next.tool.success", sessionID, {
    callID,
    structured: extra.metadata ?? { exit: 0 },
    content: [{ type: "text", text: output }],
  })
}

function toolFailed(sessionID: string, callID: string, message: string): ContextSessionEvent {
  return journal("session.next.tool.failed", sessionID, {
    callID,
    error: { type: "unknown", message },
  })
}

function toolUpdates(updates: SessionUpdateParams[]) {
  return updates.filter((item): item is ToolSessionUpdateParams => {
    return item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update"
  })
}

function runnerTool(callID: string, status: ToolPart["state"]["status"], extra: Record<string, unknown> = {}): ToolPart {
  const base = {
    id: `part_${callID}`,
    sessionID: "ses_loaded",
    messageID: `msg_${callID}`,
    type: "tool" as const,
    callID,
    tool: "bash",
    ...extra,
  }
  const now = Date.now()
  if (status === "running") return { ...base, state: { status: "running", input: { cmd: "printf hello" }, time: { start: now } } }
  if (status === "completed")
    return {
      ...base,
      state: { status: "completed", input: { cmd: "printf hello" }, output: "done", title: "bash", metadata: { exit: 0 }, time: { start: now, end: now } },
    }
  return { ...base, state: { status: "error", input: { cmd: "printf hello" }, error: "failed hard", time: { start: now, end: now } } }
}

function assistantToolMessage(part: ToolPart) {
  return {
    info: {
      id: part.messageID,
      sessionID: part.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  } satisfies SessionMessageResponse
}

async function createKnownSession(
  session: ACPSession.Interface,
  sessionId: string,
  part: { messageId: string; partId: string; partType: Part["type"] },
) {
  await Effect.runPromise(session.create({ id: sessionId, cwd: "/workspace" }))
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId: part.messageId,
      partId: part.partId,
      partType: part.partType,
      role: "assistant",
    }),
  )
}

describe("acp event routing", () => {
  it("routes journal text boundaries by sessionID without cross-session pollution", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })
    await createKnownSession(harness.session, "ses_b", { messageId: "msg_b", partId: "part_b", partType: "text" })

    await harness.subscription.deliver(textEnded("ses_b", "msg_b", "part_b", "hello"))

    expect(harness.updates.map((update) => update.sessionId)).toEqual(["ses_b"])
    expect(harness.updates[0]?.update.sessionUpdate).toBe("agent_message_chunk")
  })

  it("keeps interleaved sessions isolated for text and reasoning boundaries", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })
    await createKnownSession(harness.session, "ses_b", {
      messageId: "msg_b",
      partId: "part_b",
      partType: "reasoning",
    })

    await harness.subscription.deliver(textEnded("ses_a", "msg_a", "part_a", "A1"))
    await harness.subscription.deliver(reasoningEnded("ses_b", "msg_b", "part_b", "B1"))
    await harness.subscription.deliver(textEnded("ses_a", "msg_a", "part_a", "A2"))
    await harness.subscription.deliver(reasoningEnded("ses_b", "msg_b", "part_b", "B2"))

    expect(
      harness.updates.filter((update) => update.sessionId === "ses_a").map((update) => update.update.sessionUpdate),
    ).toEqual(["agent_message_chunk", "agent_message_chunk"])
    expect(
      harness.updates.filter((update) => update.sessionId === "ses_b").map((update) => update.update.sessionUpdate),
    ).toEqual(["agent_thought_chunk", "agent_thought_chunk"])
  })

  it("does not create extra subscriptions on repeated loadSession", async () => {
    const harness = createHarness()
    let subscription: ACPEvent.Subscription | undefined
    const service = ACPService.make({
      sdk: harness.sdk,
      connection: harness.connection,
      directory: {
        get: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        refresh: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        variants: Directory.variants,
      },
      session: harness.session,
      eventSubscription: (started) => {
        subscription = started
      },
    })

    await pollUntil(() => harness.calls.eventSubscribe === 1, "event subscription did not start")
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(harness.calls.eventSubscribe).toBe(1)
    subscription?.stop()
    harness.events.close()
  })

  it("delivers full-value text fully without metadata fetches", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })

    await harness.subscription.deliver(textEnded("ses_a", "msg_a", "part_a", "a"))
    await harness.subscription.deliver(textEnded("ses_a", "msg_a", "part_a", "ab"))

    expect(harness.calls.message).toBe(0)
    expect(harness.updates).toHaveLength(2)
  })

  it("replays loaded session messages sequentially and continues after update failures", async () => {
    const events = createEventStream()
    const updates: SessionUpdateParams[] = []
    const connection = {
      sessionUpdate: (params: SessionUpdateParams) => {
        if (params.update.sessionUpdate === "tool_call" && params.update.toolCallId === "call_slow") {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              updates.push(params)
              resolve()
            }, 20)
          })
        }

        if (params.update.sessionUpdate === "tool_call_update" && params.update.toolCallId === "call_slow") {
          return Promise.reject(new Error("replay send failed"))
        }

        updates.push(params)
        return Promise.resolve()
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">
    let subscription: ACPEvent.Subscription | undefined
    const service = ACPService.make({
      sdk: {
        global: {
          event: (options?: { signal?: AbortSignal }) => Promise.resolve({ stream: events.stream(options?.signal) }),
        },
        session: {
          get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
          messages: () =>
            Promise.resolve({
              data: [
                assistantToolMessage(runnerTool("call_slow", "completed", { output: "slow" })),
                assistantToolMessage(runnerTool("call_after", "completed", { output: "after" })),
              ],
            }),
        },
        context: {
          eventsCursor: async () => ({ watermark: 0, cursor: 0, floor: 0 }),
          events: async () => ({ events: [], floor: 0 }),
        },
      } as unknown as OpencodeClient,
      connection,
      directory: {
        get: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        refresh: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        variants: Directory.variants,
      },
      eventSubscription: (started) => {
        subscription = started
      },
    })

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(toolUpdates(updates).map((item) => item.update.toolCallId)).toEqual([
      "call_slow",
      "call_after",
      "call_after",
    ])
    subscription?.stop()
    events.close()
  })

  it("ignores unknown sessions for journal boundaries without user_message_chunk duplication", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_user", {
      messageId: "msg_user",
      partId: "part_user",
      partType: "text",
    })

    await harness.subscription.deliver(textEnded("ses_missing", "msg_missing", "part_missing", "ignored"))
    await harness.subscription.deliver(textEnded("ses_user", "msg_user", "part_user", "hello"))

    expect(harness.updates).toHaveLength(1)
  })

  it("emits pending on tool.called and running on tool.progress", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_tool", cwd: "/workspace" }))

    await harness.subscription.deliver(toolCalled("ses_tool", "call_1"))
    await harness.subscription.deliver(toolProgress("ses_tool", "call_1", "hello"))

    expect(toolUpdates(harness.updates).map((item) => item.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
    ])
    expect(harness.updates[0]?.update).toMatchObject({ status: "pending", toolCallId: "call_1" })
    expect(harness.updates[1]?.update).toMatchObject({ status: "in_progress", toolCallId: "call_1" })
  })

  it("does not duplicate the pending tool_call when the replayed tool is already running", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_loaded", cwd: "/workspace" }))

    await harness.subscription.replayMessage(
      assistantToolMessage(runnerTool("call_replay", "running")),
    )
    await harness.subscription.deliver(toolProgress("ses_loaded", "call_replay", "second"))

    expect(toolUpdates(harness.updates).filter((item) => item.update.sessionUpdate === "tool_call")).toHaveLength(1)
    expect(toolUpdates(harness.updates).map((item) => item.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ])
  })

  it("caches the tool name from tool.called for progress/success/failed boundaries", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_toolname", cwd: "/workspace" }))

    await harness.subscription.deliver(toolCalled("ses_toolname", "call_named"))
    await harness.subscription.deliver(toolProgress("ses_toolname", "call_named", "hello"))

    expect(toolUpdates(harness.updates).map((item) => item.update.toolCallId)).toEqual([
      "call_named",
      "call_named",
    ])
    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      kind: "execute",
    })
  })

  it("emits completed tool output and rawOutput from a journal success boundary", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_done", cwd: "/workspace" }))

    await harness.subscription.deliver(toolSuccess("ses_done", "call_done", "finished"))

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_done",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "finished" } }],
      rawOutput: { output: "finished", metadata: { exit: 0 } },
    })
  })

  it("emits journal error tool output", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_error", cwd: "/workspace" }))

    await harness.subscription.deliver(toolFailed("ses_error", "call_error", "failed hard"))

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_error",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "failed hard" } }],
      rawOutput: { error: "failed hard" },
    })
  })

  it("emits image attachments for replayed completed tool updates", async () => {
    const harness = createHarness()
    const image = Buffer.from("image-data").toString("base64")
    const attachment = {
      id: "file_image",
      sessionID: "ses_image",
      messageID: "msg_image",
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: `data:image/png;base64,${image}`
    } as const
    await Effect.runPromise(harness.session.create({ id: "ses_image", cwd: "/workspace" }))

    await harness.subscription.replayMessage(
      assistantToolMessage({
        id: "part_image",
        sessionID: "ses_image",
        messageID: "msg_image",
        type: "tool",
        callID: "call_replayed",
        tool: "bash",
        state: {
          status: "completed",
          input: { cmd: "printf replayed" },
          output: "replayed",
          title: "bash",
          metadata: { exit: 0 },
          attachments: [attachment],
          time: { start: Date.now(), end: Date.now() },
        } as ToolPart["state"],
      } satisfies ToolPart),
    )

    expect(
      toolUpdates(harness.updates)
        .filter((item) => item.update.status === "completed")
        .map((item) => ("content" in item.update ? item.update.content : [])),
    ).toEqual(
      [
        [
          { type: "content", content: { type: "text", text: "replayed" } },
          { type: "content", content: { type: "image", mimeType: "image/png", data: image } },
        ],
      ],
    )
  })

  it("normalizes permission.v2.asked into the ACP permission vocabulary", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_perm", cwd: "/workspace" }))

    await harness.subscription.handlePermission({
      type: "permission.v2.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_perm",
        action: "edit",
        resources: ["/workspace/file.ts"],
        metadata: { filepath: "/workspace/file.ts", diff: "a" },
        source: { callID: "call_1" },
      },
    })

    const requests = (await Effect.runPromise(harness.session.tryGet("ses_perm")))
    expect(requests).toBeDefined()
  })

  it("absorbs duplicate journal boundaries through the track applied-id set", async () => {
    const updates: SessionUpdateParams[] = []
    const session = makeSessionService()
    await Effect.runPromise(session.create({ id: "ses_track", cwd: "/workspace" }))

    const textEnded = (id: string, seq: number): ContextSessionEvent => ({
      id,
      type: "session.next.text.ended",
      seq,
      data: { sessionID: "ses_track", assistantMessageID: "msg_a", textID: "part_a", text: "hello" },
    })
    const events = createEventStream()
    const pages: Array<{ events: ContextSessionEvent[]; nextCursor?: number; floor: number }> = [
      { events: [textEnded("ev_a", 43)], nextCursor: 43, floor: 5 },
      // A resync / drain+tail overlap re-delivers the same boundary with a fresh seq: the drive
      // forwards it and the applied-id set absorbs it (single application).
      { events: [textEnded("ev_a", 44)], nextCursor: 44, floor: 5 },
      { events: [], floor: 5 },
    ]
    const sdk = {
      global: { event: () => Promise.resolve({ stream: events.stream() }) },
      session: { list: () => Promise.resolve({ data: [] }) },
      context: {
        eventsCursor: async () => ({ watermark: 42, cursor: 42, floor: 5 }),
        events: async () => {
          const page = pages.shift()
          return page ?? { events: [], floor: 5 }
        },
      },
    } as unknown as OpencodeClient
    const connection = {
      sessionUpdate: (params: SessionUpdateParams) => {
        updates.push(params)
        return Promise.resolve()
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">
    const subscription = new ACPEvent.Subscription({ sdk, connection, session })

    subscription.start()
    subscription.track("ses_track")
    await pollUntil(
      () => updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk").length === 1,
      "track did not deliver the boundary",
    )
    expect(updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1)
    subscription.stop()
    events.close()
  })

  it("resyncs from a 410 cursor gap during track and re-drains the boundary once", async () => {
    const updates: SessionUpdateParams[] = []
    const session = makeSessionService()
    await Effect.runPromise(session.create({ id: "ses_replay", cwd: "/workspace" }))

    const textEnded = (id: string, seq: number): ContextSessionEvent => ({
      id,
      type: "session.next.text.ended",
      seq,
      data: { sessionID: "ses_replay", assistantMessageID: "msg_b", textID: "part_b", text: "hi" },
    })
    const boundary = textEnded("ev_b", 43)
    const events = createEventStream()
    const pages: Array<{ events: ContextSessionEvent[]; nextCursor?: number; floor: number }> = [
      { events: [boundary], nextCursor: 43, floor: 5 },
      { events: [], floor: 5 },
    ]
    let callCount = 0
    const sdk = {
      global: { event: () => Promise.resolve({ stream: events.stream() }) },
      session: { list: () => Promise.resolve({ data: [] }) },
      context: {
        eventsCursor: async () => ({ watermark: 42, cursor: 42, floor: 5 }),
        events: async () => {
          callCount += 1
          // The first drain uses the initial cursor (after=42); the durable store reports the gap,
          // so the journal resyncs (re-reads the cursor and re-drains from the retained floor).
          if (callCount === 1) return Promise.reject(gapError())
          const page = pages.shift()
          return page ?? { events: [], floor: 5 }
        },
      },
    } as unknown as OpencodeClient
    const connection = {
      sessionUpdate: (params: SessionUpdateParams) => {
        updates.push(params)
        return Promise.resolve()
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">
    const subscription = new ACPEvent.Subscription({ sdk, connection, session })

    subscription.start()
    subscription.track("ses_replay")
    await pollUntil(
      () => updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk").length === 1,
      "track did not re-drain the boundary after the 410 resync",
    )
    // The re-drained boundary was delivered exactly once (not doubled by the resync).
    expect(updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1)
    subscription.stop()
    events.close()
  })
})

function gapError(): unknown {
  const body = {
    name: "ApiGone",
    data: {
      schemaVersion: "stable-error.v1",
      code: "cursor_gap_exceeded",
      category: "cursor",
      httpStatus: 410,
      resource: "ses-1",
      correlationId: "corr",
      message: "cursor below retained floor",
    },
  }
  return new Error("cursor below retained floor", { cause: { body } })
}
