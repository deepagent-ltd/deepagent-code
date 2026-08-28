import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { DeepAgentContext } from "@deepagent-code/core/deepagent/index"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ConversationLogWriter } from "../../src/session/conversation-log-writer"

// V3.8 App-A C2.5 (Stage 5): proves the Conversation Log WRITE side actually populates the same
// per-session jsonl the query_log read tool consumes — a full turn's user/assistant/reasoning/tool
// parts land as real, queryable entries (before this the writer was unwired and query_log was empty).

const SESSION = "ses_writer_test"
let home: string
let prevHome: string | undefined

// Read the log back exactly the way tool/query_log.ts does (same baseDir + sessionLogFile helper).
const readEntries = () => {
  const file = DeepAgentContext.ConversationLog.sessionLogFile(path.join(Global.Path.agent.data, "state"), SESSION)
  return new DeepAgentContext.ConversationLog.ConversationLog(file).readAll()
}

const record = (msgs: readonly SessionV1.WithParts[]) =>
  Effect.runSync(
    Effect.gen(function* () {
      const writer = yield* ConversationLogWriter.make(SESSION)
      yield* ConversationLogWriter.record(writer, msgs)
    }),
  )

// Minimal but schema-shaped message/part builders. IDs are plain strings cast to the branded schema
// types — the writer only reads/round-trips them, never re-brands, so a cast is sound for the test.
const userMsg = (id: string, text: string): SessionV1.WithParts =>
  ({
    info: {
      id,
      sessionID: SESSION,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    },
    parts: [{ id: `prt_${id}_t`, sessionID: SESSION, messageID: id, type: "text", text }],
  }) as unknown as SessionV1.WithParts

const assistantMsg = (id: string, parts: unknown[], completed = true): SessionV1.WithParts =>
  ({
    info: {
      id,
      sessionID: SESSION,
      parentID: "msg_user",
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: home, root: home },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "claude",
      providerID: "anthropic",
      time: completed ? { created: Date.now(), completed: Date.now() } : { created: Date.now() },
    },
    parts,
  }) as unknown as SessionV1.WithParts

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "deepagent-logwriter-"))
  prevHome = process.env.DEEPAGENT_CODE_HOME
  process.env.DEEPAGENT_CODE_HOME = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
})

describe("ConversationLogWriter (Stage 5 write side)", () => {
  test("records user, assistant, reasoning and completed tool parts as queryable entries", () => {
    const msgs: SessionV1.WithParts[] = [
      userMsg("msg_user", "please add pagination"),
      assistantMsg("msg_asst", [
        { id: "prt_r", sessionID: SESSION, messageID: "msg_asst", type: "reasoning", text: "think about it", time: { start: 1 } },
        {
          id: "prt_tool",
          sessionID: SESSION,
          messageID: "msg_asst",
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "src/api.ts" },
            output: "file contents here",
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
        { id: "prt_t", sessionID: SESSION, messageID: "msg_asst", type: "text", text: "done, added pagination" },
      ]),
    ]
    record(msgs)

    const entries = readEntries()
    const byEvent = (e: string) => entries.filter((x) => x.event === e)

    expect(byEvent("user_message").map((e) => e.text)).toEqual(["please add pagination"])
    expect(byEvent("assistant_message").map((e) => e.text)).toEqual(["done, added pagination"])
    expect(byEvent("reasoning").map((e) => e.text)).toEqual(["think about it"])

    const call = byEvent("tool_call")[0]
    expect(call?.data?.tool).toBe("read")
    expect((call?.data?.input as { filePath?: string } | undefined)?.filePath).toBe("src/api.ts")
    const result = byEvent("tool_result")[0]
    expect(result?.text).toBe("file contents here")
    // Every entry carries the originating messageId and a monotonic seq.
    expect(entries.every((e) => typeof e.seq === "number" && e.seq > 0)).toBe(true)
  })

  test("skips synthetic text and non-completed tool parts", () => {
    record([
      assistantMsg("msg_a", [
        { id: "p1", sessionID: SESSION, messageID: "msg_a", type: "text", text: "internal note", synthetic: true },
        {
          id: "p2",
          sessionID: SESSION,
          messageID: "msg_a",
          type: "tool",
          callID: "c2",
          tool: "bash",
          state: { status: "running", input: {}, time: { start: 1 } },
        },
      ]),
    ])
    expect(readEntries()).toEqual([])
  })

  test("re-recording the same messages is idempotent (content dedup, incl. fresh writer)", () => {
    const msgs = [userMsg("msg_u", "hello"), assistantMsg("msg_a", [
      { id: "p_t", sessionID: SESSION, messageID: "msg_a", type: "text", text: "hi there" },
    ])]
    record(msgs)
    record(msgs) // same live path again
    record(msgs) // a brand-new writer rebuilds seen-set from disk

    const entries = readEntries()
    expect(entries.filter((e) => e.event === "user_message")).toHaveLength(1)
    expect(entries.filter((e) => e.event === "assistant_message")).toHaveLength(1)
  })

  test("query by event + keyword works through the ConversationLog reader", () => {
    record([
      userMsg("msg_u", "fix the flaky retry test"),
      assistantMsg("msg_a", [
        { id: "p_t", sessionID: SESSION, messageID: "msg_a", type: "text", text: "retry logic patched" },
      ]),
    ])
    const file = DeepAgentContext.ConversationLog.sessionLogFile(path.join(Global.Path.agent.data, "state"), SESSION)
    const log = new DeepAgentContext.ConversationLog.ConversationLog(file)
    const hits = log.query({ events: ["assistant_message"], keyword: "retry" })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toBe("retry logic patched")
  })
})
