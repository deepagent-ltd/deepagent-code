import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { mapSession } from "../events"
import type { SourceSession } from "../../ir"

/**
 * Decode a produced event's `data` against the canonical definition schema.
 * The projector replays events via the same decode path, so a green decode
 * here is the strongest cheap proof that replayAll won't `Effect.die` on shape.
 */
function decode(baseType: string, data: unknown): unknown {
  const schema = DEFINITIONS[baseType]
  if (!schema) throw new Error(`no definition registered for ${baseType}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Schema.decodeUnknownSync(schema as any)(data)
}

const DEFINITIONS: Record<string, unknown> = {
  "session.created": SessionV1.Event.Created.data,
  "session.next.prompted": SessionEvent.Prompted.data,
  "session.next.step.started": SessionEvent.Step.Started.data,
  "session.next.step.ended": SessionEvent.Step.Ended.data,
  "session.next.text.ended": SessionEvent.Text.Ended.data,
  "session.next.reasoning.ended": SessionEvent.Reasoning.Ended.data,
  "session.next.tool.called": SessionEvent.Tool.Called.data,
  "session.next.tool.success": SessionEvent.Tool.Success.data,
  "session.next.tool.failed": SessionEvent.Tool.Failed.data,
}

const baseType = (versioned: string) => versioned.replace(/\.\d+$/, "")

function sampleSession(): SourceSession {
  return {
    source: "codex",
    sourceId: "019f1b59-fb91-7853-8251-8acf45ef5afb",
    cwd: "/tmp/proj",
    title: "测试会话",
    startedMs: 1_782_870_400_000,
    updatedMs: 1_782_870_500_000,
    model: { id: "gpt-5", providerID: "openai" },
    turns: [
      { kind: "user", text: "你好", timestampMs: 1_782_870_401_000 },
      {
        kind: "assistant",
        timestampMs: 1_782_870_402_000,
        completedMs: 1_782_870_410_000,
        model: { id: "gpt-5", providerID: "openai" },
        finish: "stop",
        cost: 0.001,
        tokens: { input: 100, output: 50 },
        blocks: [
          { type: "reasoning", text: "思考中" },
          { type: "text", text: "你好！" },
          { type: "tool", callID: "call_1", name: "bash", input: { command: "ls" }, output: "a.txt" },
          { type: "tool", callID: "call_2", name: "bash", input: { command: "err" }, error: "boom" },
        ],
      },
    ],
  }
}

describe("import map/events", () => {
  it("produces a contiguous seq stream starting at 0", () => {
    const events = mapSession(sampleSession(), { projectID: "proj_1" })
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    expect(events[0].seq).toBe(0)
  })

  it("uses one stable aggregate id and deterministic event ids", () => {
    const a = mapSession(sampleSession(), { projectID: "proj_1" })
    const b = mapSession(sampleSession(), { projectID: "proj_1" })
    const agg = a[0].aggregateID
    expect(a.every((e) => e.aggregateID === agg)).toBe(true)
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id))
    expect(agg.startsWith("ses_")).toBe(true)
  })

  it("versioned types match sync.version on each definition", () => {
    const events = mapSession(sampleSession(), { projectID: "proj_1" })
    const types = new Set(events.map((e) => e.type))
    expect(types.has("session.created.1")).toBe(true)
    expect(types.has("session.next.prompted.1")).toBe(true)
    expect(types.has("session.next.step.started.1")).toBe(true)
    expect(types.has("session.next.text.ended.1")).toBe(true)
    expect(types.has("session.next.reasoning.ended.1")).toBe(true)
    expect(types.has("session.next.tool.called.1")).toBe(true)
    expect(types.has("session.next.tool.success.1")).toBe(true)
    expect(types.has("session.next.tool.failed.1")).toBe(true)
    // step.ended is sync.version 2
    expect(types.has("session.next.step.ended.2")).toBe(true)
    expect(types.has("session.next.step.ended.1")).toBe(false)
  })

  it("every event data decodes against its canonical definition schema", () => {
    const events = mapSession(sampleSession(), { projectID: "proj_1" })
    for (const e of events) {
      const bt = baseType(e.type)
      expect(() => decode(bt, e.data)).not.toThrow()
    }
  })

  it("decodes the full replayable union when re-tagged by type", () => {
    // Build a combined {type, ...data} object per event and decode against the
    // SessionEvent.All union for step/text/tool/reasoning events; this mirrors
    // how projectors re-dispatch by type.
    const events = mapSession(sampleSession(), { projectID: "proj_1" })
    for (const e of events) {
      if (e.type === "session.created.1") continue
      expect(() => decode(baseType(e.type), e.data)).not.toThrow()
    }
  })

  it("redacts nothing here but maps an empty assistant turn safely", () => {
    const s: SourceSession = {
      source: "claude",
      sourceId: "abc",
      cwd: "/tmp",
      title: "empty",
      startedMs: 1_000,
      turns: [{ kind: "assistant", blocks: [] }],
    }
    const events = mapSession(s, { projectID: "p" })
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(events[2].type).toBe("session.next.step.ended.2")
    for (const e of events) {
      expect(() => decode(baseType(e.type), e.data)).not.toThrow()
    }
  })
})
