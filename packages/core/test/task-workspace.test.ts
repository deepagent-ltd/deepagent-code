import { afterAll, describe, expect } from "bun:test"
import { and, count, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FileMutation } from "@deepagent-code/core/file-mutation"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Location } from "@deepagent-code/core/location"
import { LocationMutation } from "@deepagent-code/core/location-mutation"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { EventTaskWorkspaceTable, SessionInputTable, SessionTable, TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { WriteTool } from "@deepagent-code/core/tool/write"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"
import { tmpRoot, tmpRootShared } from "./fixture/tmpdir"

// Core-native TaskWorkspace (write-isolated task runs): deterministic derivation, the durable
// preflight receipt as the child-start fence, terminal-fenced release, and fail-closed git
// handling — all against real temp git repositories.

// Redirect the deterministic worktree layout's data root into scratch space for this file.
const dataRoot = tmpRootShared()
const priorTestHome = process.env.DEEPAGENT_CODE_TEST_HOME
const priorDataHome = process.env.DEEPAGENT_CODE_HOME
process.env.DEEPAGENT_CODE_TEST_HOME = dataRoot
process.env.DEEPAGENT_CODE_HOME = dataRoot
afterAll(() => {
  if (priorTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = priorTestHome
  if (priorDataHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = priorDataHome
})

const stackOver = (database: Layer.Layer<Database.Service, unknown>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(Project.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projector, sessions)
}

const it = testEffect(stackOver(Database.layerFromPath(":memory:")))

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    events: yield* EventV2.Service,
    sessions: yield* SessionV2.Service,
  }
})

// ── Real git fixtures ─────────────────────────────────────────────────────────────────────────

const gitIn = (cwd: string, args: string[]) =>
  Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })

const makeRepo = async (root: string) => {
  await fs.mkdir(root, { recursive: true })
  expectExit0(gitIn(root, ["init", "-b", "main"]), "git init")
  gitIn(root, ["config", "user.email", "test@deepagent.local"])
  gitIn(root, ["config", "user.name", "DeepAgent Test"])
  await fs.writeFile(path.join(root, "README.md"), "# fixture repo\n")
  expectExit0(gitIn(root, ["add", "-A"]), "git add")
  expectExit0(gitIn(root, ["commit", "-m", "init"]), "git commit")
  return fs.realpath(root)
}

function expectExit0(proc: ReturnType<typeof gitIn>, what: string) {
  if (proc.exitCode !== 0) throw new Error(`${what} failed: ${proc.stderr.toString()}`)
}

const repoHead = (repo: string) => gitIn(repo, ["rev-parse", "HEAD"]).stdout.toString().trim()

const worktreePaths = (repo: string) =>
  gitIn(repo, ["worktree", "list", "--porcelain"])
    .stdout.toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())

const porcelainStatus = (repo: string) => gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()

const specFor = (
  parentSessionID: SessionSchema.ID,
  toolCallID: string,
  directory: string,
  workspace?: "worktree",
) => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode: "foreground" as const,
  prompt: new Prompt({ text: "Do the isolated work." }),
  agent: "general",
  child: {
    title: `task: ${toolCallID}`,
    location: { directory: AbsolutePath.make(directory) },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
    ...(workspace === undefined ? {} : { workspace: { mode: "worktree" as const } }),
  },
})

const runRow = (db: testDb, runID: string) =>
  db
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, runID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row === undefined ? Effect.die(`task_run missing: ${runID}`) : Effect.succeed(row))),
    )

const childSessions = (db: testDb, parentID: SessionSchema.ID) =>
  db.select().from(SessionTable).where(eq(SessionTable.parent_id, parentID)).all().pipe(Effect.orDie)

type testDb = Database.Interface["db"]

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe("Core V2 TaskWorkspace", () => {
  it.effect("derive is pure and stable; prepare derives the same branch/directory and adopts exact retries", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const left = TaskWorkspace.derive({ repositoryRoot: repo, operationKey: "ses_task_derive_check" })
      const right = TaskWorkspace.derive({ repositoryRoot: repo, operationKey: "ses_task_derive_check" })
      expect(left).toEqual(right)
      expect(left.branch.startsWith("deepagent-code/task-")).toBeTrue()
      expect(left.directory.startsWith(path.join(dataRoot, "worktree", "durable"))).toBeTrue()

      const { db, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
      const spec = specFor(parent.id, "call-ws-derive-1", repo, "worktree")
      const admitted = yield* TaskRunAuthority.admitRun(db, spec)

      const frozen = yield* runRow(db, admitted.run.runID)
      expect(frozen.workspace_mode).toBe("worktree")
      expect(frozen.workspace_owner).toBe("run")
      expect(frozen.workspace_visibility).toBe("base_commit")
      expect(frozen.mutation_capability).toBe("write")
      expect(frozen.workspace_preflight_state).toBe("pending")

      const head = repoHead(repo)
      const receipt = yield* TaskWorkspace.prepare(db, {
        runID: admitted.run.runID,
        parentDirectory: repo,
      })
      const derived = TaskWorkspace.derive({
        repositoryRoot: repo,
        operationKey: admitted.run.childSessionID,
      })
      expect(receipt.baseCommit).toBe(head)
      expect(receipt.branch).toBe(derived.branch)
      // The receipt records the canonical (git-registered) spelling of the derived directory.
      expect(receipt.directory).toBe(
        path.join(realpathSync(path.dirname(derived.directory)), path.basename(derived.directory)),
      )
      expect(receipt.parentBranch).toBe("main")
      expect(receipt.derivation).toContain("deepagent-code/task-")
      expect(worktreePaths(repo)).toContain(receipt.directory)
      yield* Effect.promise(() => fs.access(path.join(receipt.directory, "README.md")))

      const ready = yield* runRow(db, admitted.run.runID)
      expect(ready.workspace_preflight_state).toBe("ready")
      expect(ready.worktree_state).toBe("ready")
      expect(ready.workspace_branch_state).toBe("ready")
      expect(ready.workspace_target_branch).toBe(receipt.branch)
      expect(ready.workspace_base_commit).toBe(head)
      expect(ready.workspace_repository_root).toBe(repo)

      // Exact re-prepare (crash between receipt and child start) adopts: same receipt, one worktree.
      const again = yield* TaskWorkspace.prepare(db, { runID: admitted.run.runID, parentDirectory: repo })
      expect(again).toEqual(receipt)
      expect(worktreePaths(repo)).toHaveLength(2)

      // Crash between the started marker and the ready CAS: re-prepare adopts the physical worktree.
      yield* db
        .update(TaskRunTable)
        .set({
          workspace_preflight_state: "pending",
          workspace_branch_state: "admitting",
          worktree_state: "admitting",
        })
        .where(eq(TaskRunTable.run_id, admitted.run.runID))
        .run()
        .pipe(Effect.orDie)
      const recovered = yield* TaskWorkspace.prepare(db, { runID: admitted.run.runID, parentDirectory: repo })
      expect(recovered).toEqual(receipt)
      expect(worktreePaths(repo)).toHaveLength(2)
    }),
  )

  it.effect("child session creation and input admission refuse until the preflight receipt is ready", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
      const spec = specFor(parent.id, "call-ws-fence-1", repo, "worktree")
      const admitted = yield* TaskRunAuthority.admitRun(db, spec)

      const createRefused = yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, admitted.run).pipe(
        Effect.flip,
      )
      expect(createRefused).toMatchObject({
        _tag: "TaskWorkspace.PreflightNotReady",
        preflightState: "pending",
      })
      const children = yield* childSessions(db, parent.id)
      expect(children).toHaveLength(0)

      const inputRefused = yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt).pipe(
        Effect.flip,
      )
      expect(inputRefused).toMatchObject({ _tag: "TaskWorkspace.PreflightNotReady" })
      const inputs = yield* db
        .select({ total: count() })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, admitted.run.childSessionID))
        .get()
        .pipe(Effect.orDie)
      expect(inputs?.total).toBe(0)

      // The executor's claim CAS is a second fence: input_state cannot be ready without the receipt.
      const claimRefused = yield* TaskRunAuthority.claim(db, {
        runID: admitted.run.runID,
        ownerToken: "owner-ws-fence",
        leaseMs: 60_000,
        now: 1_000,
      }).pipe(Effect.flip)
      expect(claimRefused).toMatchObject({ _tag: "TaskRunAuthority.ClaimLost" })

      // After prepare: the child is created AT the worktree location and the input admits once.
      const receipt = yield* TaskWorkspace.prepare(db, { runID: admitted.run.runID, parentDirectory: repo })
      yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, admitted.run)
      const created = yield* childSessions(db, parent.id)
      expect(created).toHaveLength(1)
      expect(created[0]?.directory).toBe(receipt.directory)
      const ready = yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt)
      expect(ready.inputState).toBe("ready")
    }),
  )

  it.effect("submit on a real repo: branch at the recorded HEAD commit, worktree content, parent untouched", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const headBefore = repoHead(repo)
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })

      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-ws-flow-1", repo, "worktree"))
      expect(submitted.run.inputState).toBe("ready")

      const row = yield* runRow(db, submitted.run.runID)
      expect(row.workspace_preflight_state).toBe("ready")
      expect(row.workspace_base_commit).toBe(headBefore)
      const branchTip = gitIn(repo, ["rev-parse", `refs/heads/${row.worktree_branch}`]).stdout.toString().trim()
      expect(branchTip).toBe(headBefore)
      expect(worktreePaths(repo)).toContain(row.worktree_directory!)
      yield* Effect.promise(() => fs.access(path.join(row.worktree_directory!, "README.md")))

      const children = yield* childSessions(db, parent.id)
      expect(children).toHaveLength(1)
      expect(children[0]?.directory).toBe(row.worktree_directory!)

      // The parent checkout is never mutated: same HEAD, same branch, clean tree.
      expect(repoHead(repo)).toBe(headBefore)
      expect(gitIn(repo, ["symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).toBe("main")
      expect(porcelainStatus(repo)).toBe("")
    }),
  )

  it.effect("release refuses in-flight runs, prunes after terminal settle, and stays idempotent", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-ws-rel-1", repo, "worktree"))
      const directory = (yield* runRow(db, submitted.run.runID)).worktree_directory!

      const inFlight = yield* TaskWorkspace.release(db, { runID: submitted.run.runID }).pipe(Effect.flip)
      expect(inFlight).toMatchObject({ _tag: "TaskWorkspace.Error", code: "not_terminal" })
      expect(worktreePaths(repo)).toContain(directory)

      const claimed = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-ws-rel",
        leaseMs: 60_000,
        now: 1_000,
      })
      yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-ws-rel",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "done",
        output: "result",
        now: 2_000,
      })

      const released = yield* TaskWorkspace.release(db, { runID: submitted.run.runID })
      expect(released.released).toBeTrue()
      expect(worktreePaths(repo)).not.toContain(directory)
      yield* Effect.promise(() =>
        fs.stat(directory).then(
          () => {
            throw new Error("worktree directory survived release")
          },
          () => undefined,
        ),
      )
      // The branch is retained for the later PR/merge flow, still at the recorded base commit.
      const retained = yield* runRow(db, submitted.run.runID)
      const branchTip = gitIn(repo, ["rev-parse", `refs/heads/${retained.worktree_branch}`]).stdout.toString().trim()
      expect(branchTip).toBe(retained.workspace_base_commit!)

      const again = yield* TaskWorkspace.release(db, { runID: submitted.run.runID })
      expect(again.released).toBeTrue()
      const settledRow = yield* runRow(db, submitted.run.runID)
      expect(settledRow.worktree_state).toBe("removed")
    }),
  )

  it.effect("git failure marks the preflight failed with the error code; no child; retry fails closed", () =>
    Effect.gen(function* () {
      const notARepo = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot(), "not-a-repo-")).then((dir) => fs.realpath(dir)))
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
      const spec = specFor(parent.id, "call-ws-fail-1", notARepo, "worktree")
      const admitted = yield* TaskRunAuthority.admitRun(db, spec)

      const failure = yield* TaskWorkspace.prepare(db, {
        runID: admitted.run.runID,
        parentDirectory: notARepo,
      }).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "TaskWorkspace.Error", code: "git_failed" })

      const row = yield* runRow(db, admitted.run.runID)
      expect(row.workspace_preflight_state).toBe("failed")
      expect(row.workspace_preflight_error_code).toBe("git_failed")

      const refused = yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, admitted.run).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "TaskWorkspace.PreflightNotReady", preflightState: "failed" })
      expect(yield* childSessions(db, parent.id)).toHaveLength(0)
      const inputRefused = yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt).pipe(
        Effect.flip,
      )
      expect(inputRefused).toMatchObject({ _tag: "TaskWorkspace.PreflightNotReady", preflightState: "failed" })

      const retry = yield* TaskWorkspace.prepare(db, { runID: admitted.run.runID, parentDirectory: notARepo }).pipe(
        Effect.flip,
      )
      expect(retry).toMatchObject({ _tag: "TaskWorkspace.Error", code: "preflight_failed" })
    }),
  )

  it.effect("E2E: isolated child roots at the worktree; a write tool effect lands inside, never the parent", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const headBefore = repoHead(repo)
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-ws-e2e-1", repo, "worktree"))
      const childDirectory = (yield* runRow(db, submitted.run.runID)).worktree_directory!

      // The child's write tool runs through the SAME Location-rooted services the runner would
      // build for the child session: every path resolves inside the worktree.
      const written = yield* Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const materialized = yield* registry.materialize()
        const settled = yield* materialized.settle({
          sessionID: submitted.run.childSessionID,
          agent: AgentV2.ID.make("general"),
          assistantMessageID: SessionMessage.ID.make("msg_ws_e2e_write"),
          call: {
            type: "tool-call" as const,
            id: "call-ws-e2e-write",
            name: "write",
            input: { path: "notes/landing.txt", content: "landed in worktree" },
          },
        })
        return settled.result
      }).pipe(Effect.provide(writeStack(childDirectory)))
      expect(written.type).not.toBe("error")

      const landed = yield* Effect.promise(() => fs.readFile(path.join(childDirectory, "notes", "landing.txt"), "utf8"))
      expect(landed).toBe("landed in worktree")
      yield* Effect.promise(() =>
        fs
          .access(path.join(repo, "notes", "landing.txt"))
          .then(() => {
            throw new Error("write escaped the worktree into the parent checkout")
          })
          .catch(() => undefined),
      )
      expect(porcelainStatus(repo)).toBe("")
      expect(repoHead(repo)).toBe(headBefore)

      // The authority executor drains the child, settles once, and releases the workspace.
      const result = yield* TaskRunAuthority.execute({
        db,
        run: submitted.run,
        sessions,
        timeoutMs: 5_000,
      })
      expect(result.outcome).toBe("completed")
      const receipts = yield* db
        .select({ total: count() })
        .from(V2TaskRunReceiptTable)
        .where(eq(V2TaskRunReceiptTable.run_id, submitted.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(receipts?.total).toBe(1)
      const settled = yield* runRow(db, submitted.run.runID)
      expect(settled.state).toBe("completed")
      expect(settled.worktree_state).toBe("removed")
      expect(worktreePaths(repo)).not.toContain(childDirectory)
    }),
  )

  // Live clock: the executor's timeout is wall-clock; under TestClock it would never fire.
  it.live("timeout retains the isolated worktree instead of releasing it (WS4b-S2)", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
      const submitted = yield* TaskRunAuthority.submit(
        db,
        events,
        sessions,
        specFor(parent.id, "call-ws-timeout-1", repo, "worktree"),
      )
      const worktreeDirectory = (yield* runRow(db, submitted.run.runID)).worktree_directory!

      // A child whose drain never finishes forces the timeout path.
      const result = yield* TaskRunAuthority.execute({
        db,
        run: submitted.run,
        sessions: { ...sessions, resume: () => Effect.never },
        timeoutMs: 50,
      })
      expect(result.outcome).toBe("timeout")

      const settled = yield* runRow(db, submitted.run.runID)
      expect(settled.state).toBe("failed")
      expect(settled.reason).toBe("task_timeout")
      expect(settled.worktree_state).toBe("retained")

      // The child stays resumable by task_id: the worktree directory and branch survive on disk.
      yield* Effect.promise(() => fs.access(worktreeDirectory))
      expect(worktreePaths(repo)).toContain(worktreeDirectory)
      expect(gitIn(repo, ["show-ref", "--verify", `refs/heads/${settled.worktree_branch!}`]).exitCode).toBe(0)

      const retained = yield* db
        .select({ total: count() })
        .from(TaskRunEventTable)
        .where(and(eq(TaskRunEventTable.run_id, submitted.run.runID), eq(TaskRunEventTable.type, "worktree_retained")))
        .get()
        .pipe(Effect.orDie)
      expect(retained?.total).toBe(1)
    }),
  )
})

// ── C-P2-08 startup reclamation of stale retained worktrees ───────────────────────────────────

/** One terminal retained worktree run at a settled epoch, in a real repo: the sweep's input. */
const retainedRun = (
  db: testDb,
  events: EventV2.Interface,
  sessions: SessionV2.Interface,
  repo: string,
  toolCallID: string,
) =>
  Effect.gen(function* () {
    const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
    const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, toolCallID, repo, "worktree"))
    const claimed = yield* TaskRunAuthority.claim(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      leaseMs: 60_000,
      now: 1_000,
    })
    yield* TaskRunAuthority.settle(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      claimGeneration: claimed.claimGeneration,
      state: "failed",
      reason: "task_timeout",
      error: { code: "task_timeout", message: "timed out" },
      now: 2_000,
    })
    yield* TaskWorkspace.retain(db, { runID: submitted.run.runID })
    return yield* runRow(db, submitted.run.runID)
  })

describe("Core V2 TaskWorkspace stale-worktree reclamation (C-P2-08)", () => {
  it.effect("terminal retention past the grace reclaims worktree AND branch; within the grace nothing is touched", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      const settled = yield* retainedRun(db, events, sessions, repo, "call-ws-rc-1")
      const directory = settled.worktree_directory!
      const branch = settled.worktree_branch!

      // One millisecond before the grace expires: not even scanned.
      const within = yield* TaskWorkspace.reclaimStale(db, {
        now: 2_000 + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS - 1,
      })
      expect(within.scanned).toBe(0)
      yield* Effect.promise(() => fs.access(directory))
      expect(worktreePaths(repo)).toContain(directory)
      expect(gitIn(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).exitCode).toBe(0)

      // At and past the grace boundary: reclaimed (directory + branch deleted, receipt settled).
      const report = yield* TaskWorkspace.reclaimStale(db, { now: 2_000 + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS })
      expect(report).toMatchObject({ scanned: 1, reclaimed: 1, failed: [] })
      const reclaimed = yield* runRow(db, settled.run_id)
      expect(reclaimed.worktree_state).toBe("reclaimed")
      expect(worktreePaths(repo)).not.toContain(directory)
      yield* Effect.promise(() =>
        fs.stat(directory).then(
          () => {
            throw new Error("worktree directory survived reclamation")
          },
          () => undefined,
        ),
      )
      expect(gitIn(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).exitCode).not.toBe(0)
      const reclaimedEvents = yield* db
        .select({ total: count() })
        .from(TaskRunEventTable)
        .where(and(eq(TaskRunEventTable.run_id, settled.run_id), eq(TaskRunEventTable.type, "worktree_reclaimed")))
        .get()
        .pipe(Effect.orDie)
      expect(reclaimedEvents?.total).toBe(1)

      // Idempotent: a second sweep finds nothing (the receipt is terminal).
      const again = yield* TaskWorkspace.reclaimStale(db, { now: 2_000 + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS })
      expect(again.scanned).toBe(0)
    }),
  )

  it.effect("recovery_required runs are never reclaimed, however old", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      const settled = yield* retainedRun(db, events, sessions, repo, "call-ws-rc-2")
      yield* db
        .update(TaskRunTable)
        .set({ state: "recovery_required" })
        .where(eq(TaskRunTable.run_id, settled.run_id))
        .run()
        .pipe(Effect.orDie)

      const report = yield* TaskWorkspace.reclaimStale(db, {
        now: 2_000 + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS * 10,
      })
      expect(report.scanned).toBe(0)
      const untouched = yield* runRow(db, settled.run_id)
      expect(untouched.worktree_state).toBe("retained")
      yield* Effect.promise(() => fs.access(untouched.worktree_directory!))
      expect(gitIn(repo, ["show-ref", "--verify", `refs/heads/${untouched.worktree_branch!}`]).exitCode).toBe(0)
    }),
  )

  it.effect("non-run-owned, non-isolated, and v1 rows are never touched", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      // Three debt shapes that LOOK like retention but are not run-owned V2 isolation: a
      // caller-owned worktree receipt, a shared-workspace row, and a v1 runtime row.
      const owner = yield* retainedRun(db, events, sessions, repo, "call-ws-rc-3a")
      yield* db
        .update(TaskRunTable)
        .set({ workspace_owner: "caller" })
        .where(eq(TaskRunTable.run_id, owner.run_id))
        .run()
        .pipe(Effect.orDie)
      const shared = yield* retainedRun(db, events, sessions, repo, "call-ws-rc-3b")
      yield* db
        .update(TaskRunTable)
        .set({ workspace_mode: "shared" })
        .where(eq(TaskRunTable.run_id, shared.run_id))
        .run()
        .pipe(Effect.orDie)
      const legacy = yield* retainedRun(db, events, sessions, repo, "call-ws-rc-3c")
      yield* db
        .update(TaskRunTable)
        .set({ execution_runtime: "v1" })
        .where(eq(TaskRunTable.run_id, legacy.run_id))
        .run()
        .pipe(Effect.orDie)

      const report = yield* TaskWorkspace.reclaimStale(db, { now: 2_000 + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS })
      expect(report.scanned).toBe(0)
      for (const row of [owner, shared, legacy]) {
        const kept = yield* runRow(db, row.run_id)
        expect(kept.worktree_state).toBe("retained")
        const directory = kept.worktree_directory
        if (directory !== null) yield* Effect.promise(() => fs.access(directory))
      }
      // The one run-owned V2 worktree in the same repo IS reclaimed — the predicates select.
      const eligible = yield* retainedRun(db, events, sessions, repo, "call-ws-rc-3d")
      const selected = yield* TaskWorkspace.reclaimStale(db, { now: 2_000 + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS })
      expect(selected.reclaimed).toBe(1)
      expect((yield* runRow(db, eligible.run_id)).worktree_state).toBe("reclaimed")
    }),
  )
})

// ── Child-Location write stack (real built-in write tool against a Location root) ─────────────

describe("event subtask TaskWorkspace receipts", () => {
  it.effect("duplicate prepares adopt one receipt while successive owner generations stay isolated", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "event-owner-repo")))
      const { db } = yield* services
      const identity = { eventID: "evt_double_owner", taskID: "evt_double_owner:fix" }
      const [first, duplicate] = yield* Effect.all([
        TaskWorkspace.prepareEvent(db, { ...identity, generation: 1, parentDirectory: repo, now: 1_000 }),
        TaskWorkspace.prepareEvent(db, { ...identity, generation: 1, parentDirectory: repo, now: 1_000 }),
      ], { concurrency: 2 })
      expect(duplicate).toEqual(first)
      const successor = yield* TaskWorkspace.prepareEvent(db, {
        ...identity, generation: 2, parentDirectory: repo, now: 1_100,
      })
      expect(successor.directory).not.toBe(first.directory)
      expect(successor.branch).not.toBe(first.branch)
      expect(worktreePaths(repo)).toContain(first.directory)
      expect(worktreePaths(repo)).toContain(successor.directory)
      yield* Effect.promise(() => fs.writeFile(path.join(first.directory, "owner-one.txt"), "owner one\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(successor.directory, "owner-two.txt"), "owner two\n"))
      const settled = yield* Effect.all([
        TaskWorkspace.settleEvent(db, { ...identity, generation: 1, now: 2_000 }),
        TaskWorkspace.settleEvent(db, { ...identity, generation: 2, now: 2_000 }),
      ], { concurrency: 2 })
      expect(settled[0].continuationRef).not.toBe(settled[1].continuationRef)
      expect(gitIn(repo, ["show", `${settled[0].continuationRef}:owner-one.txt`]).exitCode).toBe(0)
      expect(gitIn(repo, ["show", `${settled[1].continuationRef}:owner-two.txt`]).exitCode).toBe(0)
      expect((yield* TaskWorkspace.reclaimStale(db, { now: 5_000, retentionMs: 3_000 })).reclaimed).toBe(2)
    }),
  )

  it.effect("adopts a crash-window worktree, freezes its base, and reclaims both generations", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "event-repo")))
      const { db } = yield* services
      const firstKey = { eventID: "evt_event_workspace", taskID: "evt_event_workspace:fix", generation: 1 }
      const first = yield* TaskWorkspace.prepareEvent(db, { ...firstKey, parentDirectory: repo, now: 1_000 })
      expect(first.operationKey).toBe(`${firstKey.eventID}:${firstKey.taskID}`)
      expect(first.branch).toStartWith("deepagent-code/event-")
      expect((yield* db.select().from(EventTaskWorkspaceTable).all()).map((row) => row.state)).toEqual(["ready"])
      yield* db.update(EventTaskWorkspaceTable).set({ state: "pending" }).run().pipe(Effect.orDie)
      const adopted = yield* TaskWorkspace.prepareEvent(db, {
        ...firstKey, parentDirectory: repo, baseRef: "missing-ref-must-not-be-resolved", now: 1_100,
      })
      expect(adopted).toEqual(first)
      yield* TaskWorkspace.requireEventAdmissible(db, firstKey)
      yield* Effect.promise(() => fs.writeFile(path.join(first.directory, "fix.txt"), "fixed\n"))
      const settled = yield* TaskWorkspace.settleEvent(db, { ...firstKey, now: 2_000 })
      expect(settled.continuationRef).toBe(first.branch)
      expect((yield* TaskWorkspace.settleEvent(db, { ...firstKey, now: 2_100 })).continuationRef).toBe(first.branch)

      const nextKey = { eventID: firstKey.eventID, taskID: `${firstKey.eventID}:test`, generation: 2 }
      const next = yield* TaskWorkspace.prepareEvent(db, {
        ...nextKey, parentDirectory: repo, baseRef: settled.continuationRef, now: 3_000,
      })
      expect(next.directory).not.toBe(first.directory)
      expect(yield* Effect.promise(() => fs.readFile(path.join(next.directory, "fix.txt"), "utf8"))).toBe("fixed\n")
      yield* TaskWorkspace.settleEvent(db, { ...nextKey, now: 4_000 })
      expect((yield* TaskWorkspace.reclaimStale(db, { now: 3_999, retentionMs: 3_000 })).reclaimed).toBe(0)
      const reclaimed = yield* TaskWorkspace.reclaimStale(db, { now: 7_000, retentionMs: 3_000 })
      expect(reclaimed).toMatchObject({ scanned: 2, reclaimed: 2, failed: [] })
      expect((yield* db.select().from(EventTaskWorkspaceTable).all()).map((row) => row.state)).toEqual([
        "reclaimed", "reclaimed",
      ])
      expect(worktreePaths(repo)).not.toContain(first.directory)
      expect(worktreePaths(repo)).not.toContain(next.directory)
    }),
  )
})

const allowPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const writeStack = (directory: string) => {
  const filesystem = FSUtil.defaultLayer
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(allowPermission),
    Layer.provide(ApplicationTools.layer),
    Layer.provide(ToolOutputStore.defaultLayer),
  )
  return Layer.mergeAll(
    registry,
    WriteTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))),
      Layer.provide(FileMutation.layer.pipe(Layer.provide(filesystem))),
      Layer.provide(filesystem),
      Layer.provide(allowPermission),
    ),
    filesystem,
    activeLocation,
  )
}
