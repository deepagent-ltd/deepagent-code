export * as IMTaskResultFixture from "./task-result"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { IMTaskAuthorityFixture } from "../../../../core/test/fixture/im-task-authority"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { IMReplyOutbox } from "../../../src/im/im-reply-outbox"

export const instanceID = "local_11111111111111111111111111111111"
export const reply = "The original task completed. No additional work was requested."

/** Real file-backed business stores and existing admission/outbox producers. The controlled
 * Authority and terminal rows are a store oracle, not signed Native/provider execution evidence. */
export const prepare = Effect.fn("IMTaskResultFixture.prepare")(function* (
  options: { directory?: string; outcome?: "succeeded" | "failed"; instanceID?: string; sharedRoot?: boolean } = {},
) {
  yield* IMTaskAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  const directory = options.directory ?? "/tmp/im-task-result/project"
  const identity = options.instanceID ?? instanceID
  const time = Date.now() - 172_800_000
  const principal = { ...IMTaskAuthorityFixture.principal, instanceID: identity }
  const proof = {
    ...IMTaskAuthorityFixture.proof,
    instanceID: identity,
    origin: "local" as const,
    realmID: null,
    appkeyID: null,
    orgID: null,
    senderID: "server",
    receiverID: "server",
    conversationType: "local" as const,
    conversationID: "img_source_group",
    kernelMessageID: null,
    intentID: null,
    expiresAt: time + 3_600_000,
  }
  const target = {
    ...IMTaskAuthorityFixture.target,
    scope: { ...IMTaskAuthorityFixture.target.scope, workspaceID: directory },
    location: { directory },
    ...(options.sharedRoot ? {
      version: 2 as const,
      profile: { id: "project_shared_root_v1" as const, version: 1 as const, hash: WorkAuthorityPolicy.SHARED_ROOT_PROFILE_HASH },
      budget: { ...IMTaskAuthorityFixture.target.budget, maxChildren: 2, maxProviderDispatches: 4, maxToolCalls: 2 },
      projectScope: { projectID: "project-result", locationKey: "task-location", namespaceBindingHash: proof.namespaceBindingHash,
        canonicalRoot: directory, helperHash: "a".repeat(64), rootIdentity: { kind: "posix" as const, device: "1", inode: "2" } },
      contextPolicy: { kind: "scoped_project_history_v1" as const, instructionsRevision: 1 as const,
        history: "same_work_activity" as const, graphs: [], references: [], files: "approved_tool_results_only" as const },
      toolPolicy: { kind: "scoped_project_tools_v1" as const,
        capabilities: [{ toolID: "task", definitionHash: "b".repeat(64), operations: ["delegate" as const] }],
        fileScope: { read: [], write: [], deny: [], maxReadBytes: 0, maxPageBytes: 1, maxHashBytes: 1, maxWriteBytes: 0,
          symlinks: "deny" as const }, commandScope: [], integrations: [] },
      childPolicy: { kind: "shared_root_v1" as const, maxConcurrent: 2, agents: ["explore"], toolIDs: [],
        budget: { ...IMTaskAuthorityFixture.target.budget, maxTotalTokens: 4000, maxChildren: 0, maxProviderDispatches: 1, maxToolCalls: 0 } },
    } : {}),
  }
  yield* db.run(sql`UPDATE test_task_operator SET principal=${JSON.stringify(principal)}`)
  yield* db.run(sql`UPDATE test_task_source_proof SET proof=${JSON.stringify(proof)}`)
  yield* db.run(sql`UPDATE test_task_target SET target_hash=${Hash.sha256(CanonicalJson.stringify(target))}`)
  yield* db.run(sql`UPDATE context_location_identity SET canonical_root=${directory}`)
  yield* db.run(sql`UPDATE im_groups SET workspace_id=${directory},project_id=NULL,kernel_conv_id=NULL`)
  yield* db.run(sql`INSERT INTO im_members(group_id,member_id,member_type,role,joined_at)
    VALUES ('img_source_group','server','user','owner',${time})`)
  yield* db.run("UPDATE im_messages SET sender_id='server',kernel_msg_id=NULL")
  yield* db.run("DELETE FROM im_mention_intent")
  const request = yield* IMTaskAuthority.propose(db, { ...IMTaskAuthorityFixture.proposal, target, now: time }).pipe(
    Effect.provide(IMTaskAuthorityFixture.authority),
  )
  const grant = yield* IMTaskAuthority.accept(db, {
    requestID: request.request_id,
    operationID: "accept-result-once",
    expectedRevision: request.revision,
    now: time,
  }).pipe(Effect.provide(IMTaskAuthorityFixture.authority))
  yield* db.run(sql`INSERT INTO test_work_source VALUES (${grant.grant_id},1,${grant.record_hash},1)`)
  yield* WorkAuthority.reserve(db, { binding: grant.binding, now: time }).pipe(
    Effect.provide(WorkAuthorityFixture.verifier),
  )
  yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated)
    VALUES ('project-result',${directory},'[]',${time},${time})`)
  yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,agent,model,time_created,time_updated)
    VALUES (${grant.session_id},'project-result','original-result',${directory},'Original task','2',1,${target.agentID},
      ${JSON.stringify({ id: target.provider.modelID, providerID: target.provider.providerID })},${time},${time})`)
  yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* tx.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
      VALUES (${grant.input_id},${grant.session_id},${JSON.stringify({ text: request.audited_text })},'queue',1,1,${time})`)
          yield* WorkAuthority.bindInputInTransaction(tx, {
            workID: grant.work_id,
            inputID: grant.input_id,
            sessionID: grant.session_id,
            promptHash: grant.binding.auditedText.hash,
            admittedSeq: 1,
            expectedRevision: 1,
            now: time,
          })
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.provide(WorkAuthorityFixture.verifier))
  yield* db.run("UPDATE context_project_scope_identity SET observed_project_id='project-result'")
  yield* db.run("UPDATE context_location_identity SET observed_project_id='project-result'")
  const outcome = options.outcome ?? "succeeded"
  const finalID = "msg_result_final"
  const text = outcome === "succeeded" ? reply : "任务执行已结束，结果为失败；没有可交付的成功回复。"
  yield* db.run(sql`UPDATE work_execution SET outcome=${outcome}`)
  yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at,final_message_id)
    VALUES ('activity-result',${grant.session_id},1,${grant.input_id},'queue',${outcome === "succeeded" ? "settled" : "failed"},
      ${time},${time + 1},${outcome === "succeeded" ? finalID : null})`)
  if (outcome === "succeeded")
    yield* db.run(sql`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
    VALUES (${finalID},${grant.session_id},'assistant',2,${time},${time},${JSON.stringify({
      agent: target.agentID,
      model: { id: target.provider.modelID, providerID: target.provider.providerID },
      content: [{ type: "text", id: "part-result", text: reply }],
      time: { created: time, completed: time + 1 },
      finish: "stop",
    })})`)
  yield* IMReplyOutbox.appendReply(db, {
    id: grant.result_key,
    sessionID: grant.session_id,
    groupID: "img_source_group",
    agentID: target.agentID,
    triggerMessageID: request.source_id ? "imsg_source_one" : undefined,
    replyMessageID: outcome === "succeeded" ? finalID : grant.result_key,
    replyText: text,
    now: time + 1,
  })
  const item = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "fixture-delivery", now: time + 2 })
  if (!item) throw new Error("Actual outbox did not yield the original result")
  const repo = yield* IMRepository.pipe(
    Effect.provide(IMRepositoryLive),
    Effect.provideService(Database.Service, { db }),
  )
  const messageID = `imsg_reply_${contentDigest(grant.result_key).slice(0, 40)}`
  yield* repo.createMessage({
    id: messageID,
    groupID: "img_source_group",
    senderID: target.agentID,
    senderType: "agent",
    type: "text",
    content: text,
    metadata: {
      type: "agent_run",
      sessionID: grant.session_id,
      status: outcome === "succeeded" ? "success" : "failed",
    },
  })
  yield* IMReplyOutbox.markDelivered(db, { item, ownerToken: "fixture-delivery", now: time + 3 })
  return {
    messageID,
    groupID: "img_source_group",
    instanceID: identity,
    context: { workspaceID: directory, directory, userID: "server" },
    requestID: request.request_id,
    grantID: grant.grant_id,
    workID: grant.work_id,
    sessionID: grant.session_id,
    inputID: grant.input_id,
    outcome,
    expiresAt: grant.expires_at,
  }
})
