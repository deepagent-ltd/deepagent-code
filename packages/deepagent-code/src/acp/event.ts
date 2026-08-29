import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import * as Log from "@deepagent-code/core/util/log"
import type { ContextSessionEvent, OpencodeClient, Part, SessionMessageResponse, ToolPart } from "@deepagent-code/sdk"
import { Effect } from "effect"
import { openRunJournal, type RunJournalClient } from "../session-v2-journal"
import { ACPSession } from "./session"
import { ACPPermission } from "./permission"
import { partsToContentChunks, type ReplayPart } from "./content"
import {
  duplicateRunningToolUpdate,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  shellOutputSnapshot,
  completedToolUpdate,
} from "./tool"

const log = Log.create({ service: "acp-event" })

type Connection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
type GlobalEventEnvelope = {
  payload?: { type?: string; properties?: Record<string, unknown> }
}
type GlobalEventStream = {
  stream: AsyncIterable<GlobalEventEnvelope>
}

export function start(input: { sdk: OpencodeClient; connection: Connection; session: ACPSession.Interface }) {
  const subscription = new Subscription(input)
  subscription.start()
  return subscription
}

export class Subscription {
  private readonly abort = new AbortController()
  private readonly shellSnapshots = new Map<string, string>()
  private readonly toolStarts = new Set<string>()
  private readonly journals = new Map<string, { close: () => void }>()
  private readonly toolNames = new Map<string, string>()
  private readonly permission: ACPPermission.Handler
  private started = false

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {
    this.permission = new ACPPermission.Handler(input)
  }

  // §16.5 API-APP-PACKAGE P4 — the durable per-session journal is now the event authority;
  // the volatile global stream is demoted to the permission request surface (permission.asked
  // legacy + permission.v2.asked), which is a live request/response channel and is not
  // journaled. Journals are opened for every known session and for sessions tracked after
  // load/create; boundary events are full-value (deltas are live-only), so replayed
  // boundaries converge and the path is resync-safe by id + watermark.
  start() {
    if (this.started) return
    this.started = true
    void this.openKnownSessions().catch((error: unknown) => {
      if (this.abort.signal.aborted) return
      log.error("failed to open session journals", { error })
    })
    void this.runPermissionDrive().catch((error: unknown) => {
      if (this.abort.signal.aborted) return
      log.error("permission event subscription failed", { error })
    })
  }

  stop() {
    this.abort.abort()
    for (const journal of this.journals.values()) journal.close()
    this.journals.clear()
  }

  track(sessionID: string) {
    if (!this.started || this.journals.has(sessionID)) return
    const applied = new Set<string>()
    let closed = false
    let current: { close: () => void; done: Promise<void> } | undefined
    const close = () => {
      closed = true
      current?.close()
    }
    this.journals.set(sessionID, { close })
    // The durable cursor is read by openRunJournal itself (context.eventsCursor), and a 410 gap is
    // bounded-resynced there; the applied-id set absorbs duplicates from the value-boundary replay.
    void (async () => {
      while (!closed) {
        current = await openRunJournal(this.journalClient, sessionID, {
          onEvent: (payload) => {
            if (!payload.id || applied.has(payload.id)) return
            applied.add(payload.id)
            void this.deliver(payload).catch((error: unknown) => {
              log.error("failed to handle journal event", { error, type: payload.type })
            })
          },
          onResync: () => {},
          onStreamEnd: () => {},
          onError: (error) => log.error("session journal error", { sessionID, error }),
        })
        await current.done
        // A terminal error settles the journal without closing it; back off and reopen from the
        // durable head so a transient failure does not spin, and the applied-id set absorbs the
        // replay of any boundary already delivered.
        if (!closed) await new Promise((resolve) => setTimeout(resolve, 250))
      }
      this.journals.delete(sessionID)
    })().catch((error: unknown) => {
      log.error("session journal drive failed", { sessionID, error })
      this.journals.delete(sessionID)
    })
  }

  private get journalClient(): RunJournalClient {
    return {
      eventsCursor: async (sessionId) => this.input.sdk.context.eventsCursor({ session_id: sessionId }, { throwOnError: true }),
      events: async (sessionId, input) =>
        this.input.sdk.context.events(
          { session_id: sessionId, after: input?.after, limit: input?.limit },
          { throwOnError: true },
        ),
    }
  }

  private async openKnownSessions() {
    const sessions = await Effect.runPromise(this.input.session.list())
    for (const session of sessions) this.track(session.id)
  }

  private async runPermissionDrive() {
    while (!this.abort.signal.aborted) {
      const events = (await this.input.sdk.global.event({
        signal: this.abort.signal,
      })) as GlobalEventStream

      for await (const event of events.stream) {
        if (this.abort.signal.aborted) return
        if (!event.payload) continue
        if (event.payload.type !== "permission.asked" && event.payload.type !== "permission.v2.asked") continue
        void this.handlePermission({
          type: event.payload.type,
          properties: event.payload.properties ?? {},
        })
      }
      if (!this.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  // V1 permission.asked and V2 permission.v2.asked share the request/response shape after
  // normalization: id + sessionID + display permission + patterns + optional tool source.
  handlePermission(event: { readonly type: string; readonly properties: Record<string, unknown> }) {
    let properties = event.properties
    if (event.type === "permission.v2.asked") {
      const source = properties.source as { callID?: string } | undefined
      properties = {
        ...properties,
        permission: String(properties.action ?? "unknown"),
        patterns: Array.isArray(properties.resources) ? properties.resources.map(String) : [],
        ...(source?.callID ? { tool: { callID: source.callID } } : {}),
      }
    }
    this.permission.handle({ type: "permission.asked", properties } as never)
  }

    async deliver(payload: ContextSessionEvent) {
    const data = payload.data ?? {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    const assistantMessageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
    const text = typeof data.text === "string" ? data.text : undefined
    const callID = typeof data.callID === "string" ? data.callID : undefined
    // Progress/Success/Failed boundaries do not carry the tool name (ToolBase is
    // assistantMessageID + callID only); the name is cached from tool.called.
    const tool =
      (callID ? this.toolNames.get(callID) : undefined) ??
      (typeof data.tool === "string" ? data.tool : "tool")

    switch (payload.type) {
      case "session.next.text.ended":
        if (sessionID && assistantMessageID && text !== undefined && (await this.isKnownSession(sessionID))) {
          await this.input.connection.sessionUpdate({
            sessionId: sessionID,
            update: { sessionUpdate: "agent_message_chunk", messageId: assistantMessageID, content: { type: "text", text } },
          })
        }
        return
      case "session.next.reasoning.ended":
        if (sessionID && assistantMessageID && text !== undefined && (await this.isKnownSession(sessionID))) {
          await this.input.connection.sessionUpdate({
            sessionId: sessionID,
            update: { sessionUpdate: "agent_thought_chunk", messageId: assistantMessageID, content: { type: "text", text } },
          })
        }
        return
      case "session.next.tool.called":
        if (callID) this.toolNames.set(callID, tool)
        if (sessionID && callID && (await this.isKnownSession(sessionID))) {
          await this.input.connection.sessionUpdate({
            sessionId: sessionID,
            update: { sessionUpdate: "tool_call", ...pendingToolCall({ toolCallId: callID, toolName: tool }) },
          })
        }
        return
      case "session.next.tool.progress":
        if (await this.isKnownSession(sessionID)) await this.updateRunningTool(sessionID, data)
        return
      case "session.next.tool.success": {
        if (!sessionID || !callID || !(await this.isKnownSession(sessionID))) return
        const input = journalInput(data)
        const output = toolContentText(data.content)
        await this.input.connection.sessionUpdate({
          sessionId: sessionID,
          update: {
            sessionUpdate: "tool_call_update",
            ...completedToolUpdate({
              toolCallId: callID,
              toolName: tool,
              state: {
                status: "completed",
                input,
                output,
                metadata: data.structured,
                title: tool,
              },
            }),
          },
        })
        return
      }
      case "session.next.tool.failed": {
        if (!sessionID || !callID || !(await this.isKnownSession(sessionID))) return
        const input = journalInput(data)
        const error = data.error as { message?: unknown } | undefined
        await this.input.connection.sessionUpdate({
          sessionId: sessionID,
          update: {
            sessionUpdate: "tool_call_update",
            ...errorToolUpdate({
              toolCallId: callID,
              toolName: tool,
              state: {
                status: "error",
                input,
                error: typeof error?.message === "string" ? error.message : "tool failed",
              },
            }),
          },
        })
        return
      }
    }
  }

  private async isKnownSession(sessionID: string | undefined) {
    if (!sessionID) return false
    return (await Effect.runPromise(this.input.session.tryGet(sessionID))) !== undefined
  }

  private async updateRunningTool(sessionID: string | undefined, data: Record<string, unknown>) {
    const callID = typeof data.callID === "string" ? data.callID : undefined
    const tool =
      (callID ? this.toolNames.get(callID) : undefined) ??
      (typeof data.tool === "string" ? data.tool : "tool")
    if (!sessionID || !callID) return
    const input = journalInput(data)
    const output = toolContentText(data.content)
    await this.input.connection.sessionUpdate({
      sessionId: sessionID,
      update: {
        sessionUpdate: "tool_call_update",
        ...runningToolUpdate({
          toolCallId: callID,
          toolName: tool,
          state: { status: "running", input },
          ...(output ? { output } : {}),
        }),
      },
    })
  }

  async replayMessage(message: SessionMessageResponse) {
    if (message.info.role !== "assistant" && message.info.role !== "user") return

    for (const part of message.parts) {
      await this.recordFetchedPart(message.info.sessionID, message, part)
      if (part.type === "tool") {
        await this.handleToolPart(message.info.sessionID, part)
        continue
      }
      await this.replayContentPart(message, part)
    }
  }

  private async replayContentPart(message: SessionMessageResponse, part: Part) {
    if (part.type !== "text" && part.type !== "file" && part.type !== "reasoning") return

    const sessionUpdate =
      part.type === "reasoning"
        ? "agent_thought_chunk"
        : message.info.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk"

    for (const chunk of partsToContentChunks([part as ReplayPart])) {
      await this.input.connection.sessionUpdate({
        sessionId: message.info.sessionID,
        update: {
          sessionUpdate,
          messageId: message.info.id,
          ...chunk,
        },
      })
    }
  }

  private async recordFetchedPart(sessionId: string, message: SessionMessageResponse, part: Part) {
    return await Effect.runPromise(
      this.input.session.recordPartMetadata({
        sessionId,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
        role: message.info.role,
        ignored: part.type === "text" ? part.ignored : undefined,
        toolCallId: part.type === "tool" ? part.callID : undefined,
        metadata: "metadata" in part ? part.metadata : undefined,
      }),
    )
  }

  private async handleToolPart(sessionId: string, part: ToolPart) {
    await this.toolStart(sessionId, part)

    switch (part.state.status) {
      case "pending":
        this.shellSnapshots.delete(part.callID)
        return

      case "running":
        await this.runningTool(sessionId, part)
        return

      case "completed":
        this.clearTool(part.callID)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...completedToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
            }),
          },
        })
        return

      case "error":
        this.clearTool(part.callID)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...errorToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
            }),
          },
        })
        return
    }
  }

  private async runningTool(sessionId: string, part: ToolPart) {
    if (part.state.status !== "running") return

    const output = part.tool === "bash" ? shellOutputSnapshot(part.state) : undefined
    if (output !== undefined) {
      if (this.shellSnapshots.get(part.callID) === output) {
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...duplicateRunningToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
            }),
          },
        })
        return
      }
      this.shellSnapshots.set(part.callID, output)
    }

    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        ...runningToolUpdate({
          toolCallId: part.callID,
          toolName: part.tool,
          state: part.state,
          output,
        }),
      },
    })
  }

  private async toolStart(sessionId: string, part: ToolPart) {
    if (this.toolStarts.has(part.callID)) return
    this.toolStarts.add(part.callID)
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        ...pendingToolCall({
          toolCallId: part.callID,
          toolName: part.tool,
        }),
      },
    })
  }

  private clearTool(toolCallId: string) {
    this.toolStarts.delete(toolCallId)
    this.shellSnapshots.delete(toolCallId)
  }
}

function journalInput(data: Record<string, unknown>): Record<string, unknown> {
  return typeof data.input === "object" && data.input !== null && !Array.isArray(data.input)
    ? (data.input as Record<string, unknown>)
    : {}
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) =>
      typeof item === "object" && item !== null && "text" in item && typeof item.text === "string"
        ? item.text
        : "",
    )
    .filter((item) => item.trim().length > 0)
    .join("\n")
}

export * as ACPEvent from "./event"