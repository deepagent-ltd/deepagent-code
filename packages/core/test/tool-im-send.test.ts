import { beforeEach, describe, expect } from "bun:test"
import { count, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { WorkspaceConfigTable } from "@deepagent-code/core/deepagent/workspace-config-sql"
import { GroupID } from "@deepagent-code/core/im/id"
import { IMExternalDelivery } from "@deepagent-code/core/im/external-delivery"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { GroupTable, MemberTable, MessageTable } from "@deepagent-code/core/im/sql"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { IMSendTool } from "@deepagent-code/core/tool/im-send"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolIdentity } from "./lib/tool"

// P3-b (WS7/C4, design §8.2): im_send through the real ToolRegistry + a real in-memory DB — the
// IM-bound session delivers to its group as the bound agent (member leg), a non-member send falls
// back to the shared system-pusher identity, the §B2 rate limit blocks with an audit row, the §B2
// idempotency key replays the original outcome, quiet hours hold the message for the digest, and
// the fail-closed im_send permission ask gates every attempt.

const assertions: PermissionV2.AssertInput[] = []
let permissionMode: "allow" | "reject" = "allow"
const externalCalls: Array<{ target: IMExternalDelivery.Target; messageID: string; text: string }> = []
let externalFailure = false

const external = Layer.succeed(
  IMExternalDelivery.Service,
  IMExternalDelivery.Service.of({
    send: (input) =>
      Effect.suspend(() => {
        externalCalls.push(input)
        return externalFailure
          ? Effect.fail(new IMExternalDelivery.DeliveryFailed({ provider: "slack", reason: "request_failed" }))
          : Effect.void
      }),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.suspend(() => {
        assertions.push(input)
        return permissionMode === "reject" ? Effect.fail(new PermissionV2.RejectedError()) : Effect.void
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const registry = ToolRegistry.defaultLayer
const stack = Layer.mergeAll(
  Database.layerFromPath(":memory:"),
  registry,
  permission,
  IMSendTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(external)),
)

const it = testEffect(stack)

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    registry: yield* ToolRegistry.Service,
  }
})

const directory = AbsolutePath.make("/project")
const WORKSPACE = "wrk_im_send"
const GROUP = GroupID.make("img_ws7_group")

type Services = Effect.Success<typeof services>

const seedBase = (db: Services["db"], sessionID: SessionSchema.ID, metadata?: Record<string, unknown>) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: "im send",
        version: "test",
        ...(metadata !== undefined ? { metadata } : {}),
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(GroupTable)
      .values({
        id: GROUP,
        workspace_id: WORKSPACE,
        type: "project",
        name: "ws7",
        created_by: "user_1",
        created_at: 1,
        updated_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const seedMember = (db: Services["db"], memberID: string) =>
  db
    .insert(MemberTable)
    .values({ group_id: GROUP, member_id: memberID, member_type: "agent", role: "agent", joined_at: 1 })
    .run()
    .pipe(Effect.orDie)

const seedBinding = (db: Services["db"]) =>
  db
    .insert(WorkspaceConfigTable)
    .values({
      workspace_id: WORKSPACE,
      config: { externalChannels: [{ provider: "slack", groupID: GROUP, channelID: "C123" }] },
      created_at: 1,
      updated_at: 1,
    })
    .run()
    .pipe(Effect.orDie)

const call = (input: unknown, sessionID: SessionSchema.ID, id = "call-im_send-1") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "im_send", input },
})

type SendOutput = {
  decision: "deliver" | "digest" | "blocked"
  group_id: string
  sender_id: string
  message_id?: string
  reason?: string
  external_delivery?: "delivered" | "delivery_failed"
  output: string
}

const structured = (settlement: { output?: { structured: unknown } }): SendOutput =>
  settlement.output?.structured as SendOutput

const messageCount = (db: Services["db"]) =>
  db
    .select({ total: count() })
    .from(MessageTable)
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.total ?? 0),
    )

const pushLog = (db: Services["db"], idempotencyKey: string) =>
  db
    .select()
    .from(AgentPushLogTable)
    .where(eq(AgentPushLogTable.idempotency_key, idempotencyKey))
    .get()
    .pipe(Effect.orDie)

beforeEach(() => {
  assertions.length = 0
  permissionMode = "allow"
  externalCalls.length = 0
  externalFailure = false
})

describe("im_send (WS7)", () => {
  it.effect("delivers to the bound group as the session agent when it is a member", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_deliver")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")

      const settlement = yield* settleTool(registry, call({ text: "Deploy finished cleanly." }, sessionID))
      const out = structured(settlement)
      expect(out.decision).toBe("deliver")
      expect(out.group_id).toBe(GROUP)
      expect(out.sender_id).toBe("build")
      expect(out.message_id).toBeDefined()

      const message = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.group_id, GROUP))
        .get()
        .pipe(Effect.orDie)
      expect(message?.sender_id).toBe("build")
      expect(message?.sender_type).toBe("agent")
      expect(message?.content).toBe("Deploy finished cleanly.")

      const audit = yield* pushLog(db, `im_send:${sessionID}:${toolIdentity.assistantMessageID}:call-im_send-1`)
      expect(audit?.decision).toBe("deliver")
      expect(audit?.agent_id).toBe("build")
      expect(String(audit?.message_id)).toBe(out.message_id as string)
      expect(audit?.content).toBe("Deploy finished cleanly.")

      expect(assertions).toHaveLength(1)
      expect(assertions[0]).toMatchObject({ action: "im_send", resources: [GROUP] })
    }),
  )

  it.effect("fails typed for a non-IM session without an explicit group_id", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_unbound")
      yield* seedBase(db, sessionID)

      const result = yield* executeTool(registry, call({ text: "hello" }, sessionID))
      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(String(result.value)).toContain("not bound to an IM group")
      expect(String(result.value)).toContain("group_id is required")
      expect(assertions).toHaveLength(0)
      expect(yield* messageCount(db)).toBe(0)
    }),
  )

  it.effect("blocks rate_limited at 20 pushes in the window and audits the blocked attempt", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_limited")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)

      const now = Date.now()
      for (let i = 0; i < 20; i++)
        yield* db
          .insert(AgentPushLogTable)
          .values({
            id: `push_seed_${i}`,
            workspace_id: WORKSPACE,
            group_id: GROUP,
            agent_id: "build",
            reason: "seed",
            priority: "normal",
            decision: "deliver",
            idempotency_key: `seed-${sessionID}-${i}`,
            message_id: null,
            content: "seed",
            created_at: now,
          })
          .run()
          .pipe(Effect.orDie)

      const settlement = yield* settleTool(registry, call({ text: "one push too many" }, sessionID))
      const out = structured(settlement)
      expect(out.decision).toBe("blocked")
      expect(out.reason).toBe("rate_limited")
      expect(out.message_id).toBeUndefined()
      expect(out.output).toContain("rate_limited")

      expect(yield* messageCount(db)).toBe(0)
      const audit = yield* pushLog(db, `im_send:${sessionID}:${toolIdentity.assistantMessageID}:call-im_send-1`)
      expect(audit?.decision).toBe("blocked:rate_limited")
      expect(audit?.message_id).toBeNull()
      // Blocked attempts retain no content.
      expect(audit?.content).toBeNull()
      expect(assertions).toHaveLength(1)
      expect(externalCalls).toHaveLength(0)
    }),
  )

  it.effect("sends under the shared system-pusher identity when the session agent is not a member", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_pusher")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })

      const settlement = yield* settleTool(registry, call({ text: "Runtime status report." }, sessionID))
      const out = structured(settlement)
      expect(out.decision).toBe("deliver")
      expect(out.sender_id).toBe(IMSendTool.SYSTEM_PUSHER_AGENT_ID)
      expect(out.output).toContain("system-pusher identity")

      const message = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.group_id, GROUP))
        .get()
        .pipe(Effect.orDie)
      expect(message?.sender_id).toBe(IMSendTool.SYSTEM_PUSHER_AGENT_ID)
      const audit = yield* pushLog(db, `im_send:${sessionID}:${toolIdentity.assistantMessageID}:call-im_send-1`)
      expect(audit?.agent_id).toBe(IMSendTool.SYSTEM_PUSHER_AGENT_ID)
    }),
  )

  it.effect("replays the original outcome for a retried tool call instead of sending twice", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_replay")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)

      const first = structured(yield* settleTool(registry, call({ text: "exactly once" }, sessionID)))
      const second = structured(yield* settleTool(registry, call({ text: "exactly once" }, sessionID)))
      expect(first.decision).toBe("deliver")
      expect(second.decision).toBe("deliver")
      expect(second.message_id).toBe(first.message_id)
      expect(second.sender_id).toBe("build")
      expect(second.output).toContain("already ran")

      expect(yield* messageCount(db)).toBe(1)
      const audits = yield* db.select({ total: count() }).from(AgentPushLogTable).get().pipe(Effect.orDie)
      expect(audits?.total).toBe(1)
      expect(externalCalls).toHaveLength(1)
      expect(externalCalls[0]).toMatchObject({ target: { channelID: "C123" }, text: "exactly once" })
    }),
  )

  it.effect("reuses a call id in a later assistant turn without suppressing the new send", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_next_turn")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)

      const first = structured(yield* settleTool(registry, call({ text: "first turn" }, sessionID)))
      const next = structured(yield* settleTool(registry, {
        ...call({ text: "second turn" }, sessionID),
        assistantMessageID: SessionMessage.ID.make("msg_tool_test_next"),
      }))
      expect(next.message_id).not.toBe(first.message_id)
      expect(yield* messageCount(db)).toBe(2)
      expect(externalCalls.map((entry) => entry.text)).toEqual(["first turn", "second turn"])
    }),
  )

  it.effect("an exact retry replays its committed outcome after permission changes", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_permission_retry")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)

      const first = structured(yield* settleTool(registry, call({ text: "approved once" }, sessionID)))
      permissionMode = "reject"
      const replay = structured(yield* settleTool(registry, call({ text: "approved once" }, sessionID)))
      permissionMode = "allow"
      expect(replay.decision).toBe("deliver")
      expect(replay.message_id).toBe(first.message_id)
      expect(yield* messageCount(db)).toBe(1)
      expect(externalCalls).toHaveLength(1)
    }),
  )

  it.effect("holds the scrubbed message for the digest during workspace quiet hours", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_quiet")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")

      // A one-hour window covering the current UTC hour, so the send always lands in quiet hours.
      const hour = Math.floor(Date.now() / 3_600_000) % 24
      yield* db
        .insert(WorkspaceConfigTable)
        .values({
          workspace_id: WORKSPACE,
          config: {
            quietHours: { startHour: hour, endHour: (hour + 1) % 24, tzOffsetMinutes: 0 },
            externalChannels: [{ provider: "slack", groupID: GROUP, channelID: "C123" }],
          },
          created_at: 1,
          updated_at: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const settlement = yield* settleTool(registry, call({ text: "held until morning" }, sessionID))
      const out = structured(settlement)
      expect(out.decision).toBe("digest")
      expect(out.message_id).toBeUndefined()
      expect(out.output).toContain("quiet-hours digest")

      expect(yield* messageCount(db)).toBe(0)
      const audit = yield* pushLog(db, `im_send:${sessionID}:${toolIdentity.assistantMessageID}:call-im_send-1`)
      expect(audit?.decision).toBe("digest")
      expect(audit?.content).toBe("held until morning")
      expect(audit?.digest_flushed_at).toBeNull()
      expect(externalCalls).toHaveLength(0)
    }),
  )

  it.effect("keeps the durable message and writes a typed audit when Slack delivery fails", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_external_failure")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)
      externalFailure = true

      const first = structured(yield* settleTool(registry, call({ text: "safe update" }, sessionID)))
      const second = structured(yield* settleTool(registry, call({ text: "safe update" }, sessionID)))
      expect(first.decision).toBe("deliver")
      expect(first.external_delivery).toBe("delivery_failed")
      expect(second.message_id).toBe(first.message_id)
      expect(second.external_delivery).toBe("delivery_failed")
      expect(yield* messageCount(db)).toBe(1)
      expect(externalCalls).toHaveLength(1)
      const audit = yield* pushLog(db, `im_send_external:${sessionID}:${toolIdentity.assistantMessageID}:call-im_send-1`)
      expect(audit?.decision).toBe("delivery_failed")
      expect(String(audit?.message_id)).toBe(String(first.message_id))
      expect(audit?.content).toBeNull()
    }),
  )

  it.effect("sends only scrubbed content to the external channel", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_external_scrub")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)

      const secret = "sk-ant-abcdefghijklmnop123"
      const out = structured(yield* settleTool(registry, call({ text: `key ${secret} in /etc/passwd` }, sessionID)))
      expect(out.external_delivery).toBe("delivered")
      expect(externalCalls).toHaveLength(1)
      expect(externalCalls[0]?.text).not.toContain(secret)
      expect(externalCalls[0]?.text).not.toContain("/etc/passwd")
      expect(externalCalls[0]?.text).toContain("«path removed»")
      const durable = yield* db.select({ content: MessageTable.content }).from(MessageTable).get().pipe(Effect.orDie)
      expect(durable?.content).toBe(externalCalls[0]?.text)
    }),
  )

  it.effect("surfaces a permission rejection as the model-visible refusal", () =>
    Effect.gen(function* () {
      const { db, registry } = yield* services
      const sessionID = SessionV2.ID.make("ses_im_send_rejected")
      yield* seedBase(db, sessionID, { im: { groupID: GROUP, agent: "build" } })
      yield* seedMember(db, "build")
      yield* seedBinding(db)

      permissionMode = "reject"
      const result = yield* executeTool(registry, call({ text: "please do not send" }, sessionID)).pipe(
        Effect.ensuring(Effect.sync(() => (permissionMode = "allow"))),
      )
      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(String(result.value)).toContain("The user rejected permission")
      expect(yield* messageCount(db)).toBe(0)
      expect(externalCalls).toHaveLength(0)
    }),
  )
})
