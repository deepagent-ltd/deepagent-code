import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { IMTaskAuthorityFixture } from "../../../core/test/fixture/im-task-authority"
import { IMTaskResult } from "../../src/im/task-result"
import { IMTaskResultFixture } from "./fixture/task-result"

function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped))
}
async function isolated(
  body: (filename: string, original: Effect.Success<ReturnType<typeof IMTaskResultFixture.prepare>>) => Promise<void>,
  options: Parameters<typeof IMTaskResultFixture.prepare>[0] = {},
) {
  const root = await mkdtemp("/tmp/dac-im-task-result-")
  try {
    const filename = path.join(root, "result.sqlite")
    const original = await run(
      filename,
      IMTaskResultFixture.prepare({ directory: path.join(root, "project"), ...options }),
    )
    await body(filename, original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const scope = (original: Effect.Success<ReturnType<typeof IMTaskResultFixture.prepare>>) => ({
  ...original.context,
  instanceID: original.instanceID,
  messageID: original.messageID,
})
const read = (original: Effect.Success<ReturnType<typeof IMTaskResultFixture.prepare>>) =>
  Effect.gen(function* () {
    return yield* IMTaskResult.read((yield* Database.Service).db, scope(original))
  })
const snapshot = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const tables = yield* db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  return yield* Effect.forEach(tables, (table) =>
    db.all<Record<string, unknown>>(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).pipe(
      Effect.map((rows) => ({
        table: table.name,
        hashes: rows.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort(),
      })),
    ),
  )
})

test.each(["succeeded", "failed"] as const)(
  "delivered %s history resolves its actual placement after grant expiry with zero database changes",
  (outcome) =>
    isolated(
      async (filename, original) => {
        expect(original.expiresAt).toBeLessThan(Date.now())
        await run(
          filename,
          Effect.gen(function* () {
            const db = (yield* Database.Service).db
            yield* IMTaskAuthority.revoke(db, {
              grantID: original.grantID,
              operationID: "revoke-history-once",
              expectedRevision: 1,
            }).pipe(Effect.provide(IMTaskAuthorityFixture.authority))
            yield* db.run("UPDATE work_execution SET control_state='revoked',control_revision=2")
          }),
        )
        const before = await run(filename, snapshot)
        expect(await run(filename, read(original))).toEqual({
          version: 1,
          state: "available",
          messageID: original.messageID,
          groupID: original.groupID,
          placement: {
            instanceID: original.instanceID,
            securityNamespaceID: "task-namespace",
            projectID: "project-result",
            directory: original.context.directory,
            workspaceID: null,
            sessionID: original.sessionID,
          },
          attempt: {
            requestID: original.requestID,
            workID: original.workID,
            inputID: original.inputID,
            ordinal: 1,
            outcome,
          },
        })
        expect(await run(filename, snapshot)).toEqual(before)
      },
      { outcome },
    ),
)

test("user metadata and an agent-looking copied result cannot authorize a different message identity", () =>
  isolated(async (filename, original) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,metadata,created_at,updated_at)
        SELECT 'imsg_user_forged',group_id,'server','user',type,content,metadata,created_at,updated_at FROM im_messages WHERE id=${original.messageID}`)
        yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,metadata,created_at,updated_at)
        SELECT 'imsg_agent_forged',group_id,sender_id,'agent',type,content,metadata,created_at,updated_at FROM im_messages WHERE id=${original.messageID}`)
      }),
    )
    const before = await run(filename, snapshot)
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* IMTaskResult.read(db, { ...scope(original), messageID: "imsg_user_forged" })).toMatchObject({
          state: "unavailable",
          code: "not_task_result",
        })
        expect(yield* IMTaskResult.read(db, { ...scope(original), messageID: "imsg_agent_forged" })).toMatchObject({
          state: "unavailable",
          code: "result_changed",
        })
      }),
    )
    expect(await run(filename, snapshot)).toEqual(before)
  }))

test("membership removal and a different project with the same basename hide the result", () =>
  isolated(async (filename, original) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          yield* IMTaskResult.read(db, {
            ...scope(original),
            workspaceID: path.join("/another-root", path.basename(original.context.directory)),
            directory: path.join("/another-root", path.basename(original.context.directory)),
          }),
        ).toBeUndefined()
        expect(yield* IMTaskResult.read(db, { ...scope(original), userID: "another-actor" })).toBeUndefined()
        yield* db.run("DELETE FROM im_members WHERE member_id='server'")
      }),
    )
    const before = await run(filename, snapshot)
    expect(await run(filename, read(original))).toBeUndefined()
    expect(await run(filename, snapshot)).toEqual(before)
  }))

test.each([
  ["metadata deleted", "UPDATE im_messages SET metadata=NULL WHERE sender_type='agent'", "not_task_result"],
  [
    "metadata switched",
    `UPDATE im_messages SET metadata='{"type":"agent_run","sessionID":"ses_unrelated","url":"https://untrusted.example/"}' WHERE sender_type='agent'`,
    "not_task_result",
  ],
  ["source content", "UPDATE im_messages SET content='changed source' WHERE sender_type='user'", "result_changed"],
  ["result content", "UPDATE im_messages SET content='changed result' WHERE sender_type='agent'", "result_changed"],
  ["unknown work", "UPDATE work_execution SET outcome='unknown'", "result_changed"],
  ["source proof", "UPDATE im_task_source SET proof_hash='bad-proof'", "result_changed"],
  ["request hash", "UPDATE im_task_request SET request_hash='bad-request'", "result_changed"],
  ["grant hash", "UPDATE im_task_grant SET record_hash='bad-grant'", "result_changed"],
  ["placement", "UPDATE session SET directory='/other/project'", "placement_unavailable"],
  ["namespace retired", "UPDATE context_security_namespace SET retired_at=1", "placement_unavailable"],
  ["delivery unconfirmed", "UPDATE im_reply_outbox SET status='delivering',time_delivered=NULL", "result_changed"],
  ["kernel-bound group", "UPDATE im_groups SET kernel_conv_id='k:2:remote'", "remote_result_unlinked"],
] as const)("%s refuses a locator without any query mutation", (_name, mutation, code) =>
  isolated(async (filename, original) => {
    await run(
      filename,
      Effect.gen(function* () {
        yield* (yield* Database.Service).db.run(mutation)
      }),
    )
    const before = await run(filename, snapshot)
    expect(await run(filename, read(original))).toMatchObject({ state: "unavailable", code })
    expect(await run(filename, snapshot)).toEqual(before)
  }),
)

test("a different installed instance or mismatched actual Session workspace cannot be opened", () =>
  isolated(async (filename, original) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          yield* IMTaskResult.read(db, { ...scope(original), instanceID: "local_22222222222222222222222222222222" }),
        ).toMatchObject({ state: "unavailable", code: "placement_unavailable" })
        yield* db.run("UPDATE session SET workspace_id='different-workspace'")
      }),
    )
    const before = await run(filename, snapshot)
    expect(await run(filename, read(original))).toMatchObject({ state: "unavailable", code: "placement_unavailable" })
    expect(await run(filename, snapshot)).toEqual(before)
  }))

test("missing result storage is a typed unavailable error and never falls back to metadata", () =>
  isolated(async (filename, original) => {
    await run(
      filename,
      Effect.gen(function* () {
        yield* (yield* Database.Service).db.run("DROP TABLE im_reply_outbox")
      }),
    )
    const before = await run(filename, snapshot)
    const result = await run(filename, read(original).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(IMTaskResult.StorageError)
    expect(await run(filename, snapshot)).toEqual(before)
  }))


test("independently decoded shared-root object policies retain read-only historical identity and changed fields refuse", () =>
  isolated(async (filename, original) => {
    const before = await run(filename, snapshot)
    expect(await run(filename, read(original))).toMatchObject({ state: "available", attempt: { workID: original.workID } })
    expect(await run(filename, read(original))).toMatchObject({ state: "available", attempt: { workID: original.workID } })
    expect(await run(filename, snapshot)).toEqual(before)
    await run(filename, Effect.gen(function* () {
      yield* (yield* Database.Service).db.run("UPDATE im_task_request SET target=json_set(target,'$.childPolicy.maxConcurrent',1)")
    }))
    const changed = await run(filename, snapshot)
    expect(await run(filename, read(original))).toMatchObject({ state: "unavailable", code: "result_changed" })
    expect(await run(filename, snapshot)).toEqual(changed)
  }, { sharedRoot: true }),
)
