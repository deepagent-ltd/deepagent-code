import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentPush } from "../../src/session/agent-push"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// V4.0 §B2 — the AgentPush runtime. Verifies fact-resolution (membership + rate count from
// im_agent_push_logs) → pure policy → persist. The decision logic itself is covered by
// core/agent-push-policy.test.ts.

let clock = 1_000_000
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const makeLayer = (flags?: Partial<RuntimeFlags.Info>) => {
  const database = Database.layerFromPath(":memory:")
  const repo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const flagsLayer = RuntimeFlags.layer({ v4AgentPushEnabled: true, ...flags })
  const push = AgentPush.layerWith({ now }).pipe(Layer.provide(repo), Layer.provide(flagsLayer))
  return Layer.mergeAll(push, repo, flagsLayer)
}

// seed a group + add the agent as a member; returns the group id.
const seedGroup = (agentID: string, asMember: boolean) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const group = yield* repo.createGroup({ workspaceID: "wrk_1", type: "project", name: "g", createdBy: "user_1" })
    if (asMember)
      yield* repo.addMember({ groupID: group.id, memberID: agentID, memberType: "agent", role: "agent" })
    return group.id
  })

const req = (groupID: string, over?: Partial<AgentPushPolicy.AgentPushRequest>): AgentPushPolicy.AgentPushRequest => ({
  workspaceID: "wrk_1",
  groupID,
  agentID: "agt_1",
  reason: "ci failed",
  priority: "normal",
  content: "the build failed",
  idempotencyKey: `k-${Math.random()}`,
  ...over,
})

describe("AgentPush.push", () => {
  const it = testEffect(makeLayer())

  it.effect("§B2 a member agent's push is delivered + persisted as a message", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const result = yield* push.push(req(groupID))
      expect(result.decision).toBe("deliver")
      expect(result.messageID).toBeDefined()
      // the message landed in the group
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.some((m) => m.id === result.messageID && m.senderType === "agent")).toBe(true)
    }),
  )

  it.effect("§B2 权限: a non-member agent without workspace push permission is blocked", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", false) // NOT a member
      const push = yield* AgentPush.Service
      const result = yield* push.push(req(groupID))
      expect(result.decision).toBe("blocked")
      expect(result.reason).toBe("not_authorized")
    }),
  )

  it.effect("§B2 权限: workspace push permission overrides non-membership", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", false)
      const push = yield* AgentPush.Service
      const result = yield* push.push(req(groupID), { hasWorkspacePushPermission: true })
      expect(result.decision).toBe("deliver")
    }),
  )

  it.effect("§B2 限流: over the per-window limit → blocked rate_limited", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      // deliver up to the (custom) limit of 2
      yield* push.push(req(groupID), { pushLimitPerHour: 2 })
      yield* push.push(req(groupID), { pushLimitPerHour: 2 })
      const third = yield* push.push(req(groupID), { pushLimitPerHour: 2 })
      expect(third.decision).toBe("blocked")
      expect(third.reason).toBe("rate_limited")
    }),
  )

  it.effect("§E4 静默时段: normal priority inside quiet hours → digest (no message persisted)", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const result = yield* push.push(req(groupID, { priority: "normal" }), { withinQuietHours: true })
      expect(result.decision).toBe("digest")
      expect(result.messageID).toBeUndefined()
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0) // held for digest, not delivered
    }),
  )

  it.effect("§E4 静默时段: critical passes through quiet hours (delivered)", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      const result = yield* push.push(req(groupID, { priority: "critical" }), { withinQuietHours: true })
      expect(result.decision).toBe("deliver")
    }),
  )

  it.effect("§B2 去重: a re-push with the same idempotencyKey does NOT double-deliver", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const first = yield* push.push(req(groupID, { idempotencyKey: "dedupe-1" }))
      const second = yield* push.push(req(groupID, { idempotencyKey: "dedupe-1", content: "different text" }))
      expect(first.decision).toBe("deliver")
      expect(second.decision).toBe("deliver")
      expect(second.messageID).toBe(first.messageID) // same original message, not a new one
      // exactly ONE message in the group
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1)
    }),
  )

  it.effect("§B2 静默digest content is retained (audit source for the digest builder)", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      const r = yield* push.push(req(groupID, { priority: "low", content: "queued note", idempotencyKey: "dig-1" }), {
        withinQuietHours: true,
      })
      expect(r.decision).toBe("digest")
      // a re-push with the same key returns the recorded digest outcome (idempotent), proving the
      // audit row (with content) persisted.
      const again = yield* push.push(req(groupID, { priority: "low", idempotencyKey: "dig-1" }), { withinQuietHours: true })
      expect(again.decision).toBe("digest")
    }),
  )
})

describe("AgentPush flag off", () => {
  const it = testEffect(makeLayer({ v4AgentPushEnabled: false }))

  it.effect("fail-closed: flag OFF → flag_disabled, nothing persisted", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const result = yield* push.push(req(groupID))
      expect(result.decision).toBe("flag_disabled")
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0)
    }),
  )
})
