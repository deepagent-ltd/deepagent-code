import { afterAll, describe, expect } from "bun:test"
import { count, eq } from "drizzle-orm"
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
import { SessionInputTable, SessionTable, TaskRunTable } from "@deepagent-code/core/session/sql"
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
})

// ── Child-Location write stack (real built-in write tool against a Location root) ─────────────

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
