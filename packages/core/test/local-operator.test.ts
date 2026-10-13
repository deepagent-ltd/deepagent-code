import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { IMTaskAuthority } from "../src/im/task-authority"
import { LocalOperator } from "../src/im/local-operator"
import { LocalTaskAuth } from "../src/im/local-task-auth"
import { LocalTaskPolicy } from "../src/im/local-task-policy"
import { LocalOrigin } from "../src/im/local-origin"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { ReplyDeliveryID } from "../src/im/reply-delivery-id"
import { ReplyBodyRetirement } from "../src/im/reply-body-retirement"
import { IMTaskAuthorityFixture } from "./fixture/im-task-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"

const runtime = { instanceID: "local-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const policy = {
  version: 1 as const,
  targets: [
    {
      id: "review-target",
      locationKey: "task-location",
      namespaceBindingHash: IMTaskAuthorityFixture.proof.namespaceBindingHash,
      target: {
        ...IMTaskAuthorityFixture.target,
        scope: {
          ...IMTaskAuthorityFixture.target.scope,
          workspaceID: IMTaskAuthorityFixture.target.location.directory,
        },
      },
    },
  ],
}
const passwordVerifier = await Bun.password.hash("isolated-test-password", {
  algorithm: "argon2id",
  memoryCost: 4096,
  timeCost: 2,
})
const enrollment = {
  operationID: "enroll-one",
  operatorID: IMTaskAuthorityFixture.principal.actorID,
  username: "test-operator",
  credentialVerifier: passwordVerifier,
  policy,
}
function code<A, E>(value: Exit.Exit<A, E>) {
  if (Exit.isSuccess(value)) return "success"
  const error = Cause.squash(value.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository>, binding = runtime) {
  const database = WorkAuthorityFixture.database(filename)
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(LocalTaskAuth.layer),
      Effect.provideService(LocalOperator.Runtime, binding),
      Effect.provide(Layer.provideMerge(IMRepositoryLive, database)),
      Effect.scoped,
    ),
  )
}
async function isolated(body: (filename: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "local-operator-"))
  try {
    const filename = join(root, "operator.sqlite")
    await run(filename, IMTaskAuthorityFixture.initialize())
    await body(filename)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* LocalOperator.enroll(db, enrollment)
  const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const repo = yield* IMRepository
  const group = yield* repo.createGroup({
    workspaceID: policy.targets[0].target.location.directory,
    type: "project",
    name: "review",
    createdBy: "server",
  })
  return { db, repo, group, witness: LocalOperator.mutationWitness(operator) }
})
const zeroExecution = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  expect(
    yield* db.all(
      "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers",
    ),
  ).toEqual([{ sessions: 0, inputs: 0, work: 0, providers: 0 }])
})

test("enrollment exact retry and config/key checks survive file reopening", () =>
  isolated(async (filename) => {
    const receipt = await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const first = yield* LocalOperator.enroll(db, enrollment)
        expect(yield* LocalOperator.enroll(db, enrollment)).toEqual(first)
        expect(code(yield* LocalOperator.enroll(db, { ...enrollment, username: "changed" }).pipe(Effect.exit))).toBe(
          "LOCAL_OPERATOR_CONFLICT",
        )
        expect(code(yield* db.transaction((tx) => LocalOperator.requireMutation(tx)).pipe(Effect.exit))).toBe(
          "LOCAL_OPERATOR_AUTH_REQUIRED",
        )
        yield* zeroExecution
        return first
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const current = yield* (yield* Database.Service).db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(current.operator_id).toBe(receipt.operatorID)
        expect(current.revision).toBe(1)
      }),
    )
    expect(
      code(
        await run(
          filename,
          Effect.gen(function* () {
            return yield* (yield* Database.Service).db
              .transaction((tx) => LocalOperator.requireCurrent(tx))
              .pipe(Effect.exit)
          }),
          { ...runtime, credentialBinding: "3".repeat(64) },
        ),
      ),
    ).toBe("LOCAL_OPERATOR_CONFIG_MISMATCH")
    expect(
      code(
        await run(
          filename,
          Effect.gen(function* () {
            return yield* (yield* Database.Service).db
              .transaction((tx) => LocalOperator.requireCurrent(tx))
              .pipe(Effect.exit)
          }),
          { ...runtime, installationKeyHash: "4".repeat(64) },
        ),
      ),
    ).toBe("LOCAL_OPERATOR_INSTALLATION_MISMATCH")
  }))

test("task-mode preserves plain chat; only witnessed new text obtains a source receipt", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const env = yield* setup
        yield* LocalTaskPolicy.enable(env.db, {
          operationID: "enable",
          expectedRevision: 0,
          groupID: env.group.id,
          targetID: "review-target",
        }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const ordinary = {
          groupID: env.group.id,
          senderID: "server",
          senderType: "user" as const,
          type: "text" as const,
          content: "@auto review",
          clientRequestID: "plain-one",
        }
        const plain = yield* env.repo.createMessage(ordinary)
        yield* env.repo.createMessage(ordinary).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        expect(yield* env.db.all("SELECT count(*) count FROM im_local_origin_receipt")).toEqual([{ count: 0 }])
        expect(code(yield* env.db.transaction((tx) => LocalOrigin.verify(tx, plain.id)).pipe(Effect.exit))).toBe(
          "LOCAL_TASK_SOURCE_UNAVAILABLE",
        )
        const fresh = yield* env.repo
          .createMessage({ ...ordinary, clientRequestID: "fresh-one" })
          .pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const proof = yield* env.db.transaction((tx) => LocalOrigin.verify(tx, fresh.id))
        expect(proof.origin).toBe("local")
        expect(proof.senderID).toBe("server")
        expect(proof.expiresAt - fresh.createdAt).toBe(86_400_000)
        const request = yield* IMTaskAuthority.propose(env.db, {
          clientRequestID: "review",
          messageID: fresh.id,
          auditedText: fresh.content,
          target: policy.targets[0].target,
        }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        expect(request.state).toBe("proposed")
        expect(request.actor_id).toBe(enrollment.operatorID)
        expect(
          yield* env.db.all(sql`SELECT count(*) count FROM im_mention_intent WHERE message_id=${fresh.id}`),
        ).toEqual([{ count: 0 }])
        expect(yield* env.db.all("SELECT count(*) count FROM im_task_grant")).toEqual([{ count: 0 }])
        yield* zeroExecution
      }),
    )
  }))

test("stale witness rolls back both message and origin inside their transaction", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const env = yield* setup
        yield* LocalTaskPolicy.enable(env.db, {
          operationID: "enable",
          expectedRevision: 0,
          groupID: env.group.id,
          targetID: "review-target",
        }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const before = yield* env.db.all("SELECT count(*) count FROM im_messages")
        const result = yield* env.repo
          .createMessage({
            groupID: env.group.id,
            senderID: "server",
            senderType: "user",
            type: "text",
            content: "must roll back",
          })
          .pipe(
            Effect.provideService(LocalOperator.Mutation, {
              ...env.witness,
              credentialGeneration: env.witness.credentialGeneration + 1,
            }),
            Effect.exit,
          )
        expect(code(result)).toBe("task_authority_unavailable")
        expect(yield* env.db.all("SELECT count(*) count FROM im_messages")).toEqual(before)
        expect(yield* env.db.all("SELECT count(*) count FROM im_local_origin_receipt")).toEqual([{ count: 0 }])
        yield* zeroExecution
      }),
    )
  }))

test("task-mode refuses legacy intents and cutover with pending or admitted legacy history", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const env = yield* setup
        const message = {
          groupID: env.group.id,
          senderID: "server",
          senderType: "user" as const,
          type: "text" as const,
          content: "@auto",
          mentionIntent: {
            names: ["auto"],
            directory: policy.targets[0].target.location.directory,
            workspaceID: env.group.workspaceID,
            userID: "server",
            origin: "local" as const,
          },
        }
        const old = yield* env.repo.createMessage(message)
        expect(
          code(
            yield* LocalTaskPolicy.enable(env.db, {
              operationID: "enable",
              expectedRevision: 0,
              groupID: env.group.id,
              targetID: "review-target",
            }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness), Effect.exit),
          ),
        ).toBe("LOCAL_TASK_LEGACY_UNSETTLED")
        yield* env.db.run(sql`UPDATE im_mention_intent SET status='admitted' WHERE message_id=${old.id}`)
        expect(
          code(
            yield* LocalTaskPolicy.enable(env.db, {
              operationID: "enable",
              expectedRevision: 0,
              groupID: env.group.id,
              targetID: "review-target",
            }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness), Effect.exit),
          ),
        ).toBe("LOCAL_TASK_LEGACY_UNSETTLED")
        const clean = yield* env.repo.createGroup({
          workspaceID: env.group.workspaceID,
          type: "project",
          name: "clean",
          createdBy: "server",
        })
        yield* LocalTaskPolicy.enable(env.db, {
          operationID: "enable-clean",
          expectedRevision: 0,
          groupID: clean.id,
          targetID: "review-target",
        }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        expect(code(yield* env.repo.createMessage({ ...message, groupID: clean.id }).pipe(Effect.exit))).toBe(
          "task_mode_requires_review",
        )
        expect(code(yield* env.repo.requireLegacyMention(clean.id).pipe(Effect.exit))).toBe("task_mode_requires_review")
        yield* zeroExecution
      }),
    )
  }))

test.each(["prepared", "dispatched", "unknown", "acknowledged", "local"] as const)(
  "historical admitted mention still blocks task-mode cutover after original %s reply transport reopens",
  (state) => isolated(async (filename) => {
    const original = await run(filename, Effect.scoped(Effect.gen(function* () {
      const env = yield* setup
      const id = "imo_original_reply"
      const messageID = ReplyDeliveryID.fromOutbox(id)
      yield* env.repo.addMember({ groupID: env.group.id, memberID: "build", memberType: "agent", role: "member" })
      const source = yield* env.repo.createMessage({ groupID: env.group.id, senderID: "server", senderType: "user",
        type: "text", content: "Historical accepted mention" })
      // Seed a historical settled mention, then let the original body ledger capture
      // its durable origin. These rows are history, not new task-mode execution.
      yield* env.db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated)
        VALUES('original-reply-project',${env.group.workspaceID},'[]',1,1)`)
      yield* env.db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,v2_authority)
        VALUES('ses_im_original_reply','original-reply-project','original-reply',${env.group.workspaceID},'Original reply','2',1,1,1)`)
      yield* env.db.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
        VALUES('msg_original_input','ses_im_original_reply','{"text":"Historical accepted mention"}','steer',1,1,1)`)
      yield* env.db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at,final_message_id)
        VALUES('original-reply-activity','ses_im_original_reply',1,'msg_original_input','steer','settled',1,1,'msg_original_final')`)
      yield* env.db.run(sql`INSERT INTO session_activity_input(activity_id,input_id,ordinal,admitted_seq,role,promoted_at)
        VALUES('original-reply-activity','msg_original_input',1,1,'trigger',1)`)
      yield* env.db.run(sql`INSERT INTO im_mention_intent(id,message_id,agent_name,directory,workspace_id,user_id,origin,session_id,input_id,status,created_at,updated_at)
        VALUES('imi_original_reply',${source.id},'build',${env.group.workspaceID},${env.group.workspaceID},'server','local',
          'ses_im_original_reply','msg_original_input','admitted',1,1)`)
      yield* env.db.transaction((tx) => Effect.gen(function* () {
        yield* tx.run(sql`INSERT INTO im_reply_outbox
          (id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,delivery_message_id,reply_text,status,attempts,
           available_at,time_created,time_updated,time_delivered)
          VALUES (${id},'ses_im_original_reply',${env.group.id},'build','msg_original_input','msg_original_final',${messageID},
            'original reply','delivered',1,0,1,1,1)`)
        yield* ReplyBodyRetirement.initialize(tx, id)
      }), { behavior: "immediate" })
      const transport = yield* Effect.acquireRelease(Effect.sync(() => KernelDelivery.runtime({
        realm: "http://127.0.0.1:9/", appkey: "quiescence", orgID: 1, senderID: "alice", credentialFingerprint: "a".repeat(64),
      })), (value) => Effect.sync(() => KernelDelivery.close(value)))
      if (state !== "local") yield* env.repo.bindKernelConversation({ groupID: env.group.id, kernelConvID: "k:1:bob" })
      const create = env.repo.createMessage({ id: messageID, groupID: env.group.id, senderID: "build",
        senderType: "agent", type: "text", content: "original reply", mentions: [],
        metadata: { type: "agent_run", sessionID: "ses_im_original_reply", status: "success" } })
      yield* state === "local" ? create : KernelDelivery.withCreation(transport, env.group.id, create)
      if (["dispatched", "unknown", "acknowledged"].includes(state)) {
        const dispatch = yield* KernelDelivery.withVerification(transport,
          { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
          env.repo.claimKernelDelivery(transport, messageID))
        expect(dispatch).toBeDefined()
        if (!dispatch) throw new Error("Original reply dispatch was not admitted")
        if (state === "unknown") yield* env.repo.uncertainKernelDelivery(transport, dispatch)
        if (state === "acknowledged") expect(yield* env.repo.acknowledgeKernelDelivery(transport, dispatch, "original-ack")).toBe(true)
      }
      const receipt = yield* env.db.get<{ state: string }>(sql`SELECT state FROM im_kernel_delivery WHERE message_id=${messageID}`)
      expect(receipt?.state).toBe(state === "local" ? undefined : state)
      // Detaching the remote conversation must not settle its original delivery.
      yield* env.repo.bindKernelConversation({ groupID: env.group.id, kernelConvID: null })
      return { groupID: env.group.id, session: yield* env.db.all("SELECT * FROM session"),
        inputs: yield* env.db.all("SELECT * FROM session_input"), activities: yield* env.db.all("SELECT * FROM session_activity") }
    })))
    await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      const before = yield* db.all("SELECT * FROM im_kernel_delivery")
      const replies = yield* db.all("SELECT * FROM im_reply_outbox")
      const result = yield* LocalTaskPolicy.enable(db, { operationID: "enable-after-detach", expectedRevision: 0,
        groupID: original.groupID, targetID: "review-target" }).pipe(
        Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)), Effect.exit)
      // Transport acknowledgement closes delivery only. The original admitted
      // legacy lane still needs a separately designed historical terminal mapping.
      expect(code(result)).toBe("LOCAL_TASK_LEGACY_UNSETTLED")
      expect(yield* db.all("SELECT * FROM im_kernel_delivery")).toEqual(before)
      expect(yield* db.all("SELECT * FROM im_reply_outbox")).toEqual(replies)
      expect(yield* LocalTaskPolicy.lookup(db, original.groupID)).toBeUndefined()
      expect(yield* db.all("SELECT * FROM session")).toEqual(original.session)
      expect(yield* db.all("SELECT * FROM session_input")).toEqual(original.inputs)
      expect(yield* db.all("SELECT * FROM session_activity")).toEqual(original.activities)
      expect(yield* db.get("SELECT (SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers"))
        .toEqual({ work: 0, providers: 0 })
    }))
  }), 15_000,
)

test("rotation/revoke fence old origin without erasing receipt history", () =>
  isolated(async (filename) => {
    const source = await run(
      filename,
      Effect.gen(function* () {
        const env = yield* setup
        yield* LocalTaskPolicy.enable(env.db, {
          operationID: "enable",
          expectedRevision: 0,
          groupID: env.group.id,
          targetID: "review-target",
        }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const message = yield* env.repo
          .createMessage({
            groupID: env.group.id,
            senderID: "server",
            senderType: "user",
            type: "text",
            content: "review",
          })
          .pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const before = yield* env.db.all("SELECT * FROM im_local_origin_receipt")
        const rotated = yield* LocalOperator.rotate(env.db, {
          operationID: "rotate",
          expectedRevision: 1,
          username: enrollment.username,
          credentialVerifier: passwordVerifier,
        }).pipe(
          Effect.provideService(LocalOperator.Runtime, { ...runtime, credentialBinding: "5".repeat(64) }),
          Effect.provideService(LocalOperator.Mutation, env.witness),
        )
        expect(rotated.revision).toBe(2)
        expect(rotated.credentialGeneration).toBe(2)
        expect(yield* env.db.all("SELECT * FROM im_local_origin_receipt")).toEqual(before)
        return message.id
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(code(yield* db.transaction((tx) => LocalOrigin.verify(tx, source)).pipe(Effect.exit))).toBe(
          "LOCAL_TASK_SOURCE_UNAVAILABLE",
        )
        const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const receipt = yield* LocalOperator.revoke(db, { operationID: "revoke", expectedRevision: 2 }).pipe(
          Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)),
        )
        expect(receipt.state).toBe("revoked")
        expect(receipt.revision).toBe(3)
        expect(yield* LocalOperator.revoke(db, { operationID: "revoke", expectedRevision: 2 })).toEqual(receipt)
        expect(code(yield* db.transaction((tx) => LocalOperator.requireCurrent(tx)).pipe(Effect.exit))).toBe(
          "LOCAL_OPERATOR_REVOKED",
        )
        yield* zeroExecution
      }),
      { ...runtime, credentialBinding: "5".repeat(64) },
    )
  }))

test("cross-connection cutover and legacy-message admission have exactly one winner", () =>
  isolated(async (filename) => {
    const prepared = await run(
      filename,
      Effect.gen(function* () {
        const env = yield* setup
        return { groupID: env.group.id, workspaceID: env.group.workspaceID, witness: env.witness }
      }),
    )
    const [enabled, legacy] = await Promise.all([
      run(
        filename,
        Effect.gen(function* () {
          return yield* LocalTaskPolicy.enable((yield* Database.Service).db, {
            operationID: "race-enable",
            groupID: prepared.groupID,
            targetID: "review-target",
            expectedRevision: 0,
          }).pipe(Effect.provideService(LocalOperator.Mutation, prepared.witness), Effect.exit)
        }),
      ),
      run(
        filename,
        Effect.gen(function* () {
          return yield* (yield* IMRepository)
            .createMessage({
              groupID: prepared.groupID,
              senderID: "server",
              senderType: "user",
              type: "text",
              content: "@auto race",
              mentionIntent: {
                names: ["auto"],
                directory: policy.targets[0].target.location.directory,
                workspaceID: prepared.workspaceID,
                userID: "server",
                origin: "local",
              },
            })
            .pipe(Effect.exit)
        }),
      ),
    ])
    expect(Number(Exit.isSuccess(enabled)) + Number(Exit.isSuccess(legacy))).toBe(1)
    expect([code(enabled), code(legacy)].sort()).toEqual(
      Exit.isSuccess(enabled)
        ? ["success", "task_mode_requires_review"].sort()
        : ["LOCAL_TASK_LEGACY_UNSETTLED", "success"].sort(),
    )
    await run(filename, zeroExecution)
  }))

test("source payload, current namespace and persisted policy cannot be silently changed", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const env = yield* setup
        yield* LocalTaskPolicy.enable(env.db, {
          operationID: "enable",
          expectedRevision: 0,
          groupID: env.group.id,
          targetID: "review-target",
        }).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const message = yield* env.repo
          .createMessage({
            groupID: env.group.id,
            senderID: "server",
            senderType: "user",
            type: "text",
            content: "immutable source",
          })
          .pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
        const request = {
          clientRequestID: "tamper-proposal",
          messageID: message.id,
          auditedText: message.content,
          target: policy.targets[0].target,
        }
        yield* env.db.run(sql`UPDATE im_messages SET content='changed' WHERE id=${message.id}`)
        expect(
          code(
            yield* IMTaskAuthority.propose(env.db, request).pipe(
              Effect.provideService(LocalOperator.Mutation, env.witness),
              Effect.exit,
            ),
          ),
        ).toBe("IM_TASK_SOURCE_UNAVAILABLE")
        yield* env.db.run(sql`UPDATE im_messages SET content=${message.content} WHERE id=${message.id}`)
        yield* env.db.run(
          sql`UPDATE context_security_namespace SET retired_at=1 WHERE id=${policy.targets[0].target.scope.securityNamespaceID}`,
        )
        expect(
          code(
            yield* IMTaskAuthority.propose(env.db, request).pipe(
              Effect.provideService(LocalOperator.Mutation, env.witness),
              Effect.exit,
            ),
          ),
        ).toBe("IM_TASK_FORBIDDEN")
        yield* env.db.run(
          sql`UPDATE context_security_namespace SET retired_at=NULL WHERE id=${policy.targets[0].target.scope.securityNamespaceID}`,
        )
        yield* env.db.run(
          sql`UPDATE im_local_task_conversation SET target_hash=${"0".repeat(64)} WHERE group_id=${env.group.id}`,
        )
        expect(
          code(
            yield* IMTaskAuthority.propose(env.db, request).pipe(
              Effect.provideService(LocalOperator.Mutation, env.witness),
              Effect.exit,
            ),
          ),
        ).toBe("IM_TASK_FORBIDDEN")
        expect(yield* env.db.all("SELECT count(*) count FROM im_task_request")).toEqual([{ count: 0 }])
        expect(yield* env.db.all("SELECT count(*) count FROM im_task_source")).toEqual([{ count: 0 }])
        yield* zeroExecution
      }),
    )
  }))

test("enrollment rejects tool allowance and task-mode command retry cannot impersonate a later revision", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const expanded = {
          ...policy,
          targets: [
            {
              ...policy.targets[0],
              target: { ...policy.targets[0].target, budget: { ...policy.targets[0].target.budget, maxToolCalls: 1 } },
            },
          ],
        }
        expect(code(yield* LocalOperator.enroll(db, { ...enrollment, policy: expanded }).pipe(Effect.exit))).toBe(
          "LOCAL_TASK_SCOPE_DENIED",
        )
        expect(yield* db.all("SELECT count(*) count FROM local_operator_authority")).toEqual([{ count: 0 }])
        const env = yield* setup
        const command = { operationID: "enable", expectedRevision: 0, groupID: env.group.id, targetID: "review-target" }
        const first = yield* LocalTaskPolicy.enable(db, command).pipe(
          Effect.provideService(LocalOperator.Mutation, env.witness),
        )
        expect(
          yield* LocalTaskPolicy.enable(db, command).pipe(Effect.provideService(LocalOperator.Mutation, env.witness)),
        ).toEqual(first)
        yield* LocalTaskPolicy.enable(db, { ...command, operationID: "revise", expectedRevision: 1 }).pipe(
          Effect.provideService(LocalOperator.Mutation, env.witness),
        )
        expect(
          code(
            yield* LocalTaskPolicy.enable(db, command).pipe(
              Effect.provideService(LocalOperator.Mutation, env.witness),
              Effect.exit,
            ),
          ),
        ).toBe("LOCAL_OPERATOR_REVISION_CONFLICT")
        yield* zeroExecution
      }),
    )
  }))
