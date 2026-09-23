import { and, asc, eq, gt, lt } from "drizzle-orm"
import { Effect } from "effect"
import { Usage } from "@deepagent-code/llm"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import { Location } from "@deepagent-code/core/location"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionInputTable, SessionMessageTable } from "@deepagent-code/core/session/sql"
import type { ChatPayload } from "../groups/gateway-wire"

type Tenant = typeof ProxyTenantTable.$inferSelect

export const proxyLaneID = (tenant: Tenant, hint: string) =>
  SessionV2.ID.make(`ses_proxy_${contentDigest(`${tenant.id}:${tenant.key_fingerprint}:${hint}`).slice(0, 24)}`)

export const proxyPromptID = (tenant: Tenant, requestID: string) =>
  SessionMessage.ID.make(`msg_${contentDigest(`proxy:${tenant.id}:${requestID}`).slice(0, 40)}`)

/** The collector only reads durable activity/input/message projections; SessionV2.prompt owns
 * admission and advisory wake. It never resumes, waits on, or replays provider execution. */
export const collectEnhanced = (input: {
  db: Database.Interface["db"]
  sessions: SessionV2.Interface
  tenant: Tenant
  sessionID: SessionV2.ID
  requestID: string
  request: ChatPayload
  providerID: string
  modelID: string
}) =>
  Effect.gen(function* () {
    const hint = input.sessionID
    const session = yield* input.sessions.create({
      id: input.sessionID,
      title: `Proxy ${input.tenant.id}`,
      metadata: { proxy: { tenant: input.tenant.id, keyFingerprint: input.tenant.key_fingerprint, lane: hint } },
      location: Location.Ref.make({ directory: AbsolutePath.make(input.tenant.directory) }),
      model: { id: ModelV2.ID.make(input.modelID), providerID: ProviderV2.ID.make(input.providerID) },
      permissions: input.tenant.tier === "context" ? [{ action: "*", resource: "*", effect: "deny" }] : [],
    })
    const binding = session.metadata?.proxy
    if (
      !binding || typeof binding !== "object" ||
      (binding as Record<string, unknown>).tenant !== input.tenant.id ||
      (binding as Record<string, unknown>).keyFingerprint !== input.tenant.key_fingerprint ||
      (binding as Record<string, unknown>).lane !== hint ||
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

    const deadline = Date.now() + input.tenant.deadline_ms
    while (Date.now() < deadline) {
      const activity = yield* input.db.select().from(SessionActivityTable)
        .where(and(eq(SessionActivityTable.session_id, input.sessionID), eq(SessionActivityTable.trigger_input_id, admitted.value.id)))
        .get()
      if (!activity) {
        yield* Effect.sleep("50 millis")
        continue
      }
      if (activity.state === "failed" || activity.state === "interrupted")
        return { ok: false as const, status: 502, code: "enhancement_failed", message: "Enhanced execution failed" }
      if (activity.state !== "settled") {
        yield* Effect.sleep("50 millis")
        continue
      }
      const trigger = yield* input.db.select({ promoted_seq: SessionInputTable.promoted_seq }).from(SessionInputTable)
        .where(eq(SessionInputTable.id, admitted.value.id)).get()
      if (trigger?.promoted_seq === null || trigger?.promoted_seq === undefined)
        return { ok: false as const, status: 502, code: "enhancement_projection_missing", message: "Enhanced response projection is missing" }
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
      if (!terminal) return { ok: false as const, status: 502, code: "enhancement_projection_missing", message: "Enhanced response projection is missing" }
      const message = yield* input.sessions.message({ sessionID: input.sessionID, messageID: terminal.id })
      if (message?.type !== "assistant" || message.error)
        return { ok: false as const, status: 502, code: "enhancement_failed", message: "Enhanced execution failed" }
      const usage = message.tokens ? Usage.from({
        inputTokens: message.tokens.input,
        outputTokens: message.tokens.output,
        reasoningTokens: message.tokens.reasoning,
        cacheReadInputTokens: message.tokens.cache.read,
        cacheWriteInputTokens: message.tokens.cache.write,
        totalTokens: message.tokens.input + message.tokens.output,
      }) : undefined
      return {
        ok: true as const,
        text: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        finishReason: message.finish ?? "stop",
        usage,
        firstTokenAt: terminal.time_created,
      }
    }
    return { ok: false as const, status: 504, code: "enhancement_timeout", message: "Enhanced response timed out" }
  })
