import { expect, test } from "bun:test"
import { Effect } from "effect"
import { count } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { TaskContinuation } from "@deepagent-code/core/session/task-continuation"
import { TaskRunTable, SessionInputTable } from "@deepagent-code/core/session/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { testEffect } from "./lib/effect"

const record = {
  version: 1 as const, parentSessionID: "ses_parent", parentMessageID: "msg_parent", toolCallID: "call_parent",
  admissionID: "admission_parent", receiptID: "receipt_parent", providerAttemptID: "attempt_parent",
  ownerToken: "owner_parent", toolInputHash: "a".repeat(64), activityID: "activity_parent", activityOrdinal: 0,
  triggerInputID: "msg_trigger", inputSeq: 1, parentFingerprint: "b".repeat(64), expiresAt: 1,
}

test("continuation records reject unknown versions, excess fields and invalid authority counters", () => {
  expect(TaskContinuation.decode(record)).toEqual(record)
  expect(TaskContinuation.decode(undefined)).toBeUndefined()
  expect(TaskContinuation.decode({ ...record, version: 2 })).toBeUndefined()
  expect(TaskContinuation.decode({ ...record, unlimited: true })).toBeUndefined()
  expect(TaskContinuation.decode({ ...record, activityOrdinal: -1 })).toBeUndefined()
  expect(TaskContinuation.decode({ ...record, inputSeq: 1.5 })).toBeUndefined()
  expect(TaskContinuation.decode({ ...record, inputSeq: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined()
  expect(TaskContinuation.decode({ ...record, parentFingerprint: "self-authorized" })).toBeUndefined()
})

const it = testEffect(Database.layerFromPath(":memory:"))
it.effect("a copied record in prompt metadata cannot register a background wait or admit a parent input", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const result = yield* db.transaction((tx) => TaskContinuation.capture(tx, {
      parentSessionID: SessionSchema.ID.make("ses_parent"), parentMessageID: SessionMessage.ID.make("msg_parent"),
      toolCallID: "call_parent", deliveryMode: "background", agent: "explore",
      prompt: new Prompt({ text: "Copied authorization", metadata: { continuation: record } }),
      child: { title: "Unregistered task", location: { directory: AbsolutePath.make("/project") }, permissions: [] },
    }), { behavior: "immediate" })
    expect(result).toBeUndefined()
    expect((yield* db.select({ total: count() }).from(TaskRunTable).get())?.total).toBe(0)
    expect((yield* db.select({ total: count() }).from(SessionInputTable).get())?.total).toBe(0)
  }),
)
