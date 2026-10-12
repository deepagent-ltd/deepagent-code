import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionStore } from "@deepagent-code/core/session/store"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { ReplyDeliveryID } from "@deepagent-code/core/im/reply-delivery-id"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMTaskState } from "@/im/task-state"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { IMTaskAuthorityFixture } from "../../../core/test/fixture/im-task-authority"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"

/** Original Core issuer reserves the actual Task/Work under the existing
 * controlled durable authority fixture. The completed payload/ACK below is an
 * explicit historical storage specimen, not provider settlement, new dispatch
 * permission or native host acceptance. Current management reauthenticates via
 * the original Authority table; runtime status/restart/store are real layers. */
test("cold retired reply preserves current owned Task/Session management and rejects foreign operator or directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reply-retired-management-"))
  const filename = path.join(root, "database.sqlite")
  const database = WorkAuthorityFixture.database(filename)
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const execution = SessionExecution.noopLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(execution),
    Layer.provide(store),
    Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(ProjectV2.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))),
  )
  const restart = SessionRestart.layer.pipe(Layer.provide(Layer.mergeAll(database, store, execution)))
  const status = SessionRuntimeStatus.layer.pipe(Layer.provide(Layer.mergeAll(database, restart, execution)))
  const layers = Layer.mergeAll(
    database,
    store,
    execution,
    restart,
    status,
    sessions,
    IMTaskAuthorityFixture.authority,
    WorkAuthorityFixture.verifier,
  )
  try {
    const original = await Effect.runPromise(
      Effect.gen(function* () {
        yield* IMTaskAuthorityFixture.initialize()
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        const route = yield* WorkAuthority.Verifier
        const result = yield* IMTaskAuthority.acceptAndReserve(db, {
          requestID: request.request_id,
          operationID: "reply-management",
          expectedRevision: 1,
          now: IMTaskAuthorityFixture.NOW,
        }).pipe(
          Effect.provideService(WorkAuthority.Verifier, {
            authorizeSource: IMTaskAuthority.authorizeWorkSource,
            resolveRoute: route.resolveRoute,
          }),
        )
        const binding = result.work.binding
        const now = Date.now()
        yield* db.run(
          sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('task-reply-project',${binding.location.directory},'[]',${now},${now})`,
        )
        yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,agent,model,time_created,time_updated)
        VALUES(${binding.sessionID},'task-reply-project','task-reply',${binding.location.directory},'Historical result','2',1,${binding.agentID},${JSON.stringify({ id: binding.provider.modelID, providerID: binding.provider.providerID })},${now},${now})`)
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(
              sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,time_created) VALUES(${binding.inputID},${binding.sessionID},${JSON.stringify({ text: WorkAuthorityFixture.TEXT })},'queue',1,${now})`,
            )
            yield* WorkAuthority.bindInputInTransaction(tx, {
              workID: binding.workID,
              inputID: binding.inputID,
              sessionID: binding.sessionID,
              promptHash: binding.auditedText.hash,
              admittedSeq: 1,
              expectedRevision: 1,
              now: IMTaskAuthorityFixture.NOW,
            })
          }).pipe(
            Effect.provideService(WorkAuthority.Verifier, {
              authorizeSource: IMTaskAuthority.authorizeWorkSource,
              resolveRoute: route.resolveRoute,
            }),
          ),
        )
        // Historical closure, no provider attempt or completion permit is fabricated.
        yield* db.run(sql`UPDATE work_execution SET outcome='succeeded' WHERE work_id=${binding.workID}`)
        yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at,final_message_id)
        VALUES('task-reply-activity',${binding.sessionID},1,${binding.inputID},'queue','settled',${now},${now},'historical-task-final')`)
        const messageID = ReplyDeliveryID.fromOutbox(result.grant.result_key)
        const text = "Historical completed task communication"
        const metadata = { type: "agent_run", sessionID: binding.sessionID, status: "success" }
        const message = {
          id: messageID,
          group_id: "img_source_group",
          sender_id: binding.agentID,
          sender_type: "agent",
          type: "text",
          content: text,
          mentions: [],
          metadata,
          reply_to_id: null,
          created_at: now,
        }
        const source = {
          realm: "http://fixture.invalid/",
          appkey: "task-history",
          orgID: 1,
          senderID: "receiver-uuid",
          credentialFingerprint: "a".repeat(64),
        }
        const transport = {
          version: 1,
          messageID,
          groupID: message.group_id,
          workspaceID: "chat-workspace",
          source,
          conversationType: 2,
          conversationID: "room-one",
          messageHash: KernelDelivery.hash([
            message.id,
            message.group_id,
            message.sender_id,
            message.sender_type,
            message.type,
            message.content,
            message.mentions,
            message.metadata,
            message.reply_to_id,
            message.created_at,
          ]),
          wireID: `dac_${KernelDelivery.hash(["im-kernel-wire-v1", source, messageID])}`,
          textHash: KernelDelivery.hash(`[Agent·${binding.agentID}] ${text}`),
          createdAt: now,
          expiresAt: now + 259200000,
        }
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO im_reply_outbox(id,delivery_message_id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,reply_text,status,time_created,time_updated,time_delivered)
          VALUES(${result.grant.result_key},${messageID},${binding.sessionID},'img_source_group',${binding.agentID},'imsg_source_one','historical-task-final',${text},'delivered',${now},${now + 2},${now + 2})`)
            yield* tx.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,mentions,metadata,created_at,updated_at,kernel_msg_id)
          VALUES(${messageID},'img_source_group',${binding.agentID},'agent','text',${text},'[]',${JSON.stringify(metadata)},${now},${now},'historical-result-ack')`)
            yield* tx.run(sql`INSERT INTO im_kernel_delivery(message_id,binding,binding_hash,wire_id,state,dispatch_owner,kernel_message_id,created_at,dispatched_at,acknowledged_at,updated_at)
          VALUES(${messageID},${JSON.stringify(transport)},${KernelDelivery.hash(transport)},${transport.wireID},'acknowledged','historical-owner','historical-result-ack',${now},${now + 1},${now + 2},${now + 2})`)
            yield* ReplyBodyRetirement.initialize(tx, result.grant.result_key)
            expect(yield* ReplyBodyRetirement.retire(tx, result.grant.result_key, transport.expiresAt)).toBe(true)
          }),
        )
        expect((yield* db.get<{ count: number }>("SELECT count(*) count FROM session_provider_attempt"))?.count).toBe(0)
        return {
          requestID: request.request_id,
          sessionID: binding.sessionID,
          directory: binding.location.directory,
          outboxID: result.grant.result_key,
          messageID,
        }
      }).pipe(
        Effect.provide(Layer.mergeAll(database, IMTaskAuthorityFixture.authority, WorkAuthorityFixture.verifier)),
        Effect.scoped,
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const state = yield* IMTaskState.make
        const before = yield* ReplyBodyRetirement.read(db, original.outboxID)
        const current = yield* state.read({ requestID: original.requestID, directory: original.directory })
        expect(current.work?.sessionID).toBe(original.sessionID)
        expect(current.delivery).toMatchObject({ outboxStatus: "delivered", receiptState: "acknowledged" })
        expect((yield* ReplyBodyRetirement.read(db, original.outboxID)).body).toEqual(before.body)
        expect(before.record.origin.kind).toBe("work_result")
        const actual = yield* SessionV2.Service
        const calls = { final: 0 }
        const observed = {
          ...actual,
          message: (input: Parameters<typeof actual.message>[0]) => {
            calls.final++
            return actual.message(input)
          },
        }
        // A body-free exact historical no-op needs no installed execution profile
        // or fresh native source preparation. The original actual Session get is used.
        expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: observed }, original.sessionID)).toBe(false)
        expect(calls.final).toBe(0)
        expect((yield* ReplyBodyRetirement.read(db, original.outboxID)).body).toEqual(before.body)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(before.meter)
        expect(
          Exit.isFailure(yield* Effect.exit(state.read({ requestID: original.requestID, directory: "/foreign" }))),
        ).toBe(true)
        yield* db.run("UPDATE test_task_operator SET authenticated=0")
        expect(
          Exit.isFailure(
            yield* Effect.exit(state.read({ requestID: original.requestID, directory: original.directory })),
          ),
        ).toBe(true)
        expect(
          (yield* db.get<{ deleted_at: number }>(
            sql`SELECT deleted_at FROM im_messages WHERE id=${original.messageID}`,
          ))?.deleted_at,
        ).not.toBeNull()
      }).pipe(Effect.provide(layers), Effect.scoped),
    )
  } finally {
    await fs.rm(root, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
})
