import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { DigestBuilder } from "../../src/session/digest-builder"
import { AgentPush } from "../../src/session/agent-push"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// V4.0 §B2/§E4 — the quiet-hours DIGEST BUILDER. AgentPush holds normal/low pushes during quiet hours
// as decision='digest' audit rows (no message delivered). This service flushes those held pushes into
// one summary per (group, agent) when quiet hours end. Verifies: no-op inside quiet hours, delivery +
// grouping outside quiet hours, and idempotency (a flushed row is never re-delivered).

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

// a quiet-hours window 22:00→06:00 UTC. Pick clock values inside/outside deterministically.
const QUIET = { startHour: 22, endHour: 6, tzOffsetMinutes: 0 }
const HOUR = 3_600_000
const at2am = 2 * HOUR // inside quiet hours
const at10am = 10 * HOUR // outside quiet hours

const makeLayer = () => {
  const database = Database.layerFromPath(":memory:")
  const repo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const cfg = WorkspaceConfig.layerWith({ now }).pipe(Layer.provideMerge(database))
  const flagsLayer = RuntimeFlags.layer({ v4AgentPushEnabled: true })
  const push = AgentPush.layerWith({ now }).pipe(Layer.provide(repo), Layer.provide(flagsLayer))
  const digest = DigestBuilder.layerWith({ now, runLoop: false }).pipe(
    Layer.provide(repo),
    Layer.provide(cfg),
    Layer.provide(database),
  )
  return Layer.mergeAll(digest, push, repo, cfg, flagsLayer, database)
}

const req = (
  groupID: string,
  over?: Partial<AgentPushPolicy.AgentPushRequest>,
): AgentPushPolicy.AgentPushRequest => ({
  workspaceID: "wrk_1",
  groupID,
  agentID: "agt_1",
  reason: "ci failed",
  priority: "normal",
  content: "the build failed",
  idempotencyKey: `k-${Math.random()}`,
  ...over,
})

// seed a group + add the agent as a member; returns the group id.
const seedGroup = (agentID: string) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const group = yield* repo.createGroup({ workspaceID: "wrk_1", type: "project", name: "g", createdBy: "user_1" })
    yield* repo.addMember({ groupID: group.id, memberID: agentID, memberType: "agent", role: "agent" })
    return group.id
  })

describe("DigestBuilder.flushWorkspace", () => {
  const it = testEffect(makeLayer())

  it.effect("§E4 delivers held digests as one summary per group OUTSIDE quiet hours", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const digest = yield* DigestBuilder.Service
      const groupID = yield* seedGroup("agt_1")

      // two normal pushes DURING quiet hours → held (decision=digest, no message).
      setNow(at2am)
      yield* push.push(req(groupID, { content: "build broke", idempotencyKey: "d1" }), { withinQuietHours: true })
      yield* push.push(req(groupID, { content: "tests failed", idempotencyKey: "d2" }), { withinQuietHours: true })
      let page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0) // held, not delivered

      // quiet hours end → flush.
      setNow(at10am)
      const result = yield* digest.flushWorkspace("wrk_1")
      expect(result.flushed).toBe(true)
      expect(result.groupsDelivered).toBe(1)
      expect(result.pushesFlushed).toBe(2)

      page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1) // ONE combined digest
      const msg = page.messages[0]
      expect(msg.senderType).toBe("agent")
      expect(msg.content).toContain("build broke")
      expect(msg.content).toContain("tests failed")
    }),
  )

  it.effect("§E4 no-op INSIDE quiet hours (holds the digest)", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const digest = yield* DigestBuilder.Service
      const groupID = yield* seedGroup("agt_1")

      setNow(at2am)
      yield* push.push(req(groupID, { idempotencyKey: "h1" }), { withinQuietHours: true })

      // still inside quiet hours → flush is a no-op.
      const result = yield* digest.flushWorkspace("wrk_1", at2am)
      expect(result.flushed).toBe(false)
      expect(result.groupsDelivered).toBe(0)
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0) // still held
    }),
  )

  it.effect("§E4 idempotent: a second flush does NOT re-deliver already-flushed digests", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const digest = yield* DigestBuilder.Service
      const groupID = yield* seedGroup("agt_1")

      setNow(at2am)
      yield* push.push(req(groupID, { idempotencyKey: "i1" }), { withinQuietHours: true })

      setNow(at10am)
      const first = yield* digest.flushWorkspace("wrk_1")
      expect(first.pushesFlushed).toBe(1)
      const second = yield* digest.flushWorkspace("wrk_1")
      expect(second.pushesFlushed).toBe(0) // nothing left to flush
      expect(second.groupsDelivered).toBe(0)

      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1) // still exactly one digest, no double-delivery
    }),
  )

  it.effect("§E4 groups by (group, agent): distinct agents get distinct digests", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const repo = yield* IMRepository
      const push = yield* AgentPush.Service
      const digest = yield* DigestBuilder.Service
      // one group, two agents both members.
      const group = yield* repo.createGroup({ workspaceID: "wrk_1", type: "project", name: "g", createdBy: "user_1" })
      yield* repo.addMember({ groupID: group.id, memberID: "agt_1", memberType: "agent", role: "agent" })
      yield* repo.addMember({ groupID: group.id, memberID: "agt_2", memberType: "agent", role: "agent" })

      setNow(at2am)
      yield* push.push(req(group.id, { agentID: "agt_1", content: "from one", idempotencyKey: "g1" }), { withinQuietHours: true })
      yield* push.push(req(group.id, { agentID: "agt_2", content: "from two", idempotencyKey: "g2" }), { withinQuietHours: true })

      setNow(at10am)
      const result = yield* digest.flushWorkspace("wrk_1")
      expect(result.groupsDelivered).toBe(2) // one digest per agent
      expect(result.pushesFlushed).toBe(2)
      const page = yield* repo.listMessages({ groupID: group.id, limit: 10 })
      expect(page.messages.length).toBe(2)
    }),
  )

  it.effect("§E4 no quiet-hours window configured → always flushes (never held)", () =>
    Effect.gen(function* () {
      // no cfg.set: default resolved config has no quietHours ⇒ never quiet ⇒ always flush.
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const digest = yield* DigestBuilder.Service
      const groupID = yield* seedGroup("agt_1")

      // a held digest row can still exist (e.g. quiet hours were removed after the push was held).
      setNow(at2am)
      yield* push.push(req(groupID, { idempotencyKey: "n1" }), { withinQuietHours: true })

      const result = yield* digest.flushWorkspace("wrk_1", at2am)
      expect(result.flushed).toBe(true) // no window ⇒ flush even at 2am
      expect(result.pushesFlushed).toBe(1)
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1)
    }),
  )
})
