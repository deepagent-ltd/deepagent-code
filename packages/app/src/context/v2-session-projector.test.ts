import { describe, expect, test } from "bun:test"
import { applyBoundary, snapshotRows, userRow, type LegacyRow } from "./v2-session-projector"

// §16.5 API-APP-PACKAGE P6 — the App session rendering projection oracle: durable V2
// snapshot + journal boundaries project into the legacy SessionV1.WithParts row shape the
// timeline consumes, with idempotent boundary application (snapshot overlaps converge).

describe("v2 session projector", () => {
  test("projects a snapshot with user and assistant rows", () => {
    const rows = snapshotRows({
      sessionID: "ses-1",
      directory: "/workspace",
      root: "/workspace",
      messages: [
        { id: "msg_user_1", type: "user", text: "hello", files: undefined, agents: undefined, references: undefined, time: { created: 1 } } as never,
        {
          id: "msg_ass_1",
          type: "assistant",
          agent: "build",
          model: { id: "m", providerID: "p", variant: undefined },
          content: [{ type: "text", id: "prt_text_1", text: "hi" }],
          time: { created: 2, completed: 3 },
          finish: "stop",
          cost: 0.1,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } as never,
      ],
    })
    expect(rows.map((row) => row.info.role)).toEqual(["user", "assistant"])
    expect(String(rows[0]?.info.id)).toBe("msg_user_1")
    expect(rows[0]?.parts[0]?.type).toBe("text")
    expect((rows[1]?.parts[0] as { text?: string }).text).toBe("hi")
  })

  test("applies journal boundaries idempotently", () => {
    let rows: LegacyRow[] = []
    rows = applyBoundary(rows, {
      type: "session.next.prompted",
      data: { sessionID: "ses-1", messageID: "msg_user_1", prompt: { text: "hello" }, timestamp: 1 },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.info.role).toBe("user")

    rows = applyBoundary(rows, {
      type: "session.next.step.started",
      data: { sessionID: "ses-1", assistantMessageID: "msg_ass_1", agent: "build", timestamp: 2 },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.info.role).toBe("assistant")

    rows = applyBoundary(rows, {
      type: "session.next.text.ended",
      data: { sessionID: "ses-1", assistantMessageID: "msg_ass_1", textID: "prt_text_1", text: "hi", timestamp: 3 },
    })
    const textPart = rows[0]?.parts.find((part) => part.type === "text") as { text?: string } | undefined
    expect(textPart?.text).toBe("hi")

    // Re-applying the same boundary (snapshot overlap) converges without duplicate parts.
    rows = applyBoundary(rows, {
      type: "session.next.prompted",
      data: { sessionID: "ses-1", messageID: "msg_user_1", prompt: { text: "hello" }, timestamp: 1 },
    })
    rows = applyBoundary(rows, {
      type: "session.next.text.ended",
      data: { sessionID: "ses-1", assistantMessageID: "msg_ass_1", textID: "prt_text_1", text: "hi", timestamp: 3 },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.parts.filter((part) => part.type === "text")).toHaveLength(1)
  })

  test("tool success and failed boundaries settle tool parts", () => {
    let rows: LegacyRow[] = []
    rows = applyBoundary(rows, {
      type: "session.next.step.started",
      data: { sessionID: "ses-1", assistantMessageID: "msg_ass_1", agent: "build", timestamp: 1 },
    })
    rows = applyBoundary(rows, {
      type: "session.next.tool.success",
      data: {
        sessionID: "ses-1",
        assistantMessageID: "msg_ass_1",
        callID: "call_1",
        tool: "bash",
        input: { cmd: "ls" },
        content: [{ type: "text", text: "ok" }],
        timestamp: 2,
      },
    })
    const toolPart = rows[0]?.parts.find((part) => part.type === "tool") as {
      callID?: string;
      state?: { status?: string; output?: string };
    } | undefined
    expect(toolPart?.callID).toBe("call_1")
    expect(toolPart?.state?.status).toBe("completed")
    expect(toolPart?.state?.output).toBe("ok")
  })

  test("drops unknown directory mapping and keeps legacy rows untouched for non-journal events", () => {
    const row = userRow({ sessionID: "ses-1", messageID: "msg_x", text: "x", timeCreated: 1 })
    const next = applyBoundary(row ? [row] : [], {
      type: "session.next.retried",
      data: { sessionID: "ses-1", timestamp: 2 },
    })
    expect(next).toHaveLength(1)
  })

  test("re-applying a compaction.ended boundary keeps the row set unchanged", () => {
    let rows: LegacyRow[] = []
    const compaction = {
      type: "session.next.compaction.ended",
      data: {
        sessionID: "ses-1",
        messageID: "msg_comp_1",
        reason: "auto",
        text: "summarized",
        recent: "recent context",
        timestamp: 4,
      },
    }
    rows = applyBoundary(rows, compaction)
    expect(rows).toHaveLength(1)
    const part = rows[0]?.parts[0] as { type?: string; auto?: boolean } | undefined
    expect(part?.type).toBe("compaction")
    expect(part?.auto).toBe(true)

    // A crash-replay window re-publishes the same boundary; the second application must
    // converge to the identical row set (no duplicate row, no duplicate part).
    const before = JSON.stringify(rows)
    rows = applyBoundary(rows, compaction)
    expect(JSON.stringify(rows)).toBe(before)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.parts.filter((item) => item.type === "compaction")).toHaveLength(1)
  })

  test("manual compaction.ended boundaries project an auto=false compaction part", () => {
    let rows: LegacyRow[] = []
    rows = applyBoundary(rows, {
      type: "session.next.compaction.ended",
      data: { sessionID: "ses-1", messageID: "msg_comp_2", reason: "manual", text: "manual summary", timestamp: 5 },
    })
    const part = rows[0]?.parts[0] as { type?: string; auto?: boolean } | undefined
    expect(part?.type).toBe("compaction")
    expect(part?.auto).toBe(false)
  })
})