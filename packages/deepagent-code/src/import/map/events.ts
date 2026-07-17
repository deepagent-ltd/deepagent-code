import type { SerializedEvent } from "@deepagent-code/core/event"
import type { AssistantTurn, SourceSession, Turn } from "../ir"
import { blockID, eventID, messageID, sessionID, slugify } from "../util/ids"

/**
 * Map a parsed {@link SourceSession} into a deepagent-code `SerializedEvent[]`
 * ready for `events.replayAll`.
 *
 * `seq` starts at 0 and strictly increases by exactly 1 per event (replayAll
 * rejects gaps). Each event id is a stable hash of (sourceId, seq, type) so
 * re-importing converges on identical events — the foundation of the writer's
 * delete-then-replay idempotency.
 *
 * Versioned type strings (`session.created.1`, `session.next.step.ended.2`, …)
 * mirror `EventV2.versionedType` / the `sync.version` on each definition in
 * `core/session/event.ts`. The unit test asserts every produced event decodes
 * against the canonical definition schema, so a drift here fails CI.
 */

export interface MapContext {
  /** Resolved deepagent-code project id (from `ProjectV2.resolve(cwd)`). */
  projectID: string
}

const DEFAULT_MODEL = { id: "imported", providerID: "imported" } as const
const DEFAULT_AGENT = "build"

/** Build events with a monotonically increasing seq and matching stable id. */
class Builder {
  private seq = -1
  constructor(
    private readonly sourceId: string,
    private readonly aggregateID: string,
    private readonly out: SerializedEvent[],
  ) {}
  push(type: string, data: Record<string, unknown>): void {
    const seq = (this.seq += 1)
    this.out.push({
      id: eventID(this.sourceId, seq, type),
      aggregateID: this.aggregateID,
      seq,
      type,
      data,
    } as SerializedEvent)
  }
}

export function mapSession(session: SourceSession, ctx: MapContext): SerializedEvent[] {
  const aggregateID = sessionID(session.source, session.sourceId)
  const events: SerializedEvent[] = []
  const b = new Builder(session.sourceId, aggregateID, events)

  const started = session.startedMs
  const updated = session.updatedMs ?? started
  const model = session.model ?? DEFAULT_MODEL

  b.push("session.created.1", {
    sessionID: aggregateID,
    info: {
      id: aggregateID,
      slug: slugify(session.title) || "imported",
      projectID: ctx.projectID,
      directory: session.cwd,
      title: session.title || "Imported session",
      version: "imported",
      time: { created: started, updated },
      agent: DEFAULT_AGENT,
      model,
      metadata: { importedFrom: session.source, sourceSessionId: session.sourceId },
    },
  })

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i]
    if (turn.kind === "user") {
      appendUser(b, turn, i, session, aggregateID, started)
    } else {
      appendAssistant(b, turn, i, session, aggregateID, model)
    }
  }

  return events
}

function appendUser(
  b: Builder,
  turn: Extract<Turn, { kind: "user" }>,
  turnIndex: number,
  session: SourceSession,
  aggregateID: string,
  started: number,
) {
  b.push("session.next.prompted.1", {
    timestamp: turn.timestampMs ?? started,
    sessionID: aggregateID,
    messageID: messageID(session.sourceId, turnIndex, "user"),
    prompt: { text: turn.text },
    delivery: "steer",
  })
}

function appendAssistant(
  b: Builder,
  turn: AssistantTurn,
  turnIndex: number,
  session: SourceSession,
  aggregateID: string,
  fallbackModel: { id: string; providerID: string; variant?: string },
) {
  const assistantMessageID = messageID(session.sourceId, turnIndex, "assistant")
  const model = turn.model ?? fallbackModel
  const ts = turn.timestampMs ?? session.startedMs

  b.push("session.next.step.started.1", {
    timestamp: ts,
    sessionID: aggregateID,
    assistantMessageID,
    agent: DEFAULT_AGENT,
    model,
  })

  for (let blockIndex = 0; blockIndex < turn.blocks.length; blockIndex++) {
    const block = turn.blocks[blockIndex]
    const bid = blockID(session.sourceId, turnIndex, blockIndex)
    if (block.type === "text") {
      b.push("session.next.text.ended.1", {
        timestamp: ts,
        sessionID: aggregateID,
        assistantMessageID,
        textID: bid,
        text: block.text,
      })
    } else if (block.type === "reasoning") {
      b.push("session.next.reasoning.ended.1", {
        timestamp: ts,
        sessionID: aggregateID,
        assistantMessageID,
        reasoningID: bid,
        text: block.text,
      })
    } else {
      b.push("session.next.tool.called.1", {
        timestamp: ts,
        sessionID: aggregateID,
        assistantMessageID,
        callID: block.callID,
        tool: block.name,
        input: (block.input as Record<string, unknown>) ?? {},
        provider: { executed: true },
      })
      if (block.error) {
        b.push("session.next.tool.failed.1", {
          timestamp: ts,
          sessionID: aggregateID,
          assistantMessageID,
          callID: block.callID,
          error: { type: "unknown", message: block.error },
          provider: { executed: true },
        })
      } else {
        b.push("session.next.tool.success.1", {
          timestamp: ts,
          sessionID: aggregateID,
          assistantMessageID,
          callID: block.callID,
          structured: { output: block.output ?? "" },
          content: block.output ? [{ type: "text", text: block.output }] : [],
          provider: { executed: true },
        })
      }
    }
  }

  const t = turn.tokens ?? {}
  b.push("session.next.step.ended.2", {
    timestamp: turn.completedMs ?? ts,
    sessionID: aggregateID,
    assistantMessageID,
    finish: turn.finish ?? "stop",
    cost: turn.cost ?? 0,
    tokens: {
      input: t.input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
      cache: { read: t.cacheRead ?? 0, write: t.cacheWrite ?? 0 },
    },
  })
}
