export * as IMDacSession from "./dac-session"

import { Effect, Option, Schema } from "effect"
import { and, desc, eq, or, sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Database } from "../database/database"
import { SessionV2 } from "../session"
import { SessionInputTable } from "../session/sql"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionActivityInputTable, SessionActivityTable } from "../context-federation/session-sql"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { IMDacSessionSchema } from "./dac-session.schema"
import { IMDacBindingTable, IMDacCommandTable } from "./dac-session.sql"
import { IMReplyOutboxTable } from "./reply-outbox.sql"
import { ReplyBodyRetirement } from "./reply-body-retirement"
import { ReplyBodyRetirementModel } from "./reply-body-retirement.model"

// Only the authenticated Host derives this scope from its current conversation
// reader and Location. Transport credential generations are not Session identity.
export interface Scope {
  readonly ownerID: string
  readonly accountKey: string
  readonly executorID: string
  readonly conversationKey: string
  readonly groupID: string
  readonly projectID: string
  readonly directory: string
  readonly workspaceID: string | null
  readonly model?: { readonly id: string; readonly providerID: string }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const identity = (scope: Scope) => digest([scope.ownerID, scope.accountKey, scope.executorID, scope.conversationKey, scope.groupID, scope.projectID, scope.directory, scope.workspaceID])
const placement = (scope: Scope) => ({ groupID: scope.groupID, projectID: scope.projectID, directory: scope.directory, workspaceID: scope.workspaceID })

export function make(db: Database.Interface["db"], sessions: SessionV2.Interface) {
  const binding = (scope: Scope) => db.select().from(IMDacBindingTable).where(eq(IMDacBindingTable.identity_key, identity(scope))).get().pipe(Effect.orDie)
  const command = (scope: Scope, commandID: string) => Effect.gen(function* () {
    const current = yield* binding(scope)
    if (!current) return yield* new IMDacSessionSchema.Error({ code: "command_not_found" })
    const row = yield* db.select().from(IMDacCommandTable).where(and(eq(IMDacCommandTable.binding_id, current.id), eq(IMDacCommandTable.command_id, commandID))).get().pipe(Effect.orDie)
    if (!row) return yield* new IMDacSessionSchema.Error({ code: "command_not_found" })
    const activity = yield* db.select({ id: SessionActivityTable.activity_id, final: SessionActivityTable.final_message_id, trigger: SessionActivityTable.trigger_input_id }).from(SessionActivityInputTable)
      .innerJoin(SessionActivityTable, eq(SessionActivityTable.activity_id, SessionActivityInputTable.activity_id))
      .where(and(eq(SessionActivityInputTable.input_id, row.input_id), eq(SessionActivityTable.session_id, row.session_id))).get().pipe(Effect.orDie)
    const replies = activity?.final ? yield* db.select({ id: IMReplyOutboxTable.id, status: IMReplyOutboxTable.status }).from(IMReplyOutboxTable)
      .where(and(eq(IMReplyOutboxTable.session_id, row.session_id), or(eq(IMReplyOutboxTable.reply_message_id, activity.final),
        sql`${IMReplyOutboxTable.reply_message_id} GLOB ${activity.final + "_impart_[0-9]*"}`))).all().pipe(Effect.orDie) : []
    // An attempt cap stops scheduling; it does not prove that nothing was sent.
    // Only original pre-creation custody makes a dead reply safe to retry.
    const uncertain = yield* Effect.forEach(replies.filter((reply) => reply.status === "dead"), (reply) =>
      ReplyBodyRetirement.read(db, reply.id).pipe(Effect.map((custody) =>
        custody.record.origin.kind !== "dac_session" || custody.record.bodyState !== "live" || Boolean(custody.record.message || custody.record.transport || custody.message || custody.receipt) ||
        custody.record.origin.basisHash !== ReplyBodyRetirementModel.hash(["dac_session", { activity_id: activity!.id, trigger_input_id: activity!.trigger, final_message_id: activity!.final, binding_id: current.id }])),
      Effect.catch(() => Effect.succeed(true))), { concurrency: 1 })
    const replyStatus = !replies.length ? null : replies.every((reply) => reply.status === "delivered") ? "delivered" as const
      : uncertain.some(Boolean) ? "unknown" as const : replies.some((reply) => reply.status === "dead") ? "dead" as const
      : replies.some((reply) => reply.status === "delivering") ? "delivering" as const : "pending" as const
    return { version: 1 as const, ...placement(scope), commandID: row.command_id, bindingID: row.binding_id, sessionID: row.session_id,
      inputID: row.input_id, delivery: row.delivery, state: row.state, activityID: activity?.id ?? null, finalMessageID: activity?.final ?? null, replyStatus }
  })

  const admit = (row: typeof IMDacCommandTable.$inferSelect, scope: Scope) => Effect.gen(function* () {
    if (row.state !== "pending") return
    const sessionID = SessionV2.ID.make(row.session_id)
    const existing = yield* sessions.get(sessionID).pipe(Effect.option)
    if (Option.isNone(existing)) {
      const earlier = yield* db.select({ id: IMDacCommandTable.id }).from(IMDacCommandTable)
        .where(and(eq(IMDacCommandTable.session_id, row.session_id), eq(IMDacCommandTable.state, "admitted"))).get().pipe(Effect.orDie)
      if (earlier) return yield* new IMDacSessionSchema.Error({ code: "binding_unavailable" })
      yield* sessions.create({ id: sessionID, title: "IM /dac", metadata: { imDac: { bindingID: row.binding_id, groupID: scope.groupID } },
        location: Location.Ref.make({ directory: AbsolutePath.make(scope.directory), ...(scope.workspaceID ? { workspaceID: WorkspaceV2.ID.make(scope.workspaceID) } : {}) }) })
    }
    const info = yield* sessions.requireWritable(sessionID)
    const metadata = Schema.decodeUnknownOption(Schema.Struct({ bindingID: Schema.String, groupID: Schema.String }))(info.metadata?.imDac)
    if (Option.isNone(metadata) || metadata.value.bindingID !== row.binding_id || metadata.value.groupID !== scope.groupID ||
      info.projectID !== scope.projectID || info.location.directory !== scope.directory || (info.location.workspaceID ?? null) !== scope.workspaceID)
      return yield* new IMDacSessionSchema.Error({ code: "binding_unavailable" })
    const prior = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make(row.input_id))).get().pipe(Effect.orDie)
    const referenceText = row.references.length ? `\n\nIM message references (quoted user material):\n${JSON.stringify(row.references)}` : ""
    yield* sessions.prompt({ id: SessionMessage.ID.make(row.input_id), sessionID, prompt: new Prompt({ text: row.text + referenceText, ...(row.model ? { model: row.model } : {}) }), delivery: row.delivery,
      // A crash after durable admission must not replay a provider turn or bypass
      // an ordinary Session Stop. Existing input reconciliation is admit-only.
      resume: !prior })
    yield* db.update(IMDacCommandTable).set({ state: "admitted", admitted_at: Date.now() }).where(and(eq(IMDacCommandTable.id, row.id), eq(IMDacCommandTable.state, "pending"))).run().pipe(Effect.orDie)
  })

  return {
    binding: (scope: Scope) => Effect.gen(function* () {
      const row = yield* binding(scope)
      const recent = row ? yield* db.select({ commandID: IMDacCommandTable.command_id }).from(IMDacCommandTable)
        .where(eq(IMDacCommandTable.binding_id, row.id)).orderBy(desc(IMDacCommandTable.created_at), desc(IMDacCommandTable.id)).limit(8).all().pipe(Effect.orDie) : []
      const recentCommands = yield* Effect.forEach(recent, (item) => command(scope, item.commandID), { concurrency: 1 })
      return { version: 1 as const, ...placement(scope), bindingID: row?.id ?? null, sessionID: row?.current_session_id ?? null, recentCommands }
    }),
    command,
    submit: (scope: Scope, input: IMDacSessionSchema.Submit, references: Effect.Effect<readonly { messageID: string; content: string }[], IMDacSessionSchema.Error>) => Effect.gen(function* () {
      const requestHash = digest([input.text, input.delivery, input.referenceMessageIDs ?? [], input.newSession ?? false])
      // Capture reference bytes outside SQL while the Host's current reader owns
      // the selected group; exact retries keep the original immutable snapshot.
      const old = yield* binding(scope)
      const prior = old ? yield* db.select().from(IMDacCommandTable).where(and(eq(IMDacCommandTable.binding_id, old.id), eq(IMDacCommandTable.command_id, input.commandID))).get().pipe(Effect.orDie) : undefined
      const captured = prior ? prior.references : yield* references
      const row = yield* db.transaction((tx) => Effect.gen(function* () {
        const key = identity(scope)
        const current = yield* tx.select().from(IMDacBindingTable).where(eq(IMDacBindingTable.identity_key, key)).get().pipe(Effect.orDie)
        const bindingID = current?.id ?? `imdb_${key}`
        const existing = yield* tx.select().from(IMDacCommandTable).where(and(eq(IMDacCommandTable.binding_id, bindingID), eq(IMDacCommandTable.command_id, input.commandID))).get().pipe(Effect.orDie)
        if (existing) {
          if (existing.request_hash !== requestHash) return yield* new IMDacSessionSchema.Error({ code: "command_conflict" })
          return existing
        }
        const generation = current ? current.generation + (input.newSession ? 1 : 0) : 1
        const sessionID = current && !input.newSession ? current.current_session_id : `ses_im_${digest([key, generation]).slice(0,40)}`
        const now = Date.now()
        if (!current) yield* tx.insert(IMDacBindingTable).values({ id: bindingID, identity_key: key, owner_id: scope.ownerID, account_key: scope.accountKey,
          executor_id: scope.executorID, conversation_key: scope.conversationKey, group_id: scope.groupID, project_id: scope.projectID, directory: scope.directory,
          workspace_id: scope.workspaceID, current_session_id: sessionID, generation, created_at: now, updated_at: now }).run().pipe(Effect.orDie)
        if (current && input.newSession) yield* tx.update(IMDacBindingTable).set({ current_session_id: sessionID, generation, updated_at: now }).where(eq(IMDacBindingTable.id, bindingID)).run().pipe(Effect.orDie)
        const value = { id: `imdc_${digest([key, input.commandID])}`, command_id: input.commandID, binding_id: bindingID, request_hash: requestHash, text: input.text,
          model: scope.model ? { ...scope.model } : null, reference_ids: input.referenceMessageIDs ?? [], references: captured, new_session: input.newSession ?? false, session_id: sessionID,
          input_id: `msg_${digest([key, input.commandID]).slice(0,40)}`, delivery: input.delivery, state: "pending" as const, created_at: now, admitted_at: null }
        yield* tx.insert(IMDacCommandTable).values(value).run().pipe(Effect.orDie)
        return value
      }), { behavior: "immediate" })
      yield* admit(row, scope).pipe(Effect.catch(() => db.update(IMDacCommandTable).set({ state: "rejected" })
        .where(and(eq(IMDacCommandTable.id, row.id), eq(IMDacCommandTable.state, "pending"))).run().pipe(Effect.orDie, Effect.asVoid)))
      return yield* command(scope, input.commandID)
    }),
    // An explicit owner action requeues only a known pre-send failure. Neither
    // admission nor model execution participates in delivery retry.
    retryReply: (scope: Scope, commandID: string) => Effect.gen(function* () {
      yield* db.transaction((tx) => Effect.gen(function* () {
        const current = yield* tx.select().from(IMDacBindingTable).where(eq(IMDacBindingTable.identity_key, identity(scope))).get()
        const row = current ? yield* tx.select().from(IMDacCommandTable).where(and(eq(IMDacCommandTable.binding_id, current.id), eq(IMDacCommandTable.command_id, commandID), eq(IMDacCommandTable.state, "admitted"))).get() : undefined
        if (!row) return yield* new IMDacSessionSchema.Error({ code: "command_not_found" })
        const activity = yield* tx.select({ activity: SessionActivityTable }).from(SessionActivityInputTable)
          .innerJoin(SessionActivityTable, eq(SessionActivityTable.activity_id, SessionActivityInputTable.activity_id))
          .where(and(eq(SessionActivityInputTable.input_id, row.input_id), eq(SessionActivityTable.session_id, row.session_id))).get()
        if (activity?.activity.state !== "settled" || !activity.activity.final_message_id)
          return yield* new IMDacSessionSchema.Error({ code: "reply_unavailable" })
        const final = activity.activity.final_message_id
        const replies = yield* tx.select().from(IMReplyOutboxTable).where(and(eq(IMReplyOutboxTable.session_id, row.session_id),
          eq(IMReplyOutboxTable.group_id, scope.groupID), or(eq(IMReplyOutboxTable.reply_message_id, final), sql`${IMReplyOutboxTable.reply_message_id} GLOB ${final + "_impart_[0-9]*"}`))).all()
        if (replies.length && replies.every((reply) => reply.status !== "dead")) return
        if (!replies.length || replies.some((reply) => reply.status !== "dead" || reply.body_state !== "live" || reply.lease_owner !== null || reply.lease_expires_at !== null))
          return yield* new IMDacSessionSchema.Error({ code: "reply_unavailable" })
        for (const reply of replies) {
          const custody = yield* ReplyBodyRetirement.read(tx, reply.id)
          if (custody.record.origin.kind !== "dac_session" || custody.record.bodyState !== "live" || custody.record.message || custody.record.transport || custody.message || custody.receipt ||
            custody.record.origin.basisHash !== ReplyBodyRetirementModel.hash(["dac_session", { activity_id: activity.activity.activity_id, trigger_input_id: activity.activity.trigger_input_id, final_message_id: final, binding_id: current!.id }]))
            return yield* new IMDacSessionSchema.Error({ code: "reply_unavailable" })
        }
        for (const reply of replies) {
          const updated = yield* tx.update(IMReplyOutboxTable).set({ status: "pending", attempts: 0, available_at: Date.now(), last_error: null, time_updated: Date.now() })
            .where(and(eq(IMReplyOutboxTable.id, reply.id), eq(IMReplyOutboxTable.status, "dead"), eq(IMReplyOutboxTable.attempts, reply.attempts), eq(IMReplyOutboxTable.time_updated, reply.time_updated))).returning().get()
          if (!updated) return yield* new IMDacSessionSchema.Error({ code: "reply_unavailable" })
          yield* ReplyBodyRetirement.refresh(tx, reply.id)
        }
      }), { behavior: "immediate" }).pipe(Effect.mapError(() => new IMDacSessionSchema.Error({ code: "reply_unavailable" })))
      return yield* command(scope, commandID)
    }),
    // Admission-only repair is bounded to records for a currently authenticated
    // scope. It never wakes already-admitted inputs or recovers active work.
    reconcile: (scope: Scope) => Effect.gen(function* () {
      const current = yield* binding(scope)
      if (!current) return
      const rows = yield* db.select().from(IMDacCommandTable).where(and(eq(IMDacCommandTable.binding_id, current.id), eq(IMDacCommandTable.state, "pending"))).limit(32).all().pipe(Effect.orDie)
      yield* Effect.forEach(rows, (row) => admit(row, scope).pipe(Effect.catch(() => db.update(IMDacCommandTable).set({ state: "rejected" })
        .where(and(eq(IMDacCommandTable.id, row.id), eq(IMDacCommandTable.state, "pending"))).run().pipe(Effect.orDie, Effect.asVoid))), { discard: true, concurrency: 1 })
    }),
  }
}
