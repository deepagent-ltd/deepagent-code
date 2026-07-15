import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentPush } from "../../src/session/agent-push"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Database } from "@deepagent-code/core/database/database"
import { WorkspaceTable } from "@deepagent-code/core/control-plane/workspace.sql"
import { ProjectTable, ProjectDirectoryTable } from "@deepagent-code/core/project/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { AbsolutePath } from "@deepagent-code/core/schema"
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

// §E4 (P2.8) — the REAL quiet-hours resolution (no factOverrides.withinQuietHours). AgentPush resolves
// the workspace's configured quiet-hours window from WorkspaceConfig and honors it. This layer PROVIDES
// WorkspaceConfig (unlike the base makeLayer) so the resolution path is exercised end-to-end.
const HOUR = 3_600_000
const QUIET = { startHour: 22, endHour: 6, tzOffsetMinutes: 0 } // 22:00→06:00 UTC
const at2am = 2 * HOUR // inside quiet hours
const at10am = 10 * HOUR // outside quiet hours

const makeConfigLayer = () => {
  const database = Database.layerFromPath(":memory:")
  const repo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const cfg = WorkspaceConfig.layerWith({ now }).pipe(Layer.provideMerge(database))
  const flagsLayer = RuntimeFlags.layer({ v4AgentPushEnabled: true })
  const push = AgentPush.layerWith({ now }).pipe(
    Layer.provide(repo),
    Layer.provide(flagsLayer),
    Layer.provide(cfg),
  )
  return Layer.mergeAll(push, repo, cfg, flagsLayer, database)
}

describe("AgentPush.push §E4 real quiet-hours (WorkspaceConfig-resolved)", () => {
  const it = testEffect(makeConfigLayer())

  it.effect("normal push INSIDE a configured quiet window → digest (no message), NO override", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      setNow(at2am)
      const groupID = yield* seedGroup("agt_1", true)
      // no factOverrides — the real window resolution must decide "digest".
      const result = yield* push.push(req(groupID, { priority: "normal", idempotencyKey: "q-normal" }))
      expect(result.decision).toBe("digest")
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0) // held, not delivered
    }),
  )

  it.effect("high push INSIDE quiet hours punches through → delivered", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const push = yield* AgentPush.Service
      setNow(at2am)
      const groupID = yield* seedGroup("agt_1", true)
      const result = yield* push.push(req(groupID, { priority: "high", idempotencyKey: "q-high" }))
      expect(result.decision).toBe("deliver")
    }),
  )

  it.effect("normal push OUTSIDE the configured window → delivered (real resolution)", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { quietHours: QUIET })
      const push = yield* AgentPush.Service
      setNow(at10am)
      const groupID = yield* seedGroup("agt_1", true)
      const result = yield* push.push(req(groupID, { priority: "normal", idempotencyKey: "q-out" }))
      expect(result.decision).toBe("deliver")
    }),
  )

  it.effect("no configured window → never quiet (fail-safe): normal push delivered even at 2am", () =>
    Effect.gen(function* () {
      // no cfg.set: default resolved config has no quietHours ⇒ never quiet.
      const push = yield* AgentPush.Service
      setNow(at2am)
      const groupID = yield* seedGroup("agt_1", true)
      const result = yield* push.push(req(groupID, { priority: "normal", idempotencyKey: "q-none" }))
      expect(result.decision).toBe("deliver")
    }),
  )
})

// §E3 (P2.8) — the path-ACL leg. scrub now runs WITH allowedPathRoots resolved from the workspace, so a
// push naming a file OUTSIDE the allowed roots has that path stripped («path removed») before delivery.
describe("AgentPush.push §E3 file-path ACL", () => {
  const it = testEffect(makeConfigLayer())

  it.effect("an out-of-ACL absolute path in push content is stripped, an in-root path survives", () =>
    Effect.gen(function* () {
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      setNow(1_000_000)
      const groupID = yield* seedGroup("agt_1", true)
      // roots = /workspace/root; /etc/passwd is outside → stripped; /workspace/root/src/app.ts inside → kept.
      const result = yield* push.push(
        req(groupID, {
          content: "leaked /etc/passwd but ok /workspace/root/src/app.ts",
          idempotencyKey: "acl-1",
        }),
        { allowedPathRoots: ["/workspace/root"] },
      )
      expect(result.decision).toBe("deliver")
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      const content = page.messages[0].content
      expect(content).toContain("«path removed»") // /etc/passwd stripped
      expect(content).not.toContain("/etc/passwd")
      expect(content).toContain("/workspace/root/src/app.ts") // in-root path preserved
    }),
  )

  it.effect("default resolver: a directory-style workspaceID becomes its own root", () =>
    Effect.gen(function* () {
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      setNow(1_000_000)
      // a directory-routed workspace: the id IS the fs root, so /etc/passwd is out-of-root → stripped.
      const repoSvc = yield* IMRepository
      const group = yield* repoSvc.createGroup({
        workspaceID: "/home/proj",
        type: "project",
        name: "g",
        createdBy: "user_1",
      })
      yield* repoSvc.addMember({ groupID: group.id, memberID: "agt_1", memberType: "agent", role: "agent" })
      const result = yield* push.push(
        req(group.id, { workspaceID: "/home/proj", content: "see /etc/shadow", idempotencyKey: "acl-2" }),
      )
      expect(result.decision).toBe("deliver")
      const page = yield* repo.listMessages({ groupID: group.id, limit: 10 })
      expect(page.messages[0].content).toContain("«path removed»")
      expect(page.messages[0].content).not.toContain("/etc/shadow")
    }),
  )
})

// §E3 (P4.2) — a genuine multi-tenant "wrk_" workspaceID now resolves to its REAL project root(s) via the
// DB-backed workspace→directory mechanism (workspace.directory ∪ project worktree/sandboxes ∪
// project_directory). Before P4.2 a "wrk_"-id resolved to NO roots ⇒ the path-ACL leg was OFF for every
// genuine workspace; these tests prove the leg is now LIVE for wrk_ ids AND still fail-safe when a
// workspace can't be resolved. NO factOverrides.allowedPathRoots — resolution must come from the DB.
describe("AgentPush.push §E3 wrk_ path-ACL (real project-root resolution)", () => {
  const it = testEffect(makeConfigLayer())

  // seed a project (+ optional extra directory for multi-repo) and a workspace row rooting the given id.
  const seedWorkspace = (input: {
    workspaceID: string
    projectID: string
    worktree: string
    workspaceDir?: string
    extraDirectory?: string
  }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.make(input.projectID),
          worktree: AbsolutePath.make(input.worktree),
          time_created: 1,
          time_updated: 1,
          sandboxes: [],
        })
        .run()
      if (input.extraDirectory)
        yield* db
          .insert(ProjectDirectoryTable)
          .values({ project_id: ProjectV2.ID.make(input.projectID), directory: input.extraDirectory, type: "root" })
          .run()
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: WorkspaceV2.ID.make(input.workspaceID),
          type: "local",
          name: "ws",
          directory: input.workspaceDir ?? null,
          project_id: ProjectV2.ID.make(input.projectID),
        })
        .run()
    })

  it.effect("resolvable wrk_ workspace: path OUTSIDE its real root is stripped, path INSIDE is kept", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      yield* seedWorkspace({ workspaceID: "wrk_resolvable", projectID: "prj_r", worktree: "/repo/main" })
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({
        workspaceID: "wrk_resolvable",
        type: "project",
        name: "g",
        createdBy: "user_1",
      })
      yield* repo.addMember({ groupID: group.id, memberID: "agt_1", memberType: "agent", role: "agent" })
      // NO factOverrides.allowedPathRoots — the DB resolver must supply /repo/main.
      const result = yield* push.push(
        req(group.id, {
          workspaceID: "wrk_resolvable",
          content: "leaked /etc/passwd but ok /repo/main/src/app.ts",
          idempotencyKey: "wrk-acl-1",
        }),
      )
      expect(result.decision).toBe("deliver")
      const page = yield* repo.listMessages({ groupID: group.id, limit: 10 })
      const content = page.messages[0].content
      expect(content).toContain("«path removed»") // /etc/passwd is outside /repo/main → stripped
      expect(content).not.toContain("/etc/passwd")
      expect(content).toContain("/repo/main/src/app.ts") // inside the real root → preserved
    }),
  )

  it.effect("multi-repo wrk_ workspace: a path inside EITHER project directory survives", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      yield* seedWorkspace({
        workspaceID: "wrk_multirepo",
        projectID: "prj_m",
        worktree: "/repo/api",
        extraDirectory: "/repo/web",
      })
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({
        workspaceID: "wrk_multirepo",
        type: "project",
        name: "g",
        createdBy: "user_1",
      })
      yield* repo.addMember({ groupID: group.id, memberID: "agt_1", memberType: "agent", role: "agent" })
      const result = yield* push.push(
        req(group.id, {
          workspaceID: "wrk_multirepo",
          content: "api /repo/api/main.ts web /repo/web/index.ts out /etc/hosts",
          idempotencyKey: "wrk-acl-multi",
        }),
      )
      expect(result.decision).toBe("deliver")
      const content = (yield* repo.listMessages({ groupID: group.id, limit: 10 })).messages[0].content
      expect(content).toContain("/repo/api/main.ts") // first repo root → kept
      expect(content).toContain("/repo/web/index.ts") // second repo root (project_directory) → kept
      expect(content).toContain("«path removed»") // /etc/hosts outside both → stripped
      expect(content).not.toContain("/etc/hosts")
    }),
  )

  it.effect("UNRESOLVABLE wrk_ workspace (no row): ACL leg OFF — push still proceeds, paths untouched", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      // no seedWorkspace: "wrk_missing" has no workspace row ⇒ resolver returns undefined ⇒ leg off.
      const push = yield* AgentPush.Service
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({
        workspaceID: "wrk_missing",
        type: "project",
        name: "g",
        createdBy: "user_1",
      })
      yield* repo.addMember({ groupID: group.id, memberID: "agt_1", memberType: "agent", role: "agent" })
      const result = yield* push.push(
        req(group.id, { workspaceID: "wrk_missing", content: "see /etc/passwd", idempotencyKey: "wrk-acl-none" }),
      )
      // fail-safe: the push still delivers (ACL leg simply off), and with no roots nothing is stripped.
      expect(result.decision).toBe("deliver")
      const content = (yield* repo.listMessages({ groupID: group.id, limit: 10 })).messages[0].content
      expect(content).toContain("/etc/passwd") // leg off ⇒ path NOT stripped (no fabricated root)
      expect(content).not.toContain("«path removed»")
    }),
  )
})
