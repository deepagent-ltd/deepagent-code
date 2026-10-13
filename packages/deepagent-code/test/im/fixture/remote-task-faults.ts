export * as RemoteTaskFaultsFixture from "./remote-task-faults"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMTaskAuthorityFixture } from "../../../../core/test/fixture/im-task-authority"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { IMReplyOutbox } from "../../../src/im/im-reply-outbox"

/** Actual fileDB, original task producers, revoke and transport CAS. The authentication/source
 * boundary is the existing controlled Core fixture; no successful Work/Activity is fabricated,
 * and this module oracle is not Native membership/provider acceptance. */
export const prepared = Effect.gen(function* () {
  yield* IMTaskAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository.pipe(Effect.provide(IMRepositoryLive))
  const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
    .pipe(Effect.provide(IMTaskAuthorityFixture.authority))
  const grant = yield* IMTaskAuthority.accept(db, {
    requestID: request.request_id, operationID: "fault-accept", expectedRevision: request.revision,
  }).pipe(Effect.provide(IMTaskAuthorityFixture.authority))
  const text = "Prepared task result must retain its original disclosure authority."
  yield* IMReplyOutbox.appendReply(db, {
    id: grant.result_key, sessionID: grant.session_id, groupID: "img_source_group",
    agentID: grant.binding.agentID, triggerMessageID: IMTaskAuthorityFixture.proposal.messageID,
    replyMessageID: grant.result_key, replyText: text, now: Date.now(),
  })
  const runtime = KernelDelivery.runtime({ realm: "https://kernel.example.test/", appkey: "fixture",
    orgID: 1, senderID: IMTaskAuthorityFixture.proof.receiverID,
    credentialFingerprint: "e".repeat(64) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(runtime)))
  const message = yield* KernelDelivery.withCreation(runtime, "img_source_group", repo.createMessage({
    id: `imsg_reply_${contentDigest(grant.result_key).slice(0, 40)}`,
    groupID: "img_source_group", senderID: grant.binding.agentID, senderType: "agent", type: "text",
    content: text, mentions: [], metadata: { type: "agent_run", sessionID: grant.session_id, status: "failed" },
  }))
  const snapshot = () => db.all(sql`SELECT
    (SELECT count(*) FROM im_task_grant) grants,
    (SELECT count(*) FROM work_execution) work,
    (SELECT count(*) FROM session) sessions,
    (SELECT count(*) FROM session_input) inputs,
    (SELECT count(*) FROM session_provider_attempt) providers,
    (SELECT count(*) FROM work_count_acquisition) counts,
    (SELECT count(*) FROM work_dispatch_reservation) dispatches`)
  const claim = () => KernelDelivery.withVerification(runtime, {
    conversationType: 2, conversationID: "room-one", orgID: 1,
    memberIDs: [runtime.source.senderID, IMTaskAuthorityFixture.proof.senderID],
  }, repo.claimKernelDelivery(runtime, message.id))
  return { db, grant, message, runtime, repo, claim, snapshot }
})

export const database = (filename: string) => WorkAuthorityFixture.database(filename)
