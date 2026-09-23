import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { Usage } from "@deepagent-code/llm"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { SessionActivityTable, SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import { Location } from "@deepagent-code/core/location"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { ChatPayload } from "../groups/gateway-wire"

type Tenant = typeof ProxyTenantTable.$inferSelect

export const proxyLaneID = (tenant: Tenant, hint: string) =>
  SessionV2.ID.make(`ses_proxy_${contentDigest(`${tenant.id}:${tenant.key_fingerprint}:${tenant.tier}:${hint}`).slice(0, 24)}`)

export const proxyPromptID = (tenant: Tenant, requestID: string) =>
  SessionMessage.ID.make(`msg_${contentDigest(`proxy:${tenant.id}:${requestID}`).slice(0, 40)}`)

/** The collector only reads durable activity/input/message projections; SessionV2.prompt owns
 * admission and advisory wake. It never resumes, waits on, or replays provider execution. */
export const collectEnhanced = (input: {
  db: Database.Interface["db"]
  sessions: SessionV2.Interface
  tenant: Tenant
  sessionID: SessionV2.ID
  hint: string
  requestID: string
  request: ChatPayload
  providerID: string
  modelID: string
  onDelta?: (text: string) => Effect.Effect<void>
  /** Clock for provider deadline checks; callers normally use wall time. */
  now?: () => number
}) =>
  Effect.gen(function* () {
    let emitted = ""
    const events = yield* EventV2Bridge.Service
    const unsubscribe = input.onDelta
      ? yield* events.listen((event) => Effect.gen(function* () {
          if (!Schema.is(SessionEvent.Text.Delta)(event) || event.data.sessionID !== input.sessionID) return
          const active = yield* input.db.select({ trigger_input_id: SessionActivityTable.trigger_input_id })
            .from(SessionActivityTable)
            .where(and(eq(SessionActivityTable.session_id, input.sessionID), eq(SessionActivityTable.state, "active")))
            .get()
          if (active?.trigger_input_id !== proxyPromptID(input.tenant, input.requestID)) return
          emitted += event.data.delta
          yield* input.onDelta!(event.data.delta).pipe(Effect.ignore)
        }).pipe(Effect.ignore))
      : Effect.void
    return yield* Effect.gen(function* () {
    const hint = input.hint
    const existing = yield* input.sessions.get(input.sessionID).pipe(Effect.option)
    if (Option.isSome(existing)) {
      const binding = existing.value.metadata?.proxy
      if (!binding || typeof binding !== "object" ||
        (binding as Record<string, unknown>).tenant !== input.tenant.id ||
        (binding as Record<string, unknown>).keyFingerprint !== input.tenant.key_fingerprint ||
        (binding as Record<string, unknown>).hint !== hint ||
        (binding as Record<string, unknown>).tier !== input.tenant.tier ||
        existing.value.location.directory !== input.tenant.directory ||
        existing.value.model?.id !== input.modelID || existing.value.model?.providerID !== input.providerID)
        return { ok: false as const, status: 409, code: "lane_conflict", message: "Session lane binding conflicts with this request" }
    }
    if (Option.isNone(existing) || existing.value.time.archived) {
      const activeLanes = yield* input.db.select({ id: SessionTable.id }).from(SessionTable)
        .where(and(
          eq(sql<string>`json_extract(${SessionTable.metadata}, '$.proxy.tenant')`, input.tenant.id),
          eq(sql<string>`json_extract(${SessionTable.metadata}, '$.proxy.keyFingerprint')`, input.tenant.key_fingerprint),
          isNull(SessionTable.time_archived),
        )).orderBy(asc(SessionTable.time_updated)).all()
      let needed = activeLanes.length - input.tenant.lane_limit + 1
      for (const lane of activeLanes) {
        if (needed <= 0) break
        const running = yield* input.db.select({ id: SessionActivityTable.activity_id }).from(SessionActivityTable)
          .where(and(eq(SessionActivityTable.session_id, lane.id), eq(SessionActivityTable.state, "active"))).get()
        const pending = yield* input.db.select({ id: SessionInputTable.id }).from(SessionInputTable)
          .where(and(eq(SessionInputTable.session_id, lane.id), isNull(SessionInputTable.promoted_seq))).get()
        if (running || pending) continue
        yield* input.sessions.setArchived({ sessionID: lane.id, archived: true })
        needed--
      }
      if (needed > 0)
        return { ok: false as const, status: 429, code: "lane_limit_exceeded", message: "Proxy lane limit reached" }
      if (Option.isSome(existing)) yield* input.sessions.setArchived({ sessionID: input.sessionID, archived: false })
    }
    const session = yield* input.sessions.create({
      id: input.sessionID,
      title: `Proxy ${input.tenant.id}`,
      metadata: { proxy: { tenant: input.tenant.id, keyFingerprint: input.tenant.key_fingerprint, hint,
        tier: input.tenant.tier } },
      location: Location.Ref.make({ directory: AbsolutePath.make(input.tenant.directory) }),
      model: { id: ModelV2.ID.make(input.modelID), providerID: ProviderV2.ID.make(input.providerID) },
      permissions: input.tenant.tier === "context" ? [{ action: "*", resource: "*", effect: "deny" }] : input.tenant.permission_policy ?? [],
    })
    const binding = session.metadata?.proxy
    if (
      !binding || typeof binding !== "object" ||
      (binding as Record<string, unknown>).tenant !== input.tenant.id ||
      (binding as Record<string, unknown>).keyFingerprint !== input.tenant.key_fingerprint ||
      (binding as Record<string, unknown>).hint !== hint ||
      (binding as Record<string, unknown>).tier !== input.tenant.tier ||
      session.location.directory !== input.tenant.directory ||
      session.model?.id !== input.modelID || session.model?.providerID !== input.providerID
    )
      return { ok: false as const, status: 409, code: "lane_conflict", message: "Session lane binding conflicts with this request" }

    const admitted = yield* input.sessions.prompt({
      id: proxyPromptID(input.tenant, input.requestID),
      sessionID: input.sessionID,
      prompt: new Prompt({ text: JSON.stringify(input.request.messages.at(-1)) }),
      delivery: "queue",
      resume: true,
    }).pipe(Effect.match({ onFailure: () => ({ error: true as const }), onSuccess: (value) => ({ value }) }))
    if ("error" in admitted)
      return { ok: false as const, status: 409, code: "request_conflict", message: "Request ID conflicts with an admitted prompt" }

    const now = input.now ?? Date.now
    const deadline = now() + input.tenant.deadline_ms
    const timeout = { ok: false as const, status: 504, code: "enhancement_timeout", message: "Enhanced response timed out" }
    while (true) {
      const activity = yield* input.db.select().from(SessionActivityTable)
        .where(and(eq(SessionActivityTable.session_id, input.sessionID), eq(SessionActivityTable.trigger_input_id, admitted.value.id)))
        .get()
      if (!activity) {
        if (now() >= deadline) return timeout
        yield* Effect.sleep("50 millis")
        continue
      }
      const trigger = yield* input.db.select({ promoted_seq: SessionInputTable.promoted_seq }).from(SessionInputTable)
        .where(eq(SessionInputTable.id, admitted.value.id)).get()
      if (trigger?.promoted_seq === null || trigger?.promoted_seq === undefined) {
        if (now() >= deadline) return timeout
        yield* Effect.sleep("50 millis")
        continue
      }
      const next = yield* input.db.select().from(SessionActivityTable)
        .where(and(eq(SessionActivityTable.session_id, input.sessionID), gt(SessionActivityTable.ordinal, activity.ordinal)))
        .orderBy(asc(SessionActivityTable.ordinal)).limit(1).get()
      const nextInput = next
        ? yield* input.db.select({ promoted_seq: SessionInputTable.promoted_seq }).from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make(next.trigger_input_id))).get()
        : undefined
      const rows = yield* input.db.select().from(SessionMessageTable)
        .where(and(
          eq(SessionMessageTable.session_id, input.sessionID),
          eq(SessionMessageTable.type, "assistant"),
          gt(SessionMessageTable.seq, trigger.promoted_seq),
          nextInput?.promoted_seq === null || nextInput?.promoted_seq === undefined
            ? undefined : lt(SessionMessageTable.seq, nextInput.promoted_seq),
        )).orderBy(asc(SessionMessageTable.seq)).all()
      const terminal = rows.findLast((row) => row.data && "finish" in row.data && row.data.finish !== "tool-calls")
      const latest = activity.state === "settled" ? terminal : rows.at(-1)
      const message = latest ? yield* input.sessions.message({ sessionID: input.sessionID, messageID: latest.id }) : undefined
      const terminalMessage = terminal && latest?.id !== terminal.id
        ? yield* input.sessions.message({ sessionID: input.sessionID, messageID: terminal.id }) : message
      // The provider deadline is established by the durable terminal assistant completion. Once
      // the provider finished in time, allow bounded time for the activity/identity projection to
      // settle; otherwise a blocked poll can report 504 after a successful provider exchange.
      const completedAt = terminal && terminalMessage?.type === "assistant" && terminalMessage.time.completed
        ? DateTime.toEpochMillis(terminalMessage.time.completed) : undefined
      const settlementDeadline = completedAt !== undefined && completedAt <= deadline
        ? Math.max(deadline, completedAt + Math.max(input.tenant.deadline_ms, 30_000)) : deadline
      if (activity.state === "settled" && message?.type === "assistant" && input.onDelta) {
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        if (!text.startsWith(emitted))
          return { ok: false as const, status: 502, code: "enhancement_projection_changed", message: "Enhanced response projection changed during streaming" }
        if (text.length > emitted.length) yield* input.onDelta(text.slice(emitted.length))
        emitted = text
      }
      if (activity.state === "failed" || activity.state === "interrupted" || message?.type === "assistant" && message.error)
        return { ok: false as const, status: 502, code: "enhancement_failed", message: "Enhanced execution failed" }
      if ((now() >= settlementDeadline && activity.state !== "settled") ||
        (activity.state === "settled" && (activity.settled_at ?? 0) > settlementDeadline))
        return timeout
      if (activity.state !== "settled") {
        yield* Effect.sleep("50 millis")
        continue
      }
      if (!terminal || message?.type !== "assistant")
        return { ok: false as const, status: 502, code: "enhancement_projection_missing", message: "Enhanced response projection is missing" }
      const usage = message.tokens ? Usage.from({
        inputTokens: message.tokens.input,
        outputTokens: message.tokens.output,
        reasoningTokens: message.tokens.reasoning,
        cacheReadInputTokens: message.tokens.cache.read,
        cacheWriteInputTokens: message.tokens.cache.write,
        totalTokens: message.tokens.input + message.tokens.output,
      }) : undefined
      const selections = yield* input.db.select({
        selection_id: SessionContextSelectionTable.selection_id,
        token_count: SessionContextSelectionTable.token_count,
        projection_hash: SessionContextSelectionTable.projection_hash,
        selected_refs: SessionContextSelectionTable.selected_refs,
      }).from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.activity_id, activity.activity_id)).all()
      return {
        ok: true as const,
        text: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        finishReason: message.finish ?? "stop",
        usage,
        firstTokenAt: terminal.time_created,
        completedAt: DateTime.toEpochMillis(message.time.completed ?? message.time.created),
        trace: {
          activityID: activity.activity_id,
          selections: selections.map((selection) => ({
            selectionID: selection.selection_id,
            tokenCount: selection.token_count,
            projectionHash: selection.projection_hash,
            selectedRefs: selection.selected_refs.slice(0, 4096),
            truncated: selection.selected_refs.length > 4096,
          })),
        },
      }
    }
    }).pipe(Effect.ensuring(unsubscribe))
  })
