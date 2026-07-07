import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Search } from "@deepagent-code/core/filesystem/search"
import { LSP } from "@/lsp/lsp"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Project } from "@/project/project"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"

// Appendix C / 形态一 (form 1): a NON-git directory hosts a working conversation.
// This is the "global" project fallback path (ProjectV2.ID.global, worktree === "/").
// The design doc calls this "有意处理,非 broken" — the worktree === "/" special case
// intentionally skips the worktree boundary so the permission boundary collapses onto
// the picked directory (containsPath in instance-context.ts). These regressions lock
// that behavior: (a) the instance boots, (b) cwd tools work, (c) the permission
// boundary is the picked directory, not the filesystem root.

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies Tool.Context

const referenceLayer = Reference.layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(RepositoryCache.defaultLayer),
  Layer.provide(RuntimeFlags.layer({})),
)

const baseLayer = Layer.mergeAll(
  Agent.defaultLayer,
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Instruction.defaultLayer,
  LSP.defaultLayer,
  referenceLayer,
  Search.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(Layer.mergeAll(baseLayer, testInstanceStoreLayer, Project.defaultLayer))

const put = Effect.fn(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const runRead = Effect.fn(function* (args: Tool.InferParameters<typeof ReadTool>, next: Tool.Context = ctx) {
  const tool = yield* (yield* ReadTool).init()
  return yield* tool.execute(args, next)
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

describe("Appendix C form 1 — non-git directory hosts a conversation", () => {
  it.live("resolves a non-git directory to the global project (worktree '/', directory kept)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const resolved = yield* Project.use.fromDirectory(dir)

      // Non-git dir → global project identity, but a concrete picked directory.
      expect(resolved.project.id).toBe(ProjectV2.ID.global)
      // The global fallback intentionally uses "/" as the worktree sentinel, and
      // (no vcs) the returned sandbox is that same "/" sentinel. The picked
      // directory is preserved separately as the instance directory (see the boot
      // test below), which is what keeps cwd tools and the permission boundary sane.
      expect(resolved.project.worktree).toBe("/")
      expect(resolved.sandbox).toBe("/")
    }),
  )

  it.live("boots an instance whose directory is the picked dir and worktree is the '/' sentinel", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const instance = yield* provideInstance(dir)(InstanceState.context)

      expect(instance.directory).toBe(dir)
      expect(instance.worktree).toBe("/")
      expect(instance.project.id).toBe(ProjectV2.ID.global)
    }),
  )

  it.live("reads a file inside a non-git directory (cwd tools work)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "notes.txt"), "hello from a folder with no git")

      const result = yield* provideInstance(dir)(runRead({ filePath: path.join(dir, "notes.txt") }))
      expect(result.output).toContain("hello from a folder with no git")
    }),
  )

  it.live("does not ask external_directory for a read inside the picked non-git directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "inside.txt"), "inside content")
      const { items, next } = asks()

      yield* provideInstance(dir)(runRead({ filePath: path.join(dir, "inside.txt") }, next))

      expect(items.find((item) => item.permission === "external_directory")).toBeUndefined()
    }),
  )

  it.live("permission boundary is the picked directory — worktree '/' does NOT open the whole filesystem", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped()
      yield* put(path.join(outer, "secret.txt"), "secret data")
      const { items, next } = asks()

      // Reading a sibling directory outside the picked dir must still trigger
      // external_directory — proving worktree === "/" is NOT treated as "everything".
      yield* provideInstance(dir)(runRead({ filePath: path.join(outer, "secret.txt") }, next))

      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.effect("containsPath treats worktree '/' as the picked directory boundary, not the FS root", () =>
    Effect.sync(() => {
      const instance: InstanceContext = {
        directory: "/home/user/scratch",
        worktree: "/",
        project: {
          id: ProjectV2.ID.global,
          worktree: "/",
          sandboxes: [],
          time: { created: 0, updated: 0 },
        },
      }
      // inside the picked directory → contained
      expect(containsPath("/home/user/scratch/a.txt", instance)).toBe(true)
      expect(containsPath("/home/user/scratch/sub/b.txt", instance)).toBe(true)
      // outside the picked directory → NOT contained, even though worktree is "/"
      expect(containsPath("/etc/passwd", instance)).toBe(false)
      expect(containsPath("/home/user/other/c.txt", instance)).toBe(false)
    }),
  )

  // 形态二 (form 2): a folder-less chat picks a dedicated sandbox dir (a non-git
  // directory shaped like <dataDir>/workspaces/<uuid>). This locks the end-to-end
  // security invariant for that form: the booted instance directory is the sandbox
  // (NOT "/" and NOT empty), and the permission boundary confines to the sandbox
  // even though the global project's worktree is the "/" sentinel.
  it.live("folder-less sandbox dir boots with directory === sandbox (never '/') and confines the boundary", () =>
    Effect.gen(function* () {
      const dataDir = yield* tmpdirScoped()
      const sandbox = path.join(dataDir, "workspaces", "11111111-2222-3333-4444-555555555555")
      yield* put(path.join(sandbox, "note.txt"), "inside the sandbox")
      yield* put(path.join(dataDir, "outside.txt"), "outside the sandbox")

      const instance = yield* provideInstance(sandbox)(InstanceState.context)
      // directory is the concrete sandbox — the boundary anchor — not "/" or empty.
      expect(instance.directory).toBe(sandbox)
      expect(instance.directory).not.toBe("/")
      expect(instance.directory.length).toBeGreaterThan(0)
      expect(instance.worktree).toBe("/")
      expect(instance.project.id).toBe(ProjectV2.ID.global)

      // Read inside the sandbox: no external_directory ask.
      const inside = asks()
      yield* provideInstance(sandbox)(runRead({ filePath: path.join(sandbox, "note.txt") }, inside.next))
      expect(inside.items.find((item) => item.permission === "external_directory")).toBeUndefined()

      // Read a sibling OUTSIDE the sandbox (but still under dataDir): external_directory
      // ask fires — the "/" worktree sentinel does NOT open the whole filesystem.
      const outside = asks()
      yield* provideInstance(sandbox)(runRead({ filePath: path.join(dataDir, "outside.txt") }, outside.next))
      expect(outside.items.find((item) => item.permission === "external_directory")).toBeDefined()
    }),
  )
})
