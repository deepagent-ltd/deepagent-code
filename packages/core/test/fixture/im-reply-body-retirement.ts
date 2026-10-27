export * as ReplyBodyFixture from "./im-reply-body-retirement"
import { expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SecurityNamespaceID } from "../../src/context-federation/reference"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { IMDacSession } from "../../src/im/dac-session"
import { IMRepository } from "../../src/im/repository"
import { KernelDelivery } from "../../src/im/kernel-delivery"
import { KernelReader } from "../../src/im/kernel-reader"
import { ReplyBodyRetirement } from "../../src/im/reply-body-retirement"
import { ReplyBodyRetirementModel } from "../../src/im/reply-body-retirement.model"
import { ReplyDeliveryID } from "../../src/im/reply-delivery-id"
import { ModelV2 } from "../../src/model"
import { ProjectV2 } from "../../src/project"
import { ProviderV2 } from "../../src/provider"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { SessionEvent } from "../../src/session/event"
import { SessionExecution } from "../../src/session/execution"
import { SessionInput } from "../../src/session/input"
import { SessionMessage } from "../../src/session/message"
import { SessionProjector } from "../../src/session/projector"
import { SessionStore } from "../../src/session/store"
import { SessionV1 } from "../../src/v1/session"
import { openFixtureActivity, settleFixtureActivity } from "./open-activity"
import { projectLayer } from "./project-layer"
export const source = {
  realm: "http://127.0.0.1:9/",
  appkey: "reply-custody",
  orgID: 1,
  senderID: "alice",
  credentialFingerprint: "a".repeat(64),
}
export const scopeKey = "b".repeat(64)
export const reply = "ReplyCustodyCanary 中文🙂"
/** Admit and settle a private DAC command through the domain APIs. Execution is
 * explicitly noop: deterministic terminal events are fixture material, with no
 * provider, Native qualification, remote service or attachment started. */
export const make = (input?: {
  append?: boolean
  projection?: boolean
  bindingWorkspaceID?: string
  finalText?: string
}) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const workspaceID = input?.bindingWorkspaceID ?? "ws"
    const active = { value: true }
    const observations = new WeakMap<object, { serverNow: number; scopeKey: string; version: 2; deadline: number }>()
    const reader = KernelReader.attach({
      db,
      workspaceID,
      userID: "server",
      source,
      current: () => Effect.succeed(active.value),
      inspect: () => Effect.succeed({ name: "peer" }),
      readCut: () => Effect.die("Unused read"),
      retirementObservation: (handle) => {
        const value = observations.get(handle)
        observations.delete(handle)
        return value
      },
    })
    const authority = KernelDelivery.runtime(source)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        KernelReader.close(reader)
        KernelDelivery.close(authority)
      }),
    )
    yield* KernelReader.bind(reader, scopeKey, 2)
    yield* KernelReader.ensureScope(reader)
    if (input?.projection) {
      const now = Date.now()
      yield* KernelReader.applyChanges(reader, {
        version: 2,
        scopeKey,
        after: "0",
        upper: "1",
        scanCursor: "1",
        scanProjectionKey: "c".repeat(64),
        pageToken: "",
        windowComplete: true,
        caughtUp: true,
        serverNow: now,
        items: [
          {
            visibility: "visible",
            projectionKey: "c".repeat(64),
            revision: "1",
            cursor: "1",
            conversationType: 1,
            targetId: "bob",
            readOrdinal: "0",
            admittedOrdinal: "1",
            liveUnread: "1",
            storedUnread: "1",
            latestMessageId: "original",
            latestSequence: "1",
            latestMessageTime: now,
            nextExpiryAt: now + 259200000,
          },
        ],
      })
    }
    const existingGroup = input?.projection
      ? (yield* KernelReader.projection(reader, "c".repeat(64)))?.local_group_id
      : undefined
    const group = existingGroup
      ? yield* db.get<{ id: string; kernelConvID: string }>(
          sql`SELECT id,kernel_conv_id kernelConvID FROM im_groups WHERE id=${existingGroup}`,
        )
      : yield* repo.createGroup({
          workspaceID,
          type: "project",
          name: "Reply custody private",
          createdBy: "server",
        })
    if (!group) return yield* Effect.die("Original reader group absent")
    const command = yield* settledCommand(group.id, {
      bindingWorkspaceID: input?.bindingWorkspaceID,
      finalText: input?.finalText,
    })
    const now = Date.now()
    const id = "imo_reply_history"
    if (input?.append !== false)
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO im_reply_outbox(id,delivery_message_id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,reply_text,time_created,time_updated)
      VALUES(${id},${ReplyDeliveryID.fromOutbox(id)},${command.sessionID},${group.id},'auto',${command.inputID},'msg_reply_final',${reply},${now},${now})`)
            yield* ReplyBodyRetirement.initialize(tx, id)
          }),
        { behavior: "immediate" },
      )
    if (input?.append !== false)
      expect((yield* ReplyBodyRetirement.read(db, id)).record.origin.kind).toBe("dac_session")
    const create = (kernel = true) =>
      Effect.gen(function* () {
        if (kernel && !group.kernelConvID?.startsWith("kr1:"))
          yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
        const input = {
          id: ReplyDeliveryID.fromOutbox(id),
          groupID: group.id,
          senderID: "auto",
          senderType: "agent" as const,
          type: "text" as const,
          content: reply,
          mentions: [],
          metadata: { type: "agent_run" as const, sessionID: command.sessionID, status: "success" as const },
        }
        return yield* kernel
          ? KernelDelivery.withCreation(authority, group.id, repo.createMessage(input))
          : repo.createMessage(input)
      })
    const dispatch = (messageID: string) =>
      KernelDelivery.withVerification(
        authority,
        { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
        repo.claimKernelDelivery(authority, messageID),
      )
    const acknowledge = (messageID: string) =>
      Effect.gen(function* () {
        const value = yield* dispatch(messageID)
        if (!value) return yield* Effect.die("Original reply dispatch was not admitted")
        expect(yield* repo.acknowledgeKernelDelivery(authority, value, `kernel-${messageID}`)).toBe(true)
      })
    const delivered = () =>
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* ReplyBodyRetirement.read(tx, id)
            yield* tx.run(
              sql`UPDATE im_reply_outbox SET status='delivered',time_delivered=${Date.now()} WHERE id=${id}`,
            )
            yield* ReplyBodyRetirement.refresh(tx, id)
          }),
        { behavior: "immediate" },
      )
    const retire = (serverNow: number, purpose = KernelDelivery.retireSenderReplies()) =>
      Effect.gen(function* () {
        const handle = {}
        observations.set(handle, { serverNow, scopeKey, version: 2, deadline: performance.now() + 1000 })
        return yield* KernelDelivery.withSenderRetirement(reader, handle, purpose)
      })
    return {
      db,
      repo,
      id,
      group,
      create,
      dispatch,
      acknowledge,
      delivered,
      retire,
      active,
      reader,
      authority,
      sessionID: command.sessionID,
      inputID: command.inputID,
    }
  })

export const settledCommand = (
  groupID: string,
  input?: {
    directory?: string
    bindingWorkspaceID?: string
    finalText?: string
    scope?: Pick<IMDacSession.Scope, "accountKey" | "executorID" | "conversationKey">
  },
) =>
  Effect.gen(function* () {
    const database = Layer.succeed(Database.Service, yield* Database.Service)
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projects = projectLayer(database)
    const sessions = SessionV2.layer.pipe(
      Layer.provide(SessionExecution.noopLayer),
      Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
      Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
      Layer.provide(events),
      Layer.provide(database),
      Layer.provide(projects),
    )
    const directory =
      input?.directory ??
      (yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dac-reply-command-"))),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true })),
      ))
    return yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* (yield* ProjectV2.Service).resolve(AbsolutePath.make(directory))
      const command = yield* IMDacSession.make(db, yield* SessionV2.Service).submit(
        {
          ownerID: "server",
          accountKey: input?.scope?.accountKey ?? "reply-custody",
          executorID: input?.scope?.executorID ?? "auto",
          conversationKey: input?.scope?.conversationKey ?? "direct:bob",
          groupID,
          projectID: project.id,
          directory,
          workspaceID: input?.bindingWorkspaceID ?? null,
        },
        { commandID: "reply-custody", text: "Historical admitted input", delivery: "steer" },
        Effect.succeed([]),
      )
      expect(command.state).toBe("admitted")
      const admitted = yield* SessionInput.find(db, SessionMessage.ID.make(command.inputID))
      if (!admitted) return yield* Effect.die("The original DAC command was not admitted")
      expect(admitted.promotedSeq).toBeUndefined()
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make(command.sessionID)
      expect(yield* SessionInput.promoteSteers(db, events, sessionID, admitted.admittedSeq)).toEqual([admitted.id])
      const securityNamespaceId = SecurityNamespaceID.make("sec_reply_custody")
      const activity = yield* openFixtureActivity({
        sessionId: sessionID,
        triggerInputId: command.inputID,
        securityNamespaceId,
        now: Date.now(),
      })
      const assistantMessageID = SessionMessage.ID.make("msg_reply_final")
      const textID = SessionMessage.ID.make("msg_reply_text")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        agent: "build",
        model: { id: ModelV2.ID.make("fixture-model"), providerID: ProviderV2.ID.make("fixture-provider") },
      })
      const assistant = yield* (yield* SessionV2.Service).message({ sessionID, messageID: assistantMessageID })
      if (assistant?.type !== "assistant") return yield* Effect.die("The original assistant projection is absent")
      // With no provider receipt this fixture is host-owned. Publish its normal
      // compatibility parent through the existing API before projecting parts.
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: SessionV2.legacyAssistant({
          sessionID,
          parentMessageID: SessionV1.MessageID.ascending(command.inputID),
          directory,
          root: project.directory,
          message: assistant,
        }).info,
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        textID,
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        textID,
        text: input?.finalText ?? reply,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* settleFixtureActivity({
        activityId: activity.activityId,
        finalMessageId: assistantMessageID,
        securityNamespaceId,
        now: Date.now(),
      })
      return command
    }).pipe(Effect.provide(Layer.mergeAll(database, events, projects, sessions)))
  })

export const setup = make()

export const fullMeter = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const rows = yield* db.all<ReplyBodyRetirementModel.RawRow>(`SELECT * FROM im_reply_body`)
    const meter = yield* ReplyBodyRetirement.currentMeter(db)
    expect(meter.used_records).toBe(1 + rows.reduce((sum, row) => sum + Number(row.accounted_records), 0))
    for (const row of rows) {
      const o = yield* db.get<ReplyBodyRetirementModel.RawRow>(
        sql`SELECT * FROM im_reply_outbox WHERE id=${row.outbox_id}`,
      )
      const m = row.local_message_id
        ? yield* db.get<ReplyBodyRetirementModel.RawRow>(
            sql`SELECT * FROM im_messages WHERE id=${row.local_message_id}`,
          )
        : null
      const d = row.receipt_message_id
        ? yield* db.get<ReplyBodyRetirementModel.RawRow>(
            sql`SELECT * FROM im_kernel_delivery WHERE message_id=${row.receipt_message_id}`,
          )
        : null
      expect(row.accounted_bytes).toBe(
        ReplyBodyRetirementModel.accounting([row, o!, ...(m ? [m] : []), ...(d ? [d] : [])]),
      )
    }
    expect(meter.used_bytes).toBe(76 + rows.reduce((sum, row) => sum + Number(row.accounted_bytes), 0))
  })
