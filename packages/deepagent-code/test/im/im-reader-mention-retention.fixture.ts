import { DateTime, Effect, Exit, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkSessionGuard } from "@deepagent-code/core/session/work-session-guard"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMMentionIntentTable } from "@deepagent-code/core/im/mention-intent.sql"
import { MessageTable } from "@deepagent-code/core/im/sql"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { IMReplyOutbox } from "@/im/im-reply-outbox"

const directory = process.env.IM_RETENTION_ROOT!
const stage = process.argv[2]
const database = Database.layerFromPath(`${directory}/retention.sqlite`)
const events = EventV2.layer.pipe(Layer.provide(database))
const session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(ProjectV2.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))),
  Layer.orDie,
)
const contexts = SessionContext.layer.pipe(
  Layer.provide(database),
  Layer.provide(ContextArtifactStore.layer({
    securityNamespaceId: SecurityNamespaceID.make("im-retention-fixture"),
    policy: "best_effort",
    keyId: "fixture-only",
    encryptionKey: new Uint8Array(32).fill(1),
    tokenCodec: ContextTokenCodec.make({ activeKeyId: "fixture-only", keys: [{ id: "fixture-only", secret: new Uint8Array(32).fill(2) }] }),
    limits: { maxItemBytes: 4096, maxSessionBytes: 8192, maxGlobalBytes: 16384, retentionMs: 60_000, tokenLifetimeMs: 120_000 },
  }).pipe(Layer.provide(database))),
)
const runtime = Layer.mergeAll(database, events, session, contexts, IMRepositoryLive.pipe(Layer.provide(database)))
const source = { realm: "http://127.0.0.1:9/", appkey: "retention-fixture", orgID: 1, senderID: "receiver", credentialFingerprint: "c".repeat(64) }
const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)

type Identity = { messageID: string; groupID: string; intentID: string; sessionID: string; inputID: string; expiresAt: number; activityID: string }

const reader = (db: Database.Interface["db"], observation?: { handle: object; value: KernelReaderSchema.LiveObservation }) => Effect.gen(function* () {
  // Controlled Core witness only. No SDK, provider, native bridge or network is started.
  const lease = KernelReader.attach({
    db, workspaceID: "retention-workspace", userID: "server", source,
    current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "Retention Sender" }),
    readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused-fixture-read")),
    ...(observation ? { liveObservation: (handle: object) => handle === observation.handle ? observation.value : undefined } : {}),
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(lease)))
  yield* KernelReader.bind(lease, scopeKey)
  yield* KernelReader.ensureScope(lease)
  return lease
})

const seed = (admit: boolean, historicalReplay: boolean) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const now = Date.now()
  const handle = Object.freeze({})
  const message = {
    effectKey: "d".repeat(64), messageId: "retention-native-message", sequence: "9007199254740993", deliveryCursor: "1",
    messageTime: now, expiresAt: now + 86_400_000, senderId: "sender", targetId: "sender", conversationType: 1 as const,
    content: '{"content":"@auto retention 迟到回复"}', isSend: false, isRead: false,
  }
  const lease = yield* reader(db, admit ? { handle, value: {
    scopeKey, projectionKey, projectionRevision: "1", sourceHash: KernelReader.hash(source), receiverID: "receiver", transportGeneration: 1,
    receivedAt: now, messageID: message.messageId, sequence: message.sequence, messageTime: now,
    senderID: message.senderId, conversationType: 1, conversationID: message.targetId, wireContent: message.content,
  } } : undefined)
  yield* KernelReader.applyChanges(lease, {
    version: 1, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
    items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "sender", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: message.messageId, latestSequence: message.sequence, latestMessageTime: now, nextExpiryAt: message.expiresAt }],
  })
  yield* KernelReader.applyMessages(lease, {
    version: 1, scopeKey, projectionKey, projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: now, items: [message],
  }, undefined, admit ? handle : undefined)
  const row = (yield* db.select().from(MessageTable).all().pipe(Effect.orDie))[0]!
  if (!admit) return { lease, expiresAt: message.expiresAt }
  // Current Host Reader does not synthesize legacy mentions. This uses the original
  // repository's retained kernel_live reconciliation entry to exercise admitted compatibility state.
  yield* repo.createMessage({
    id: row.id, groupID: row.group_id, senderID: row.sender_id, senderType: row.sender_type, type: row.type, content: row.content,
    metadata: row.metadata ?? undefined, createdAt: row.created_at,
    mentionIntent: { names: ["auto"], directory, workspaceID: "retention-workspace", userID: "server", origin: "kernel_live", receiverID: "receiver", conversationType: 1, conversationID: "sender" },
  })
  const intent = (yield* repo.listPendingMentions({ origin: "kernel_live", receiverID: "receiver" }))[0]!
  const refusal = yield* IMAgentExecution.admitMention(yield* SessionV2.Service, {
    groupID: row.group_id, messageID: row.id, agent: "auto", senderID: row.sender_id, content: row.content, directory,
  }).pipe(Effect.map(() => null), Effect.catchTag("WorkAuthority.Error", (error) => Effect.succeed(error.code)))
  if (refusal !== "WORK_AUTHORITY_MISSING") throw new Error("Original legacy admission did not preserve its Work authority refusal")
  const sessionID = IMAgentExecution.imSessionIDFor(row.group_id, "auto")
  const inputID = IMAgentExecution.imPromptIDFor(row.id, "auto")
  if (!historicalReplay) return { lease, expiresAt: message.expiresAt, admissionRefused: true,
    identity: { messageID: row.id, groupID: row.group_id, intentID: intent.id, sessionID, inputID, expiresAt: message.expiresAt, activityID: "" } }
  // Historical fixture replay only: the original durable admission publisher/projector rebuilds
  // an inbox row created before the Work guard. This never grants current legacy execution,
  // installs a profile, schedules a runner or bypasses the public SessionV2 admission refusal.
  yield* SessionInput.admit(db, yield* EventV2.Service, {
    id: inputID, sessionID, prompt: new Prompt({ text: `IM message from ${row.sender_id}: ${row.content}` }), delivery: "steer",
  })
  yield* repo.settleMention({ id: intent.id, status: "admitted" })
  yield* SessionInput.promoteSteers(db, yield* EventV2.Service, sessionID, Number.MAX_SAFE_INTEGER)
  const activity = yield* (yield* SessionContext.Service).openActivity({ sessionId: sessionID, triggerInputId: inputID })
  const identity: Identity = { messageID: row.id, groupID: row.group_id, intentID: intent.id, sessionID, inputID, expiresAt: message.expiresAt, activityID: activity.activityId }
  return { lease, expiresAt: message.expiresAt, identity, admissionRefused: true, historicalReplay: true }
})

const settle = (identity: Identity) => Effect.gen(function* () {
  const publisher = yield* EventV2.Service
  const sessionID = SessionV2.ID.make(identity.sessionID)
  const assistantMessageID = SessionMessage.ID.make("msg_retention_final")
  yield* publisher.publish(SessionEvent.Step.Started, {
    sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(1), agent: "auto",
    model: { id: ModelV2.ID.make("fixture-model"), providerID: ProviderV2.ID.make("fixture-provider") },
  })
  yield* publisher.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(2), textID: "retention-final-text" })
  yield* publisher.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(3), textID: "retention-final-text", text: "已准入任务的最终回复" })
  yield* publisher.publish(SessionEvent.Step.Ended, {
    sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(4), finish: "stop", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  yield* (yield* SessionContext.Service).settleActivity({ activityId: identity.activityID, state: "settled", finalMessageId: assistantMessageID })
})

const census = (db: Database.Interface["db"]) => db.get<{
  messages: number; intents: number; admitted: number; inputs: number; activities: number; settled: number; members: number;
  replies: number; pendingReplies: number; readerRecords: number; readerBytes: number;
  bodyBytes: number; ownsMessage: number; ledgerState: string; localMessage: string | null;
  obligationRecords: number; obligationBytes: number; contentBytes: number; tombstoneAt: number | null;
}>(sql`SELECT
  (SELECT count(*) FROM im_messages) messages, (SELECT count(*) FROM im_mention_intent) intents,
  (SELECT count(*) FROM im_mention_intent WHERE status='admitted') admitted,
  (SELECT count(*) FROM session_input) inputs, (SELECT count(*) FROM session_activity) activities,
  (SELECT count(*) FROM session_activity WHERE state='settled' AND final_message_id IS NOT NULL) settled,
  (SELECT count(*) FROM session_activity_input) members,
  (SELECT count(*) FROM im_reply_outbox) replies, (SELECT count(*) FROM im_reply_outbox WHERE status='pending') pendingReplies,
  (SELECT used_records FROM im_kernel_reader_meter WHERE id=1) readerRecords,
  (SELECT used_bytes FROM im_kernel_reader_meter WHERE id=1) readerBytes,
  (SELECT body_bytes FROM im_kernel_reader_message LIMIT 1) bodyBytes,
  (SELECT owns_message FROM im_kernel_reader_message LIMIT 1) ownsMessage,
  (SELECT storage_state FROM im_kernel_reader_message LIMIT 1) ledgerState,
  (SELECT local_message_id FROM im_kernel_reader_message LIMIT 1) localMessage,
  (SELECT obligation_records FROM im_kernel_reader_message LIMIT 1) obligationRecords,
  (SELECT obligation_bytes FROM im_kernel_reader_message LIMIT 1) obligationBytes,
  (SELECT coalesce(sum(length(CAST(content AS BLOB))),0) FROM im_messages) contentBytes,
  (SELECT deleted_at FROM im_messages LIMIT 1) tombstoneAt`)

const result = await Effect.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const foreignKeys = yield* db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
  if (foreignKeys?.foreign_keys !== 1) throw new Error("Original Database layer did not enable foreign keys")
  const collect = (identity: Identity) => Effect.gen(function* () {
    const v2Session = yield* SessionV2.Service
    const final = yield* v2Session.message({ sessionID: SessionV2.ID.make(identity.sessionID), messageID: SessionMessage.ID.make("msg_retention_final") })
    return {
      finalPresent: !!final && final.type === "assistant" && !final.error,
      metadataBound: IMAgentExecution.imSessionMetadata(yield* v2Session.get(SessionV2.ID.make(identity.sessionID)))?.groupID === identity.groupID,
      appended: yield* IMReplyOutbox.collectSessionReply({ db, v2Session }, identity.sessionID),
    }
  })
  const authority = (identity: Identity) => Effect.gen(function* () {
    const found = yield* WorkAuthority.lookupSession(db, identity.sessionID)
    const decision = yield* WorkSessionGuard.requireExecution(db, identity.sessionID).pipe(
      Effect.map(() => "allowed"), Effect.catchTag("WorkAuthority.Error", (error) => Effect.succeed(error.code)),
    )
    return { kind: found.kind, executionPreflightAllowed: decision === "allowed", denialCode: decision === "allowed" ? null : decision }
  })
  const meterExact = () => Effect.gen(function* () {
    const totals = yield* db.get<{ records: number; bytes: number; used_records: number; used_bytes: number }>(sql`SELECT
      1+(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_scope)+(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_projection)
        +(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_message)+(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_read_intent) records,
      1024+(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_scope)+(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_projection)
        +(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_message)+(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_read_intent) bytes,
      used_records,used_bytes FROM im_kernel_reader_meter WHERE id=1`)
    return !!totals && totals.records === totals.used_records && totals.bytes === totals.used_bytes
  })
  const custodySnapshot = () => Effect.gen(function* () {
    return JSON.stringify({
      messages: yield* db.all("SELECT * FROM im_messages ORDER BY id"), intents: yield* db.all("SELECT * FROM im_mention_intent ORDER BY id"),
      ledger: yield* db.all("SELECT * FROM im_kernel_reader_message ORDER BY effect_key"), meter: yield* db.all("SELECT * FROM im_kernel_reader_meter"),
      scope: yield* db.all("SELECT * FROM im_kernel_reader_scope ORDER BY reader_key"), members: yield* db.all("SELECT * FROM im_members ORDER BY member_id"),
    })
  })
  if (stage === "cold-collect") {
    const identity: Identity = yield* Effect.promise(() => Bun.file(`${directory}/identity.json`).json())
    const before = yield* census(db)
    const collection = yield* collect(identity)
    return { stage, foreignKeys: foreignKeys.foreign_keys, before, collection, authority: yield* authority(identity), after: yield* census(db), foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  const seeded = yield* seed(stage !== "history", !["refusal", "pending", "quota"].includes(stage))
  if (stage === "multi" || stage === "quota") {
    if (!seeded.identity) throw new Error("Original mention did not bind")
    const original = (yield* db.select().from(MessageTable).get())!
    yield* (yield* IMRepository).createMessage({
      id: original.id, groupID: original.group_id, senderID: original.sender_id, senderType: original.sender_type,
      type: original.type, content: original.content, metadata: original.metadata ?? undefined, createdAt: original.created_at,
      mentionIntent: { names: ["auto", "第二助手", "gamma"], directory, workspaceID: "retention-workspace", userID: "server", origin: "kernel_live", receiverID: "receiver", conversationType: 1, conversationID: "sender" },
    })
  }
  if (stage === "quota") {
    const repo = yield* IMRepository
    const unbound = (yield* repo.listPendingMentions({ origin: "kernel_live", receiverID: "receiver" })).find((intent) => intent.session_id === null)!
    yield* db.run(sql`UPDATE im_kernel_reader_meter SET used_bytes=${KernelReaderSchema.BYTE_LIMIT} WHERE id=1`)
    const original = yield* custodySnapshot()
    const bindRejected = Exit.isFailure(yield* Effect.exit(repo.bindMention({ id: unbound.id, agent: "测试助手", sessionID: "ses_retention_quota", inputID: "msg_retention_quota" })))
    const bindRollback = original === (yield* custodySnapshot())
    const settleRejected = Exit.isFailure(yield* Effect.exit(repo.settleMention({ id: unbound.id, status: "admitted", error: "不能半写的中文状态" })))
    const settleRollback = original === (yield* custodySnapshot())
    const admissionRejected = Exit.isFailure(yield* Effect.exit(IMAgentExecution.admitMention(yield* SessionV2.Service, {
      groupID: unbound.message.groupID, messageID: unbound.message_id, agent: unbound.agent_name,
      senderID: unbound.message.senderID, content: unbound.message.content, directory,
    })))
    const admissionRollback = original === (yield* custodySnapshot())
    const source = (yield* db.select().from(MessageTable).get())!
    const createRejected = Exit.isFailure(yield* Effect.exit(repo.createMessage({
      id: source.id, groupID: source.group_id, senderID: source.sender_id, senderType: source.sender_type, type: source.type,
      content: source.content, metadata: source.metadata ?? undefined, createdAt: source.created_at,
      mentionIntent: { names: ["第四助手"], directory, workspaceID: "retention-workspace", userID: "server", origin: "kernel_live", receiverID: "receiver", conversationType: 1, conversationID: "sender" },
    })))
    return { stage, foreignKeys: foreignKeys.foreign_keys, bindRejected, bindRollback, settleRejected, settleRollback, admissionRejected, admissionRollback, createRejected,
      createRollback: original === (yield* custodySnapshot()), foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  const before = yield* census(db)
  if (stage === "refusal") return { stage, foreignKeys: foreignKeys.foreign_keys, admissionRefused: seeded.admissionRefused, before, foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  const sourceIdentity = yield* db.get<{ metadata: string; immutable_hash: string }>(sql`SELECT metadata,immutable_hash FROM im_kernel_reader_message LIMIT 1`)
  if (stage === "history") {
    yield* KernelReader.cleanup(seeded.lease, seeded.expiresAt + 1)
    return { stage, foreignKeys: foreignKeys.foreign_keys, before, after: yield* census(db), foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  if (!seeded.identity) throw new Error("Original admission did not return identity")
  const beforeAuthority = yield* authority(seeded.identity)
  const intent = yield* db.select().from(IMMentionIntentTable).where(eq(IMMentionIntentTable.id, seeded.identity.intentID)).get().pipe(Effect.orDie)
  const admittedBinding = intent?.status === "admitted" && intent.session_id === seeded.identity.sessionID && intent.input_id === seeded.identity.inputID && intent.message_id === seeded.identity.messageID
  if (stage === "late-member" || stage === "late-scope") {
    const original = yield* custodySnapshot()
    const late = stage === "late-member" ? "DELETE FROM im_members WHERE member_id='server';"
      : "UPDATE im_kernel_reader_scope SET binding_hash='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';"
    yield* db.run(`CREATE TRIGGER retention_late_identity AFTER UPDATE OF content ON im_messages BEGIN ${late} END`)
    const cleanupRejected = Exit.isFailure(yield* Effect.exit(KernelReader.cleanup(seeded.lease, seeded.expiresAt + 1)))
    return { stage, foreignKeys: foreignKeys.foreign_keys, admittedBinding, cleanupRejected, completeRollback: original === (yield* custodySnapshot()),
      meterExact: yield* meterExact(), foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  if (stage === "multi") {
    const intents = yield* db.select().from(IMMentionIntentTable).all()
    const expectedObligationBytes = intents.reduce((sum, row) => sum + KernelReader.accounting(row), 0)
    yield* KernelReader.cleanup(seeded.lease, seeded.expiresAt + 1)
    const after = yield* census(db)
    const original = yield* custodySnapshot()
    yield* KernelReader.cleanup(seeded.lease, seeded.expiresAt + 2)
    const repeatUnchanged = original === (yield* custodySnapshot())
    const groupDeleteRejected = Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM im_groups WHERE id=${seeded.identity.groupID}`)))
    const scopeDeleteRejected = Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_reader_scope")))
    const messageDeleteRejected = Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM im_messages WHERE id=${seeded.identity.messageID}`)))
    const ftsAvailable = !!(yield* db.get("SELECT name FROM sqlite_master WHERE name='im_messages_fts'"))
    const ftsBodies = ftsAvailable ? (yield* db.get<{ count: number }>("SELECT count(*) count FROM im_messages_fts"))!.count : null
    return { stage, foreignKeys: foreignKeys.foreign_keys, admissionRefused: seeded.admissionRefused, historicalReplay: seeded.historicalReplay,
      before, after, expectedObligationBytes, actualIntentCount: intents.length, meterExact: yield* meterExact(), repeatUnchanged,
      groupDeleteRejected, scopeDeleteRejected, messageDeleteRejected, deleteAttemptsUnchanged: original === (yield* custodySnapshot()),
      ftsAvailable, ftsBodies, originalExpiryMatched: after?.tombstoneAt === seeded.expiresAt,
      foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  if (stage === "early") {
    yield* settle(seeded.identity)
    const first = yield* collect(seeded.identity)
    const duplicate = yield* collect(seeded.identity)
    yield* KernelReader.cleanup(seeded.lease, seeded.expiresAt + 1)
    const afterCleanup = yield* collect(seeded.identity)
    return { stage, foreignKeys: foreignKeys.foreign_keys, admissionRefused: seeded.admissionRefused, historicalReplay: seeded.historicalReplay, admittedBinding, before, beforeAuthority, first, duplicate, afterCleanup, afterAuthority: yield* authority(seeded.identity), after: yield* census(db), foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  if (stage === "cold-seed" || stage === "kill-seed") yield* settle(seeded.identity)
  yield* KernelReader.cleanup(seeded.lease, seeded.expiresAt + 1)
  const afterCleanup = yield* census(db)
  const preserved = yield* db.get<{ metadata: string; immutable_hash: string }>(sql`SELECT metadata,immutable_hash FROM im_kernel_reader_message LIMIT 1`)
  const sourceIdentityPreserved = sourceIdentity?.metadata === preserved?.metadata && sourceIdentity?.immutable_hash === preserved?.immutable_hash
  if (stage === "denial" || stage === "pending") return {
    stage, foreignKeys: foreignKeys.foreign_keys, admissionRefused: seeded.admissionRefused, historicalReplay: seeded.historicalReplay,
    admittedBinding, before, beforeAuthority, afterAuthority: yield* authority(seeded.identity), afterCleanup,
    sourceIdentityPreserved, foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length,
  }
  if (stage === "cold-seed" || stage === "kill-seed") {
    yield* Effect.promise(() => Bun.write(`${directory}/identity.json`, JSON.stringify(seeded.identity)))
    return { stage, foreignKeys: foreignKeys.foreign_keys, admissionRefused: seeded.admissionRefused, historicalReplay: seeded.historicalReplay, admittedBinding, before, beforeAuthority, afterAuthority: yield* authority(seeded.identity), afterCleanup, sourceIdentityPreserved, foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
  }
  if (stage !== "late") throw new Error("Unknown retention fixture stage")
  yield* settle(seeded.identity)
  return { stage, foreignKeys: foreignKeys.foreign_keys, admissionRefused: seeded.admissionRefused, historicalReplay: seeded.historicalReplay, admittedBinding, before, beforeAuthority, afterAuthority: yield* authority(seeded.identity), afterCleanup, sourceIdentityPreserved, collection: yield* collect(seeded.identity), after: yield* census(db), foreignKeyViolations: (yield* db.all(sql`PRAGMA foreign_key_check`)).length }
}).pipe(Effect.scoped, Effect.provide(runtime)))
console.log(JSON.stringify(result))
// The parent kills only this owned process after reading the committed result.
// Recovery tests intentionally cover post-commit crash, not an interrupted SQL TX.
if (stage === "kill-seed") {
  await Bun.write(`${directory}/kill-ready.json`, JSON.stringify(result))
  await Bun.sleep(60_000)
}
