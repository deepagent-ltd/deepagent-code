import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMDacSession } from "@deepagent-code/core/im/dac-session"
import { IMDacCommandTable } from "@deepagent-code/core/im/dac-session.sql"
import { IMReplyOutboxTable } from "@deepagent-code/core/im/reply-outbox.sql"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { ReplyBodyRetirementModel } from "@deepagent-code/core/im/reply-body-retirement.model"
import { IMReplyOutbox } from "../../../src/im/im-reply-outbox"
import { openFixtureActivity, settleFixtureActivity } from "../../../../core/test/fixture/open-activity"

export type Marker = {
  cut: "admission" | "collector"
  scope: IMDacSession.Scope
  commandID: string
  bindingID: string
  sessionID: string
  inputID: string
  admittedSeq: number
  originalPromptResume: boolean
  warmWakeCalls: number
  DBIdentity: { dev: string; ino: string }
  activityID: string | null
  finalMessageID: string | null
  finalSHA256: string | null
  finalBytes: number | null
}

const root = await fs.realpath(process.argv[2])
const cut = process.argv[3]
const mode = process.argv[4]
assert(cut === "admission" || cut === "collector")
assert(mode === "warm" || mode === "cold")
const filename = path.join(root, "personal.sqlite")
const observations = { wakeCalls: 0, promptResumes: [] as boolean[] }
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const identity = async () => {
  const stat = await fs.stat(filename, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino) }
}
const database = Database.layerFromPath(filename)
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))
// Retain the existing no-provider fixture service; the original wake still executes.
const execution = Layer.effect(SessionExecution.Service, Effect.gen(function* () {
  const original = yield* SessionExecution.Service
  return SessionExecution.Service.of({ ...original, wake: (id, seq) => original.wake(id, seq).pipe(Effect.tap(() => Effect.sync(() => { observations.wakeCalls++ }))) })
})).pipe(Layer.provide(SessionExecution.noopLayer))
const sessions = SessionV2.layer.pipe(
  Layer.provide(execution), Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
  Layer.provide(events), Layer.provide(database), Layer.provide(projects), Layer.orDie,
)
const layer = Layer.mergeAll(database, events, projects, sessions, IMBroadcasterLive, IMRepositoryLive.pipe(Layer.provide(database)))
const result = await Effect.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const original = yield* SessionV2.Service
  if (mode === "warm") {
    const repo = yield* IMRepository
    const group = yield* repo.createGroup({ workspaceID: root, createdBy: "server", type: "project", name: "personal physical cut" })
    const project = yield* (yield* ProjectV2.Service).resolve(AbsolutePath.make(root))
    const scope = { ownerID: "server", accountKey: "private-cold-cut", executorID: "local", conversationKey: group.id,
      groupID: group.id, projectID: project.id, directory: root, workspaceID: null } satisfies IMDacSession.Scope
    const commandID = crypto.randomUUID()
    const observed = SessionV2.Service.of({ ...original, prompt: (input) => original.prompt(input).pipe(Effect.tap((admitted) => Effect.gen(function* () {
      observations.promptResumes.push(input.resume !== false)
      assert.equal(input.resume, true)
      assert.equal(observations.wakeCalls, 1)
      if (cut !== "admission") return
      const commands = yield* db.select().from(IMDacCommandTable).all().pipe(Effect.orDie)
      const inputs = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
      assert.equal(commands.length, 1)
      assert.equal(inputs.length, 1)
      assert.equal(commands[0]!.state, "pending")
      assert.equal(commands[0]!.admitted_at, null)
      assert.equal(inputs[0]!.promoted_seq, null)
      assert.equal(inputs[0]!.id, admitted.id)
      assert.equal(inputs[0]!.session_id, admitted.sessionID)
      const marker: Marker = { cut, scope, commandID, bindingID: commands[0]!.binding_id, sessionID: admitted.sessionID,
        inputID: admitted.id, admittedSeq: admitted.admittedSeq, originalPromptResume: input.resume, warmWakeCalls: observations.wakeCalls,
        DBIdentity: yield* Effect.promise(identity), activityID: null, finalMessageID: null, finalSHA256: null, finalBytes: null }
      yield* Effect.promise(() => fs.writeFile(path.join(root, "warm-marker-safe.json"), JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 }))
      // The parent physically kills this process before the caller command UPDATE.
      return yield* Effect.never
    }))) })
    const command = yield* IMDacSession.make(db, observed).submit(scope, { commandID, text: "private command is not an IM reply", delivery: "queue" }, Effect.succeed([]))
    assert.equal(cut, "collector")
    const assistantID = SessionMessage.ID.make(`msg_${crypto.randomUUID()}`)
    const publisher = yield* EventV2.Service
    yield* SessionInput.promoteNextQueued(db, publisher, SessionV2.ID.make(command.sessionID))
    const activity = yield* openFixtureActivity({ sessionId: SessionV2.ID.make(command.sessionID), triggerInputId: command.inputID,
      securityNamespaceId: SecurityNamespaceID.make("sec_im_personal_cold"), now: Date.now() })
    yield* publisher.publish(SessionEvent.Step.Started, { sessionID: SessionV2.ID.make(command.sessionID), timestamp: DateTime.makeUnsafe(Date.now()), assistantMessageID: assistantID,
      agent: "auto", model: { id: ModelV2.ID.make("deepseek-flash"), providerID: ProviderV2.ID.make("deepseek") } })
    yield* publisher.publish(SessionEvent.Text.Started, { sessionID: SessionV2.ID.make(command.sessionID), timestamp: DateTime.makeUnsafe(Date.now()), assistantMessageID: assistantID, textID: "final" })
    const final = "当前个人代理最终回答🙂，私有执行命令不回传。"
    yield* publisher.publish(SessionEvent.Text.Ended, { sessionID: SessionV2.ID.make(command.sessionID), timestamp: DateTime.makeUnsafe(Date.now()), assistantMessageID: assistantID, textID: "final", text: final })
    yield* publisher.publish(SessionEvent.Step.Ended, { sessionID: SessionV2.ID.make(command.sessionID), timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: assistantID, finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    const activityID = activity.activityId
    // Exercise the durable Activity lifecycle with synthetic output, without provider execution.
    yield* settleFixtureActivity({ activityId: activityID, finalMessageId: assistantID,
      securityNamespaceId: SecurityNamespaceID.make("sec_im_personal_cold"), now: Date.now() })
    assert.equal((yield* db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)).length, 0)
    const input = (yield* db.select().from(SessionInputTable).get().pipe(Effect.orDie))!
    const marker: Marker = { cut, scope, commandID, bindingID: command.bindingID, sessionID: command.sessionID, inputID: command.inputID,
      admittedSeq: input.admitted_seq, originalPromptResume: observations.promptResumes[0]!, warmWakeCalls: observations.wakeCalls,
      DBIdentity: yield* Effect.promise(identity), activityID, finalMessageID: assistantID, finalSHA256: hash(final), finalBytes: Buffer.byteLength(final) }
    yield* Effect.promise(() => fs.writeFile(path.join(root, "warm-marker-safe.json"), JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 }))
    return yield* Effect.never
  }
  const marker = (yield* Effect.promise(() => Bun.file(path.join(root, "warm-marker-safe.json")).json())) as Marker
  assert.equal(marker.cut, cut)
  assert.deepEqual(yield* Effect.promise(identity), marker.DBIdentity)
  const observed = SessionV2.Service.of({ ...original, prompt: (input) => original.prompt(input).pipe(Effect.tap(() => Effect.sync(() => { observations.promptResumes.push(input.resume !== false) }))) })
  const bridge = IMDacSession.make(db, observed)
  if (cut === "admission") {
    yield* bridge.reconcile(marker.scope)
    const command = yield* bridge.command(marker.scope, marker.commandID)
    assert.equal(command.state, "admitted")
    assert.equal(command.sessionID, marker.sessionID)
    assert.equal(command.inputID, marker.inputID)
    yield* bridge.reconcile(marker.scope)
    assert.deepEqual(observations.promptResumes, [false])
    assert.equal(observations.wakeCalls, 0)
    const inputs = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
    const commands = yield* db.select().from(IMDacCommandTable).all().pipe(Effect.orDie)
    const actualSessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
    assert.equal(inputs.length, 1); assert.equal(commands.length, 1); assert.equal(actualSessions.length, 1)
    assert.equal(inputs[0]!.id, marker.inputID); assert.equal(inputs[0]!.session_id, marker.sessionID)
    assert.equal(inputs[0]!.admitted_seq, marker.admittedSeq); assert.equal(inputs[0]!.promoted_seq, null)
    assert.equal((yield* db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)).length, 0)
    return { cut, sameDBIdentity: true, commandState: command.state, sessionID: command.sessionID, inputID: command.inputID,
      sessionCount: actualSessions.length, inputCount: inputs.length, commandCount: commands.length,
      promoted: false, promptResumes: observations.promptResumes, additionalWakeCalls: observations.wakeCalls, outboxCount: 0,
      qualification: "physical process crash after original SessionV2 admission; no-provider execution service controlled; no runner/provider recovery claim" }
  }
  assert.equal((yield* db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)).length, 0)
  const first = yield* IMReplyOutbox.collectSessionReply({ db, v2Session: original }, marker.sessionID)
  const second = yield* IMReplyOutbox.collectSessionReply({ db, v2Session: original }, marker.sessionID)
  assert.equal(first, true); assert.equal(second, false)
  const rows = yield* db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.session_id, marker.sessionID); assert.equal(row.trigger_message_id, marker.inputID)
  assert.equal(row.reply_message_id, marker.finalMessageID); assert.equal(row.group_id, marker.scope.groupID)
  assert.equal(hash(row.reply_text), marker.finalSHA256); assert.equal(Buffer.byteLength(row.reply_text), marker.finalBytes)
  assert(!row.reply_text.includes("private command")); assert.equal(row.attempts, 0); assert.equal(row.status, "pending")
  const custody = yield* ReplyBodyRetirement.read(db, row.id)
  assert.equal(custody.record.origin.kind, "dac_session")
  assert.equal(custody.record.origin.basisHash, ReplyBodyRetirementModel.hash(["dac_session", { activity_id: marker.activityID,
    trigger_input_id: marker.inputID, final_message_id: marker.finalMessageID, binding_id: marker.bindingID }]))
  assert.equal(custody.record.message, null); assert.equal(custody.record.transport, null)
  return { cut, sameDBIdentity: true, sessionID: marker.sessionID, inputID: marker.inputID, activityID: marker.activityID,
    finalMessageID: marker.finalMessageID, firstCollect: first, secondCollect: second, outboxCount: rows.length,
    replySHA256: hash(row.reply_text), replyBytes: Buffer.byteLength(row.reply_text), privateCommandExcluded: true,
    custodyKind: custody.record.origin.kind, custodyBindingExact: true, attempts: row.attempts, status: row.status,
    additionalWakeCalls: observations.wakeCalls, transportCreated: false,
    qualification: "physical process crash after actual Activity lifecycle settlement with synthetic output; original cold collector/custody only, not provider execution" }
}).pipe(Effect.provide(layer)))
await fs.writeFile(path.join(root, "cold-result-safe.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ fixture: "personal-dac-physical-cut", ...result }))
