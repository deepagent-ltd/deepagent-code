import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
  canReuseSuccess,
  readSuccessCache,
  successCacheKey,
  successCacheTTL,
  writeSuccessCache,
  type SuccessCacheKeyInput,
} from "../../script/live-llm/cache"
import {
  blockingDirtyPaths,
  parseDirtyPaths,
  parsePushedRefs,
  readDirtyPaths,
  resolvePushedRefs,
} from "../../script/live-llm/git"
import { modelRunKey, owningPaths, routeManifest, selectRoutes } from "../../script/live-llm/routes"
import {
  commandForModelRun,
  commandsForChecks,
  qualifiedLiveRuns,
  unqualifiedRuns,
} from "../../script/live-llm/dispatcher"
import { tmpdir } from "../fixture/fixture"
import { createPrePushPlan, prePushEnvironment, runPrePushCommand } from "../../../../script/pre-push-live-llm"

const zeroOID = "0".repeat(40)
const cacheInput = {
  pushedRef: "refs/heads/dev",
  objectOID: "a".repeat(40),
  commitOID: "b".repeat(40),
  suite: "file-mutations",
  suiteVersion: "1",
  stack: "legacy-session",
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
  modelRevision: "revision-1",
  processIdentity: "process-1",
  generationParametersHash: "generation",
  harnessHash: "harness",
  routeManifestHash: "routes",
  relevantSourceHash: "source",
  buildArtifactHash: "build",
  sandboxProfileHash: "sandbox",
  oracleHash: "oracle",
} satisfies SuccessCacheKeyInput

describe("live LLM route manifest", () => {
  test("maps critical paths to an execution-stack-specific run", () => {
    const cases = [
      {
        path: "packages/llm/src/providers/openai-compatible.ts",
        runs: [
          "live:adapter:provider-smoke",
          "live:adapter:structured-output",
          "live:legacy-session:structured-output",
          "live:session-v2:v2-provider-loop",
        ],
      },
      {
        path: "packages/core/src/session/runner/llm.ts",
        runs: ["live:session-v2:v2-provider-loop"],
      },
      {
        path: "packages/core/src/tool/edit.ts",
        runs: ["live:session-v2:file-mutations"],
      },
      {
        path: "packages/deepagent-code/src/tool/edit.ts",
        runs: ["live:legacy-session:file-mutations"],
      },
      {
        path: "packages/deepagent-code/src/tool/task.ts",
        runs: [
          "ext:cli-subprocess:goal-grader-cli-entry",
          "ext:legacy-session:expert-panel",
          "ext:legacy-session:multi-agent-parallel-worktrees",
          "ext:legacy-session:multi-agent-pr-collaboration",
          "ext:legacy-session:subagent-background",
          "ext:legacy-session:subagent-intensity",
          "ext:legacy-session:subagent-interrupted",
          "ext:legacy-session:subagent-resume",
          "ext:legacy-session:subagent-takeover",
          "ext:legacy-session:subagent-worktree-routing",
          "live:legacy-session:subagent-foreground",
        ],
      },
      {
        path: "packages/deepagent-code/src/project/instance-layer.ts",
        runs: [
          "ext:legacy-session:multi-agent-parallel-worktrees",
          "ext:legacy-session:multi-agent-pr-collaboration",
          "ext:legacy-session:subagent-worktree-routing",
        ],
      },
      {
        path: "packages/deepagent-code/src/effect/instance-ref.ts",
        runs: [
          "ext:legacy-session:multi-agent-parallel-worktrees",
          "ext:legacy-session:multi-agent-pr-collaboration",
          "ext:legacy-session:subagent-background",
          "ext:legacy-session:subagent-interrupted",
          "ext:legacy-session:subagent-resume",
          "ext:legacy-session:subagent-takeover",
        ],
      },
      {
        path: "packages/deepagent-code/src/mcp/adapter.ts",
        runs: ["ext:legacy-session:mcp-marker"],
      },
      {
        path: "packages/deepagent-code/src/cli/cmd/run.ts",
        runs: ["ext:cli-subprocess:goal-grader-cli-entry", "live:cli-subprocess:cli-headless"],
      },
      {
        path: "packages/deepagent-code/src/cli/cmd/run/runtime.ts",
        runs: ["ext:cli-subprocess:goal-grader-cli-entry", "live:cli-subprocess:cli-headless"],
      },
      {
        path: "packages/deepagent-code/src/session/history-authority.ts",
        runs: ["ext:cli-subprocess:context-authority", "ext:legacy-session:compaction-retention"],
      },
      {
        path: "packages/deepagent-code/src/panel/panel-convene-consumer.ts",
        runs: ["ext:legacy-session:expert-panel"],
      },
      {
        path: "packages/llm/script/live-llm/structured-output-adapter.ts",
        runs: ["live:adapter:structured-output"],
      },
      {
        path: "packages/deepagent-code/script/live-llm/lifecycle.ts",
        runs: [
          "ext:cli-subprocess:context-authority",
          "ext:cli-subprocess:goal-grader-cli-entry",
          "ext:legacy-session:compaction-retention",
          "ext:legacy-session:expert-panel",
          "ext:legacy-session:intelligence-draft-confirmation",
          "ext:legacy-session:mcp-marker",
          "ext:legacy-session:multi-agent-dag",
          "ext:legacy-session:multi-agent-parallel-worktrees",
          "ext:legacy-session:multi-agent-pr-collaboration",
          "ext:legacy-session:permissions-deny",
          "ext:legacy-session:prompt-intent-fencing",
          "ext:legacy-session:subagent-background",
          "ext:legacy-session:subagent-finalizer-isolation",
          "ext:legacy-session:subagent-intensity",
          "ext:legacy-session:subagent-interrupted",
          "ext:legacy-session:subagent-resume",
          "ext:legacy-session:subagent-takeover",
          "ext:legacy-session:subagent-worktree-routing",
          "ext:packaged-sidecar:long-session",
          "ext:renderer-ui:activity-progress-package",
          "ext:v4-event-runtime:v4-multi-agent-runtime",
          "live:adapter:provider-smoke",
          "live:adapter:structured-output",
          "live:cli-subprocess:cli-headless",
          "live:legacy-session:activity-progress-lifecycle",
          "live:legacy-session:bash-repair",
          "live:legacy-session:continuation-repetition",
          "live:legacy-session:degeneration",
          "live:legacy-session:file-mutations",
          "live:legacy-session:file-read-search",
          "live:legacy-session:plan-advance-contract",
          "live:legacy-session:plan-create-replan-contract",
          "live:legacy-session:shell-exit-contract",
          "live:legacy-session:stale-validation",
          "live:legacy-session:steer-boundary",
          "live:legacy-session:structured-output",
          "live:legacy-session:subagent-control-plane",
          "live:legacy-session:subagent-foreground",
          "live:packaged-sidecar:activity-progress-restart",
          "live:session-v2:bash-repair",
          "live:session-v2:file-mutations",
          "live:session-v2:file-read-search",
          "live:session-v2:v2-provider-loop",
        ],
      },
      {
        path: "packages/core/script/live-llm/file-tools.ts",
        runs: ["live:session-v2:file-mutations", "live:session-v2:file-read-search"],
      },
      {
        path: "packages/desktop/scripts/live-llm/packaged-sidecar.ts",
        runs: ["ext:packaged-sidecar:packaged-sidecar"],
      },
      {
        path: "packages/desktop/scripts/live-llm/activity-progress-restart.ts",
        runs: ["live:packaged-sidecar:activity-progress-restart"],
      },
      {
        path: "packages/desktop/scripts/live-llm/activity-progress-package.ts",
        runs: ["ext:renderer-ui:activity-progress-package"],
      },
      {
        path: "packages/desktop/scripts/live-llm/desktop-subagents.ts",
        runs: [],
      },
      {
        path: "packages/desktop/scripts/live-llm/desktop-ui.ts",
        runs: [],
      },
      {
        path: "packages/desktop/scripts/live-llm/long-session.ts",
        runs: ["ext:packaged-sidecar:long-session"],
      },
      {
        path: "packages/deepagent-code/script/live-llm/autonomous-eval.ts",
        runs: [],
      },
    ]

    for (const item of cases) {
      const selected = selectRoutes([item.path])
      expect(selected.runs.map(modelRunKey)).toEqual(item.runs)
      expect(selected.unclassified).toEqual([])
      expect(selected.invalid).toEqual([])
    }
  })

  test("deduplicates runs without merging legacy and V2 cache identities", () => {
    const selected = selectRoutes([
      "packages/core/src/tool/edit.ts",
      "packages/core/src/tool/write.ts",
      "packages/deepagent-code/src/tool/edit.ts",
      "packages/deepagent-code/src/tool/write.ts",
    ])

    expect(selected.runs.map(modelRunKey)).toEqual([
      "live:legacy-session:file-mutations",
      "live:session-v2:file-mutations",
    ])
  })

  test("keeps the worktree regression reachable from every owning production seam", () => {
    const paths = [
      "packages/deepagent-code/src/session/prompt.ts",
      "packages/deepagent-code/src/tool/task.ts",
      "packages/deepagent-code/src/project/instance-store.ts",
      "packages/deepagent-code/src/project/instance-layer.ts",
      "packages/deepagent-code/src/worktree/index.ts",
    ]

    paths.forEach((path) => {
      const selected = selectRoutes([path])
      expect(selected.runs.map(modelRunKey)).toContain("ext:legacy-session:subagent-worktree-routing")
      expect(selected.checks).toContain("worktree-routing")
    })
  })

  test("keeps resumed child execution reachable from its harness and owning production seams", () => {
    const paths = [
      "packages/deepagent-code/script/live-llm/subagent-resume.ts",
      "packages/deepagent-code/src/tool/task.ts",
      "packages/deepagent-code/src/session/session.ts",
      "packages/deepagent-code/src/effect/instance-ref.ts",
    ]

    paths.forEach((path) => {
      const selected = selectRoutes([path])
      expect(selected.runs.map(modelRunKey)).toContain("ext:legacy-session:subagent-resume")
      expect(
        commandForModelRun(selected.runs.find((run) => modelRunKey(run) === "ext:legacy-session:subagent-resume")!),
      ).toBeDefined()
    })
  })

  test("routes continuation context changes to the real repetition regression", () => {
    for (const path of [
      "packages/core/src/agent-gateway.ts",
      "packages/core/src/deepagent/prompt-policy.ts",
      "packages/core/src/deepagent/session-state.ts",
      "packages/deepagent-code/src/session/llm/request.ts",
      "packages/deepagent-code/src/session/reminders.ts",
      "packages/deepagent-code/script/live-llm/continuation-repetition.ts",
    ]) {
      const run = selectRoutes([path]).runs.find(
        (item) => modelRunKey(item) === "live:legacy-session:continuation-repetition",
      )
      expect(run).toBeDefined()
      expect(commandForModelRun(run!)).toEqual({
        cwd: "packages/deepagent-code",
        args: ["bun", "run", "test:llm-live:continuation-repetition"],
      })
    }
  })

  test("routes Plan parameter-contract changes to the dedicated real Provider suite", () => {
    for (const path of [
      "packages/core/src/deepagent/plan-controller.ts",
      "packages/core/src/deepagent/prompt-policy.ts",
      "packages/deepagent-code/src/session/llm/request.ts",
      "packages/deepagent-code/src/session/reminders.ts",
      "packages/deepagent-code/src/tool/plan-write.ts",
      "packages/deepagent-code/script/live-llm/plan-advance-contract.ts",
      "packages/deepagent-code/script/live-llm/plan-advance-oracle.ts",
    ]) {
      const run = selectRoutes([path]).runs.find(
        (item) => modelRunKey(item) === "live:legacy-session:plan-advance-contract",
      )
      expect(run).toBeDefined()
      expect(commandForModelRun(run!)).toEqual({
        cwd: "packages/deepagent-code",
        args: ["bun", "run", "test:llm-live:plan-advance"],
      })
    }
  })

  test("routes Plan create/replan authority changes to the DeepSeek real Provider suite", () => {
    for (const path of [
      "packages/core/src/deepagent/plan-controller.ts",
      "packages/deepagent-code/src/tool/plan-write.ts",
      "packages/deepagent-code/src/tool/plan-write.txt",
      "packages/deepagent-code/script/live-llm/plan-create-replan-contract.ts",
      "packages/deepagent-code/script/live-llm/plan-create-replan-oracle.ts",
    ]) {
      const run = selectRoutes([path]).runs.find(
        (item) => modelRunKey(item) === "live:legacy-session:plan-create-replan-contract",
      )
      expect(run).toBeDefined()
      expect(commandForModelRun(run!)).toEqual({
        cwd: "packages/deepagent-code",
        args: ["bun", "run", "test:llm-live:plan-create-replan"],
      })
    }
  })

  test("routes activity progress lifecycle changes to the DeepSeek real Provider suite", () => {
    for (const path of [
      "packages/app/src/pages/session/message-timeline.data.ts",
      "packages/deepagent-code/src/session/activity-sql.ts",
      "packages/deepagent-code/src/session/prompt-intent.ts",
      "packages/deepagent-code/src/session/prompt.ts",
      "packages/deepagent-code/src/session/steer.ts",
      "packages/deepagent-code/script/live-llm/activity-progress-lifecycle.ts",
      "packages/deepagent-code/script/live-llm/activity-progress-oracle.ts",
    ]) {
      const run = selectRoutes([path]).runs.find(
        (item) => modelRunKey(item) === "live:legacy-session:activity-progress-lifecycle",
      )
      expect(run).toBeDefined()
      expect(commandForModelRun(run!)).toEqual({
        cwd: "packages/deepagent-code",
        args: ["bun", "run", "test:llm-live:activity-progress"],
      })
    }
  })

  test("routes activity progress production changes through restart and packaged GUI release gates", () => {
    const selected = selectRoutes([
      "packages/app/src/pages/session/message-timeline.data.ts",
      "packages/deepagent-code/src/session/prompt-intent.ts",
      "packages/deepagent-code/src/session/prompt.ts",
    ])

    expect(selected.runs.map(modelRunKey)).toContain("live:packaged-sidecar:activity-progress-restart")
    expect(selected.runs.map(modelRunKey)).toContain("ext:renderer-ui:activity-progress-package")
    expect(selected.runs.map(modelRunKey)).toContain("ext:packaged-sidecar:long-session")
    expect(
      commandForModelRun(
        selected.runs.find((run) => modelRunKey(run) === "live:packaged-sidecar:activity-progress-restart")!,
      ),
    ).toEqual({
      cwd: "packages/desktop",
      args: ["bun", "run", "test:llm-live:activity-progress-restart"],
    })
    expect(
      commandForModelRun(
        selected.runs.find((run) => modelRunKey(run) === "ext:renderer-ui:activity-progress-package")!,
      ),
    ).toEqual({
      cwd: "packages/desktop",
      args: ["bun", "run", "test:llm-release:activity-progress-package"],
    })
    expect(
      commandForModelRun(selected.runs.find((run) => modelRunKey(run) === "ext:packaged-sidecar:long-session")!),
    ).toEqual({
      cwd: "packages/desktop",
      args: ["bun", "run", "test:llm-release:long-session"],
    })
  })

  test("routes question-rejection and provider-recovery seams through the real Desktop continuation gate", () => {
    for (const path of [
      "packages/deepagent-code/src/session/legacy-provider-resolution.ts",
      "packages/deepagent-code/src/session/processor.ts",
      "packages/deepagent-code/src/session/recovery-transfer-guard.ts",
      "packages/desktop/scripts/live-llm/long-session.ts",
    ]) {
      const run = selectRoutes([path]).runs.find(
        (item) => modelRunKey(item) === "ext:packaged-sidecar:long-session",
      )
      expect(run).toBeDefined()
      expect(commandForModelRun(run!)).toEqual({
        cwd: "packages/desktop",
        args: ["bun", "run", "test:llm-release:long-session"],
      })
    }
  })

  test("keeps bounded takeover reachable from its harness and supervision seams", () => {
    const paths = [
      "packages/deepagent-code/script/live-llm/subagent-takeover.ts",
      "packages/deepagent-code/src/tool/task.ts",
      "packages/deepagent-code/src/effect/runtime-flags.ts",
      "packages/deepagent-code/src/question/index.ts",
    ]

    paths.forEach((path) => {
      const selected = selectRoutes([path])
      expect(selected.runs.map(modelRunKey)).toContain("ext:legacy-session:subagent-takeover")
      expect(
        commandForModelRun(selected.runs.find((run) => modelRunKey(run) === "ext:legacy-session:subagent-takeover")!),
      ).toBeDefined()
    })
  })

  test("routes the real Expert Panel and Goal CLI production contracts", () => {
    const goalPaths = [
      "packages/core/src/deepagent/goal-loop.ts",
      "packages/core/src/deepagent/goal-plan-file.ts",
      "packages/core/src/deepagent/plan-controller.ts",
      "packages/deepagent-code/src/agent/subagent-permissions.ts",
      "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/deepagent.ts",
      "packages/deepagent-code/src/session/goal-manager.ts",
      "packages/deepagent-code/src/session/goal-loop-wiring.ts",
      "packages/deepagent-code/src/tool/plan-write.ts",
    ]
    goalPaths.forEach((path) => {
      const selected = selectRoutes([path])
      expect(selected.runs.map(modelRunKey)).toContain("ext:cli-subprocess:goal-grader-cli-entry")
      expect(selected.checks).toContain("goal-loop")
    })
    const panel = selectRoutes(["packages/deepagent-code/src/panel/consult.ts"])
    expect(panel.runs.map(modelRunKey)).toEqual(["ext:legacy-session:expert-panel"])
    expect(panel.checks).toContain("expert-panel")
  })

  test("fails closed for unknown owning paths and invalid paths", () => {
    const selected = selectRoutes([
      "packages/core/src/tool/new-implicit-tool.ts",
      "packages/llm/src/new-implicit-runtime.ts",
      "../outside.ts",
    ])

    expect(selected.unclassified).toEqual([
      "packages/core/src/tool/new-implicit-tool.ts",
      "packages/llm/src/new-implicit-runtime.ts",
    ])
    expect(selected.invalid).toEqual(["../outside.ts"])
  })

  test("classifies every current owning source file", async () => {
    const root = path.resolve(import.meta.dir, "../../../..")
    const files = (
      await Promise.all(
        owningPaths.map((pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true }))),
      )
    ).flat()

    expect(selectRoutes(files).unclassified).toEqual([])
  })

  test("does not schedule model runs for docs, generated SDK, i18n, or styles", () => {
    const selected = selectRoutes([
      "docs/llmrealtest.md",
      "packages/sdk/js/src/gen/types.ts",
      "packages/desktop/src/renderer/i18n/zh.ts",
      "packages/desktop/src/renderer/styles.css",
    ])

    expect(selected.checks).toEqual([])
    expect(selected.runs).toEqual([])
    expect(selected.unclassified).toEqual([])
  })

  test("keeps the installed hook thin and propagates dispatcher failures", async () => {
    const root = path.resolve(import.meta.dir, "../../../..")
    const hook = await Bun.file(path.join(root, "script/hooks")).text()
    expect(hook).toContain("bun run typecheck &&")
    expect(hook).toContain('exec bun run script/pre-push-live-llm.ts "$@"')
    expect(hook).not.toContain("bun install")
  })
})

describe("pre-push input", () => {
  test("parses branches, detached HEAD, and deletion records", () => {
    const localOID = "a".repeat(40)
    const remoteOID = "b".repeat(40)
    expect(
      parsePushedRefs(
        [
          `refs/heads/dev ${localOID} refs/heads/dev ${remoteOID}`,
          `HEAD ${localOID} refs/heads/detached ${zeroOID}`,
          `(delete) ${zeroOID} refs/heads/old ${remoteOID}`,
        ].join("\n"),
      ),
    ).toEqual([
      { localRef: "refs/heads/dev", localOID, remoteRef: "refs/heads/dev", remoteOID },
      { localRef: "HEAD", localOID, remoteRef: "refs/heads/detached", remoteOID: zeroOID },
      { localRef: "(delete)", localOID: zeroOID, remoteRef: "refs/heads/old", remoteOID },
    ])
  })

  test("rejects malformed, unsafe, and inconsistent records", () => {
    expect(() => parsePushedRefs("refs/heads/dev nope refs/heads/dev nope")).toThrow("object IDs")
    expect(() => parsePushedRefs(`dev ${"a".repeat(40)} refs/heads/dev ${zeroOID}`)).toThrow("local ref")
    expect(() => parsePushedRefs(`(delete) ${"a".repeat(40)} refs/heads/dev ${zeroOID}`)).toThrow(
      "inconsistent deletion",
    )
  })
})

describe("live LLM success cache", () => {
  test("includes execution stack and all invalidation inputs in its identity", () => {
    const keys = [
      successCacheKey(cacheInput),
      successCacheKey({ ...cacheInput, stack: "session-v2" }),
      successCacheKey({ ...cacheInput, generationParametersHash: "changed" }),
      successCacheKey({ ...cacheInput, harnessHash: "changed" }),
      successCacheKey({ ...cacheInput, routeManifestHash: "changed" }),
      successCacheKey({ ...cacheInput, relevantSourceHash: "changed" }),
      successCacheKey({ ...cacheInput, buildArtifactHash: "changed" }),
      successCacheKey({ ...cacheInput, sandboxProfileHash: "changed" }),
      successCacheKey({ ...cacheInput, oracleHash: "changed" }),
    ]

    expect(new Set(keys).size).toBe(keys.length)
  })

  test("allows cross-process reuse only with an explicit model revision", () => {
    expect(successCacheKey({ ...cacheInput, processIdentity: "other-process" })).toBe(successCacheKey(cacheInput))
    const withoutRevision = { ...cacheInput, modelRevision: undefined }
    expect(successCacheKey({ ...withoutRevision, processIdentity: "other-process" })).not.toBe(
      successCacheKey(withoutRevision),
    )
  })

  test("reuses only matching, non-future successes inside the 24 hour TTL", () => {
    const now = 2 * successCacheTTL
    const entry = { key: successCacheKey(cacheInput), completedAt: now - successCacheTTL }
    expect(canReuseSuccess(entry, cacheInput, now)).toBe(true)
    expect(canReuseSuccess({ ...entry, completedAt: entry.completedAt - 1 }, cacheInput, now)).toBe(false)
    expect(canReuseSuccess({ ...entry, completedAt: now + 1 }, cacheInput, now)).toBe(false)
    expect(canReuseSuccess(entry, { ...cacheInput, stack: "session-v2" }, now)).toBe(false)
  })

  test("rejects incomplete cache identities", () => {
    expect(() => successCacheKey({ ...cacheInput, routeManifestHash: "" })).toThrow("empty identity")
  })

  test("round trips an auditable cache file and rejects malformed content", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "cache.json")
    const entry = { key: successCacheKey(cacheInput), completedAt: Date.now(), identity: cacheInput }
    await writeSuccessCache(file, { version: 1, entries: [entry] })
    expect(await readSuccessCache(file)).toEqual({ version: 1, entries: [entry] })

    await Bun.write(file, JSON.stringify({ version: 1, entries: [{ key: 1 }] }))
    await expect(readSuccessCache(file)).rejects.toThrow("Invalid live LLM success cache entry")
  })
})

describe("pushed OID resolution", () => {
  test("uses the remote and local final trees for ordinary pushes", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    const remoteOID = await revParse(repository.path, "HEAD")
    const localOID = await commitFile(repository.path, "packages/core/src/tool/edit.ts", "export const edit = 1\n")

    const plan = await resolvePushedRefs({
      repository: repository.path,
      remote: "origin",
      refs: parsePushedRefs(`refs/heads/dev ${localOID} refs/heads/dev ${remoteOID}`),
    })

    expect(plan.refs[0].kind).toBe("commit")
    expect(plan.refs[0].commitOID).toBe(localOID)
    expect(plan.refs[0].remoteCommitOID).toBe(remoteOID)
    expect(plan.paths).toEqual(["packages/core/src/tool/edit.ts"])
    expect(plan.selection.runs.map(modelRunKey)).toEqual(["live:session-v2:file-mutations"])
  })

  test("uses a force-push final-tree diff instead of replaying commits", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    const commonOID = await revParse(repository.path, "HEAD")
    const remoteOID = await commitFile(
      repository.path,
      "packages/llm/src/providers/openai-compatible.ts",
      "export const remote = 1\n",
    )
    await git(repository.path, ["push", "origin", "dev"])
    await git(repository.path, ["switch", "--detach", commonOID])
    const localOID = await commitFile(repository.path, "packages/core/src/tool/edit.ts", "export const local = 1\n")

    const plan = await resolvePushedRefs({
      repository: repository.path,
      remote: "origin",
      refs: parsePushedRefs(`HEAD ${localOID} refs/heads/dev ${remoteOID}`),
    })

    expect(plan.paths).toEqual(["packages/core/src/tool/edit.ts", "packages/llm/src/providers/openai-compatible.ts"])
    expect(plan.commits).toEqual([localOID])
  })

  test("uses only commits not reachable from the target remote for a new branch", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    await git(repository.path, ["switch", "-c", "feature"])
    const localOID = await commitFile(repository.path, "packages/core/src/tool/read.ts", "export const read = 1\n")

    const plan = await resolvePushedRefs({
      repository: repository.path,
      remote: "origin",
      refs: parsePushedRefs(`refs/heads/feature ${localOID} refs/heads/feature ${zeroOID}`),
    })

    expect(plan.paths).toEqual(["packages/core/src/tool/read.ts"])
    expect(plan.selection.runs.map(modelRunKey)).toEqual(["live:session-v2:file-read-search"])
  })

  test("peels lightweight and annotated tags and records non-commit tags", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    await commitFile(repository.path, "blob.txt", "blob\n")
    await git(repository.path, ["push", "origin", "dev"])
    const commitOID = await revParse(repository.path, "HEAD")
    const blobOID = await revParse(repository.path, "HEAD:blob.txt")
    await git(repository.path, ["tag", "lightweight", commitOID])
    await git(repository.path, ["tag", "-a", "annotated", "-m", "annotated", commitOID])
    await git(repository.path, ["tag", "blob", blobOID])
    const annotatedOID = await revParse(repository.path, "refs/tags/annotated")

    const plan = await resolvePushedRefs({
      repository: repository.path,
      remote: "origin",
      refs: parsePushedRefs(
        [
          `refs/tags/lightweight ${commitOID} refs/tags/lightweight ${zeroOID}`,
          `refs/tags/annotated ${annotatedOID} refs/tags/annotated ${zeroOID}`,
          `refs/tags/blob ${blobOID} refs/tags/blob ${zeroOID}`,
        ].join("\n"),
      ),
    })

    expect(plan.refs.map((ref) => ref.kind)).toEqual(["commit", "commit", "non-commit-tag"])
    expect(plan.refs[0].commitOID).toBe(commitOID)
    expect(plan.refs[1].commitOID).toBe(commitOID)
    expect(plan.commits).toEqual([commitOID])
    expect(plan.paths).toEqual([])
  })

  test("skips deletions, deduplicates shared tips, and preserves distinct final commits", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    const remoteOID = await revParse(repository.path, "HEAD")
    const firstOID = await commitFile(repository.path, "packages/core/src/tool/write.ts", "export const write = 1\n")
    const secondOID = await commitFile(repository.path, "packages/core/src/tool/bash.ts", "export const bash = 1\n")

    const plan = await resolvePushedRefs({
      repository: repository.path,
      remote: "origin",
      refs: parsePushedRefs(
        [
          `refs/heads/dev ${firstOID} refs/heads/dev ${remoteOID}`,
          `refs/heads/copy ${firstOID} refs/heads/copy ${zeroOID}`,
          `refs/heads/second ${secondOID} refs/heads/second ${zeroOID}`,
          `(delete) ${zeroOID} refs/heads/old ${remoteOID}`,
        ].join("\n"),
      ),
    })

    expect(plan.refs.map((ref) => ref.kind)).toEqual(["commit", "commit", "commit", "delete"])
    expect(plan.commits).toEqual([firstOID, secondOID])
    expect(plan.paths).toEqual(["packages/core/src/tool/bash.ts", "packages/core/src/tool/write.ts"])
  })

  test("does not depend on HEAD, the current branch, or a local main ref", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    const remoteOID = await revParse(repository.path, "HEAD")
    await git(repository.path, ["switch", "--detach"])
    const localOID = await commitFile(repository.path, "packages/core/src/tool/bash.ts", "export const bash = 1\n")
    await git(repository.path, ["switch", "--detach", remoteOID])

    expect((await git(repository.path, ["rev-parse", "--verify", "refs/heads/main"], true)).success).toBe(false)
    const plan = await resolvePushedRefs({
      repository: repository.path,
      remote: "origin",
      refs: parsePushedRefs(`HEAD ${localOID} refs/heads/detached ${zeroOID}`),
    })

    expect(plan.refs[0].commitOID).toBe(localOID)
    expect(plan.paths).toEqual(["packages/core/src/tool/bash.ts"])
  })
})

describe("dirty worktree checks", () => {
  test("parses rename records without dropping either path", () => {
    expect(parseDirtyPaths("R  new name.ts\0old name.ts\0 M tracked.ts\0?? new.ts\0")).toEqual([
      "new name.ts",
      "new.ts",
      "old name.ts",
      "tracked.ts",
    ])
  })

  test("blocks dirty harness and source for selected suites but ignores unrelated docs", async () => {
    await using repository = await tmpdir({ git: true })
    await writeFile(repository.path, "packages/core/src/tool/edit.ts", "export const edit = 1\n")
    await writeFile(repository.path, "packages/deepagent-code/script/live-llm/routes.ts", "export {}\n")
    await writeFile(repository.path, "docs/note.md", "note\n")
    await git(repository.path, ["add", "."])
    await git(repository.path, ["commit", "-m", "fixtures"])
    await Bun.write(path.join(repository.path, "packages/core/src/tool/edit.ts"), "export const edit = 2\n")
    await Bun.write(
      path.join(repository.path, "packages/deepagent-code/script/live-llm/routes.ts"),
      "export const changed = true\n",
    )
    await Bun.write(path.join(repository.path, "docs/note.md"), "changed\n")

    const dirty = await readDirtyPaths(repository.path)
    expect(dirty).toEqual([
      "docs/note.md",
      "packages/core/src/tool/edit.ts",
      "packages/deepagent-code/script/live-llm/routes.ts",
    ])
    expect(blockingDirtyPaths(selectRoutes(["packages/core/src/tool/edit.ts"]), dirty)).toEqual([
      "packages/core/src/tool/edit.ts",
      "packages/deepagent-code/script/live-llm/routes.ts",
    ])
  })
})

describe("pre-push dispatcher", () => {
  test("passes only an explicit environment allowlist to pre-push subprocesses", () => {
    const hostEnvironment = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/host/home",
      SSH_AUTH_SOCK: "/host/agent.sock",
      AWS_SECRET_ACCESS_KEY: "host-secret",
      HTTPS_PROXY: "http://host-proxy.invalid",
      DATABASE_URL: "postgres://host-secret",
      DEEPSEEK_API_KEY: "ambient-key",
    }
    expect(prePushEnvironment(hostEnvironment)).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" })
    const live = prePushEnvironment(hostEnvironment, {
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      apiKey: "in-memory-key",
      apiKeyFile: "/secure/live-llm.key",
      timeoutMs: 120_000,
      artifactDirectory: "/isolated/artifacts",
    })
    expect(live.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE).toBe("/secure/live-llm.key")
    expect(JSON.stringify(live)).not.toContain("in-memory-key")
    expect(live.DEEPSEEK_API_KEY).toBeUndefined()
  })

  test("registers the production multi-agent extended runs", () => {
    const cases = [
      ["live-llm-multi-agent-dag-harness", "ext:legacy-session:multi-agent-dag"],
      ["live-llm-multi-agent-parallel-worktrees-harness", "ext:legacy-session:multi-agent-parallel-worktrees"],
      ["live-llm-multi-agent-pr-collaboration-harness", "ext:legacy-session:multi-agent-pr-collaboration"],
      ["live-llm-v4-multi-agent-runtime-harness", "ext:v4-event-runtime:v4-multi-agent-runtime"],
    ] as const

    for (const [id, key] of cases) {
      const route = routeManifest.find((item) => item.id === id)
      expect(route).toBeDefined()
      const runs = route?.runs ?? []
      expect(runs.map(modelRunKey)).toEqual([key])
      expect(route?.checks).toContain("tool-bash-sandbox")
      expect(runs[0] && commandForModelRun(runs[0])).toBeDefined()
    }
  })

  test("keeps the direct V4 runtime suite reachable from every durable execution seam", () => {
    for (const path of [
      "packages/core/src/deepagent/agent-execution.ts",
      "packages/core/src/deepagent/event-router.ts",
      "packages/deepagent-code/src/session/agent-handoff-consumer.ts",
      "packages/deepagent-code/src/session/agent-worktree.ts",
      "packages/deepagent-code/src/session/multi-agent-runtime.ts",
      "packages/deepagent-code/src/session/v4-event-runtime.ts",
    ]) {
      const selected = selectRoutes([path])
      expect(selected.runs.map(modelRunKey)).toContain("ext:v4-event-runtime:v4-multi-agent-runtime")
      expect(
        commandForModelRun(
          selected.runs.find((run) => modelRunKey(run) === "ext:v4-event-runtime:v4-multi-agent-runtime")!,
        ),
      ).toBeDefined()
    }
  })

  test("keeps prompt intent fencing reachable from admission, revert, and renderer seams", () => {
    for (const path of [
      "packages/app/src/components/prompt-input/submit.ts",
      "packages/app/src/pages/session/followup-submission.ts",
      "packages/core/src/database/migration/20260806051000_session_prompt_intent.ts",
      "packages/core/src/database/migration/20260806060000_session_mutation_epoch.ts",
      "packages/deepagent-code/src/session/prompt-intent.ts",
      "packages/deepagent-code/src/session/revert.ts",
      "packages/deepagent-code/script/live-llm/prompt-intent-fencing.ts",
    ]) {
      const selected = selectRoutes([path])
      const run = selected.runs.find((item) => modelRunKey(item) === "ext:legacy-session:prompt-intent-fencing")
      expect(run).toBeDefined()
      expect(selected.checks).toContain("prompt-intent")
      expect(run && commandForModelRun(run)).toEqual({
        cwd: "packages/deepagent-code",
        args: ["bun", "run", "test:llm-ext:prompt-intent-fencing"],
      })
    }
  })

  test("maps every automatically selectable live run to a package command", () => {
    const runs = selectRoutes([
      "packages/llm/src/providers/openai-compatible.ts",
      "packages/core/src/tool/registry.ts",
      "packages/deepagent-code/src/session/prompt.ts",
      "packages/deepagent-code/src/tool/task.ts",
    ]).runs.filter((run) => run.mode === "live")

    expect(runs.length).toBeGreaterThan(0)
    expect(runs.every((run) => commandForModelRun(run) !== undefined)).toBe(true)
    // Unqualified runs still have commands; only promoted live-mode suites leave the pre-push gate.
    expect(unqualifiedRuns(runs).every((run) => commandForModelRun(run) !== undefined)).toBe(true)
    expect([...qualifiedLiveRuns]).toEqual([])
    expect(
      unqualifiedRuns([
        { mode: "live", stack: "legacy-session", suite: "structured-output" },
        { mode: "ext", stack: "legacy-session", suite: "compaction-retention" },
        { mode: "ext", stack: "legacy-session", suite: "intelligence-draft-confirmation" },
        { mode: "live", stack: "legacy-session", suite: "shell-exit-contract" },
      ]).map(modelRunKey),
    ).toEqual(["live:legacy-session:structured-output", "live:legacy-session:shell-exit-contract"])
  })

  test("deduplicates deterministic commands selected by overlapping checks", () => {
    const commands = commandsForChecks(["permission", "mcp", "permission"])
    expect(
      commands.filter((item) => item.cwd === "packages/deepagent-code" && item.args[1] === "typecheck"),
    ).toHaveLength(1)
    expect(commands.some((item) => item.args.includes("test/permission/next.test.ts"))).toBe(true)
    expect(commands.some((item) => item.args.includes("test/question/question.test.ts"))).toBe(true)
    expect(commands.some((item) => item.args.includes("test/mcp"))).toBe(true)
  })

  test("dispatches the C1, D1b, D2/E1, and D3 deterministic evidence checks", () => {
    const commands = commandsForChecks(["session-continuation", "worktree-routing", "goal-loop", "expert-panel"])
    expect(commands.some((item) => item.args.includes("World State"))).toBe(true)
    expect(commands.some((item) => item.args.includes("runs a prompt in the persisted session directory"))).toBe(true)
    expect(commands.some((item) => item.args.includes("persists the canonical worktree directory"))).toBe(true)
    expect(commands.some((item) => item.args.includes("test/deepagent/goal-loop.test.ts"))).toBe(true)
    expect(commands.some((item) => item.args.includes("test/script/live-llm-goal-cli-oracle.test.ts"))).toBe(true)
    expect(commands.some((item) => item.args.includes("test/script/live-llm-expert-panel-oracle.test.ts"))).toBe(true)
  })

  test("fails closed when a pushed owning source has no manifest rule", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    const remoteOID = await revParse(repository.path, "HEAD")
    const localOID = await commitFile(
      repository.path,
      "packages/core/src/tool/not-classified.ts",
      "export const value = 1\n",
    )

    await expect(
      createPrePushPlan({
        repository: repository.path,
        remote: "origin",
        stdin: `refs/heads/dev ${localOID} refs/heads/dev ${remoteOID}`,
      }),
    ).rejects.toThrow("Unclassified live LLM owning paths")
  })

  test("fails closed when dirty source can affect a selected run", async () => {
    await using repository = await tmpdir({ git: true })
    await using remote = await tmpdir()
    await configureRemote(repository.path, remote.path)
    const remoteOID = await revParse(repository.path, "HEAD")
    const localOID = await commitFile(repository.path, "packages/core/src/tool/edit.ts", "export const edit = 1\n")
    await Bun.write(path.join(repository.path, "packages/core/src/tool/edit.ts"), "export const edit = 2\n")

    await expect(
      createPrePushPlan({
        repository: repository.path,
        remote: "origin",
        stdin: `refs/heads/dev ${localOID} refs/heads/dev ${remoteOID}`,
      }),
    ).rejects.toThrow("Dirty files can affect the selected live LLM plan")
  })

  test("terminates a timed-out command and its descendant process", async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "descendant-survived.txt")
    const script = path.join(directory.path, "parent.ts")
    await Bun.write(
      script,
      [
        `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(500); await Bun.write(${JSON.stringify(marker)}, "leaked")`)}])`,
        "await child.exited",
      ].join("\n"),
    )

    await expect(
      runPrePushCommand([process.execPath, "run", script], directory.path, Date.now() + 100),
    ).rejects.toThrow("budget")
    await Bun.sleep(700)
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})

async function configureRemote(repository: string, remote: string) {
  await git(repository, ["branch", "-M", "dev"])
  await git(remote, ["init", "--bare"])
  await git(repository, ["remote", "add", "origin", remote])
  await git(repository, ["push", "-u", "origin", "dev"])
}

async function commitFile(repository: string, file: string, contents: string) {
  await writeFile(repository, file, contents)
  await git(repository, ["add", "--", file])
  await git(repository, ["commit", "-m", file])
  return revParse(repository, "HEAD")
}

async function writeFile(repository: string, file: string, contents: string) {
  await mkdir(path.dirname(path.join(repository, file)), { recursive: true })
  await Bun.write(path.join(repository, file), contents)
}

async function revParse(repository: string, revision: string) {
  return (await git(repository, ["rev-parse", revision])).stdout.trim()
}

async function git(repository: string, args: string[], allowFailure = false) {
  const process = Bun.spawn(["git", ...args], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (${exitCode}): ${stderr.trim() || "no stderr"}`)
  }
  return { stdout, stderr, success: exitCode === 0 }
}
