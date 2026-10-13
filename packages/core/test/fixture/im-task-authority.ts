export * as IMTaskAuthorityFixture from "./im-task-authority"

import { sql } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../../src/database/database"
import { IMTaskAuthority } from "../../src/im/task-authority"
import { IMTaskAuthoritySchema } from "../../src/im/task-authority.schema"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"
import { WorkAuthorityFixture } from "./work-authority"

export const NOW = Date.now()
export const principal: IMTaskAuthoritySchema.Principal = {
  instanceID: "receiver-instance",
  actorID: "operator-real",
  revision: 1,
  identityHash: "a".repeat(64),
}
export const proof: IMTaskAuthoritySchema.SourceProof = {
  instanceID: principal.instanceID,
  securityNamespaceID: "task-namespace",
  namespaceBindingHash: "b".repeat(64),
  realmID: "kernel-realm",
  appkeyID: "appkey-public-id",
  orgID: "org-one",
  senderID: "sender-uuid",
  receiverID: "receiver-uuid",
  conversationType: "2",
  conversationID: "room-one",
  kernelMessageID: "kernel-message-one",
  intentID: "intent-source-one",
  origin: "kernel_live",
  revision: 1,
  generation: 1,
  expiresAt: NOW + 3_600_000,
  proofHash: "c".repeat(64),
}
export const target: IMTaskAuthoritySchema.Target = {
  scope: {
    actorID: principal.actorID,
    workspaceID: "receiving-project",
    securityNamespaceID: proof.securityNamespaceID,
    projectScopeKey: "task-project",
  },
  location: { directory: "/tmp/im-task-target" },
  agentID: "build",
  profile: WorkAuthorityFixture.binding().profile,
  provider: WorkAuthorityFixture.binding().provider,
  budget: WorkAuthorityFixture.binding().budget,
  durationMs: 60_000,
}
export const proposal = {
  clientRequestID: "review-one",
  messageID: "imsg_source_one",
  auditedText: WorkAuthorityFixture.TEXT,
  target,
  now: NOW,
}

const read = <A>(schema: Schema.Decoder<A>, text: string) => {
  const value = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text)
  return Option.isSome(value)
    ? Effect.succeed(value.value)
    : Effect.fail(
        new IMTaskAuthoritySchema.Error({
          code: "IM_TASK_AUTHORITY_UNAVAILABLE",
          message: "Fixture authority record invalid",
        }),
      )
}

// Controlled host boundary with actual durable proof rows. This is not an implementation of
// production login, kernel membership refresh or provider route validation.
export const authority = Layer.succeed(IMTaskAuthority.Authority, {
  authenticateMutation: (tx) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .all<{
          principal: string
          active: number
          authenticated: number
        }>("SELECT principal, active, authenticated FROM test_task_operator")
        .pipe(Effect.orDie)
      if (!rows[0]?.active || !rows[0].authenticated)
        return yield* new IMTaskAuthoritySchema.Error({
          code: "IM_TASK_FORBIDDEN",
          message: "An authenticated operator is required",
        })
      return yield* read(IMTaskAuthoritySchema.Principal, rows[0].principal)
    }),
  verifyOperator: (tx, input) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .all<{ principal: string; active: number }>("SELECT principal, active FROM test_task_operator")
        .pipe(Effect.orDie)
      if (!rows[0]?.active)
        return yield* new IMTaskAuthoritySchema.Error({ code: "IM_TASK_FORBIDDEN", message: "Operator is disabled" })
      const current = yield* read(IMTaskAuthoritySchema.Principal, rows[0].principal)
      if (current.actorID !== input.actorID || current.instanceID !== input.instanceID)
        return yield* new IMTaskAuthoritySchema.Error({
          code: "IM_TASK_NOT_VISIBLE",
          message: "Operator identity is unavailable",
        })
      return current
    }),
  verifySource: (tx, messageID) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .all<{
          proof: string
          active: number
        }>(sql`SELECT proof, active FROM test_task_source_proof WHERE message_id = ${messageID}`)
        .pipe(Effect.orDie)
      if (!rows[0]?.active)
        return yield* new IMTaskAuthoritySchema.Error({
          code: "IM_TASK_SOURCE_UNAVAILABLE",
          message: "Live source proof is unavailable",
        })
      return yield* read(IMTaskAuthoritySchema.SourceProof, rows[0].proof)
    }),
  authorizeTarget: (tx, _principal, input) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .all<{
          revision: number
          record_hash: string
          target_hash: string
          active: number
        }>("SELECT revision, record_hash, target_hash, active FROM test_task_target")
        .pipe(Effect.orDie)
      if (!rows[0]?.active || rows[0].target_hash !== Hash.sha256(CanonicalJson.stringify(input)))
        return yield* new IMTaskAuthoritySchema.Error({
          code: "IM_TASK_FORBIDDEN",
          message: "Reviewed target is not authorized",
        })
      return { revision: rows[0].revision, recordHash: rows[0].record_hash, targetHash: rows[0].target_hash }
    }),
})

export const initialize = Effect.fn("IMTaskAuthorityFixture.initialize")(function* () {
  yield* WorkAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  yield* db.run(
    "CREATE TABLE test_task_operator (principal text NOT NULL, active integer NOT NULL, authenticated integer NOT NULL)",
  )
  yield* db.run(sql`INSERT INTO test_task_operator VALUES (${JSON.stringify(principal)},1,1)`)
  yield* db.run(
    "CREATE TABLE test_task_source_proof (message_id text PRIMARY KEY, proof text NOT NULL, active integer NOT NULL)",
  )
  yield* db.run(sql`INSERT INTO test_task_source_proof VALUES ('imsg_source_one',${JSON.stringify(proof)},1)`)
  yield* db.run("CREATE TABLE test_task_target (revision integer, record_hash text, target_hash text, active integer)")
  yield* db.run(
    sql`INSERT INTO test_task_target VALUES (1,${"d".repeat(64)},${Hash.sha256(CanonicalJson.stringify(target))},1)`,
  )
  yield* db.run(
    sql`INSERT INTO context_security_namespace (id,kind,binding_hash,created_at) VALUES (${proof.securityNamespaceID},'implicit_local',${proof.namespaceBindingHash},${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO context_project_scope_identity (security_namespace_id,project_scope_key,project_kind,project_identity_hash,created_at) VALUES (${proof.securityNamespaceID},${target.scope.projectScopeKey},'registered_root','task-project-binding',${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO context_location_identity (security_namespace_id,location_key,project_scope_key,canonical_root,created_at) VALUES (${proof.securityNamespaceID},'task-location',${target.scope.projectScopeKey},${target.location.directory},${NOW})`,
  )
  // Membership and a created_by='server' row are intentionally insufficient without Authority.
  yield* db.run(
    sql`INSERT INTO im_groups (id,workspace_id,type,name,created_by,kernel_conv_id,created_at,updated_at) VALUES ('img_source_group','chat-workspace','project','source','server','k:2:room-one',${NOW},${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO im_members (group_id,member_id,member_type,role,joined_at) VALUES ('img_source_group',${proof.senderID},'user','owner',${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO im_members (group_id,member_id,member_type,role,joined_at) VALUES ('img_source_group',${proof.receiverID},'user','member',${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO im_messages (id,group_id,sender_id,sender_type,type,content,kernel_msg_id,created_at,updated_at) VALUES ('imsg_source_one','img_source_group',${proof.senderID},'user','text',${WorkAuthorityFixture.TEXT},${proof.kernelMessageID},${NOW},${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO im_mention_intent (id,message_id,agent_name,directory,workspace_id,user_id,origin,receiver_id,conversation_type,conversation_id,status,created_at,updated_at) VALUES ('intent-source-one','imsg_source_one','build','/tmp/im-task-target','chat-workspace',${proof.senderID},'kernel_live',${proof.receiverID},2,${proof.conversationID},'pending',${NOW},${NOW})`,
  )
})
