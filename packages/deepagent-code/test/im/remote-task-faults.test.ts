import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"
import { IMRepositoryError } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskAuthorityFixture } from "../../../core/test/fixture/im-task-authority"
import { RemoteTaskFaultsFixture } from "./fixture/remote-task-faults"
import { IMReplyOutbox } from "../../src/im/im-reply-outbox"
import { ReplyDeliveryID } from "@deepagent-code/core/im/reply-delivery-id"
import { sql } from "drizzle-orm"

test("a real prepared Task result cannot claim kernel dispatch after the original grant is revoked", async () => {
  const root = await mkdtemp("/tmp/dac-remote-task-dispatch-fault-")
  console.info("REMOTE_TASK_FAULT_PRIVATE_ROOT", root)
  await Effect.runPromise(Effect.gen(function* () {
    const original = yield* RemoteTaskFaultsFixture.prepared
    expect((yield* KernelDelivery.read(original.db, original.message.id))?.state).toBe("prepared")
    const before = yield* original.snapshot()
    const revoked = yield* IMTaskAuthority.revoke(original.db, {
      grantID: original.grant.grant_id, operationID: "fault-revoke-before-dispatch", expectedRevision: 1,
    }).pipe(Effect.provide(IMTaskAuthorityFixture.authority))
    expect(revoked.state).toBe("revoked")
    const result = yield* original.claim().pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause)
      expect(error).toBeInstanceOf(IMRepositoryError)
      if (error instanceof IMRepositoryError) expect(Schema.is(KernelDeliverySchema.Error)(error.cause)).toBe(true)
    }
    expect((yield* KernelDelivery.read(original.db, original.message.id))?.state).toBe("prepared")
    expect(yield* original.snapshot()).toEqual(before)
  }).pipe(Effect.provide(RemoteTaskFaultsFixture.database(join(root, "authority.sqlite"))), Effect.scoped))
}, 20_000)

test("ordinary durable replies keep the original transport path without Task dispatch authority", async () => {
  const root = await mkdtemp("/tmp/dac-remote-task-dispatch-ordinary-")
  await Effect.runPromise(Effect.gen(function* () {
    const original = yield* RemoteTaskFaultsFixture.prepared
    const id = "imo_ordinary_original_result"
    yield* IMReplyOutbox.appendReply(original.db, { id, sessionID: "ses_im_ordinary", groupID: original.message.groupID,
      agentID: "build", replyMessageID: "msg_ordinary_final", replyText: "Ordinary reply", now: Date.now() })
    const message = yield* KernelDelivery.withCreation(original.runtime, original.message.groupID, original.repo.createMessage({
      id: ReplyDeliveryID.fromOutbox(id), groupID: original.message.groupID, senderID: "build", senderType: "agent",
      type: "text", content: "Ordinary reply", metadata: { type: "agent_run", sessionID: "ses_im_ordinary", status: "success" },
    }))
    const dispatch = yield* KernelDelivery.withResultDispatch(original.db, original.runtime, message.id,
      KernelDelivery.withVerification(original.runtime, { conversationType: 2, conversationID: "room-one", orgID: 1,
        memberIDs: [original.runtime.source.senderID] }, original.repo.claimKernelDelivery(original.runtime, message.id)))
    expect(dispatch?.binding.messageID).toBe(message.id)
    expect((yield* KernelDelivery.read(original.db, message.id))?.state).toBe("dispatched")
    expect((yield* KernelDelivery.resultOwner(original.db, dispatch!.binding))?.task).toBe(false)
  }).pipe(Effect.provide(RemoteTaskFaultsFixture.database(join(root, "authority.sqlite"))), Effect.scoped))
}, 20_000)

test.each(["missing_guard", "removed_outbox", "removed_grant", "changed_reply"] as const)(
  "reserved result identity %s cannot become an ordinary dispatch",
  async (fault) => {
    const root = await mkdtemp("/tmp/dac-remote-task-dispatch-identity-")
    await Effect.runPromise(Effect.gen(function* () {
      const original = yield* RemoteTaskFaultsFixture.prepared
      if (fault === "removed_outbox") yield* original.db.run(sql`DELETE FROM im_reply_outbox WHERE id=${original.grant.result_key}`)
      if (fault === "removed_grant") yield* original.db.run(sql`DELETE FROM im_task_grant WHERE grant_id=${original.grant.grant_id}`)
      if (fault === "changed_reply") yield* original.db.run(sql`UPDATE im_reply_outbox SET reply_text='different result' WHERE id=${original.grant.result_key}`)
      const before = yield* KernelDelivery.read(original.db, original.message.id)
      const result = yield* KernelDelivery.withResultDispatch(original.db, original.runtime, original.message.id,
        original.claim()).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Schema.is(KernelDeliverySchema.Error)(Cause.squash(result.cause))).toBe(true)
      expect(yield* KernelDelivery.read(original.db, original.message.id)).toEqual(before)
    }).pipe(Effect.provide(RemoteTaskFaultsFixture.database(join(root, "authority.sqlite"))), Effect.scoped))
  }, 20_000,
)
