import { expect } from "bun:test"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { LLMEvent } from "@deepagent-code/llm"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentLearningAdmissionOutbox } from "@deepagent-code/core/deepagent/learning-admission-outbox"
import { LearningAdmissionOutboxTable } from "@deepagent-code/core/deepagent/learning-admission-outbox.sql"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Global } from "@deepagent-code/core/global"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

it.effect("keeps model reviewer dispatch opt-in for release safety", () =>
  Effect.sync(() => {
    expect(DurableLearningRuntime.learningReviewerProviderEnabled(undefined)).toBe(false)
    expect(DurableLearningRuntime.learningReviewerProviderEnabled("false")).toBe(false)
    expect(DurableLearningRuntime.learningReviewerProviderEnabled("true")).toBe(true)
  }),
)

it.effect("admits learning only for root user sessions", () =>
  Effect.sync(() => {
    const root = {
      id: SessionSchema.ID.make("ses_learning_root"),
      parentId: null,
      agent: "build",
      metadata: null,
    }
    expect(DurableLearningRuntime.isLearningEligibleSession(root)).toBe(true)
    expect(
      DurableLearningRuntime.isLearningEligibleSession({
        ...root,
        id: SessionSchema.ID.make("ses_learning_child"),
        parentId: root.id,
      }),
    ).toBe(false)
    expect(
      DurableLearningRuntime.isLearningEligibleSession({
        ...root,
        id: SessionSchema.ID.make("ses_learning_review_attempt"),
        agent: "reviewer",
        metadata: { deepagent: { learning_reviewer_attempt_id: "review:job-1" } },
      }),
    ).toBe(false)
    expect(
      DurableLearningRuntime.isLearningEligibleSession({
        ...root,
        metadata: { deepagent: { v4_event: { correlation_id: "event-1" } } },
      }),
    ).toBe(false)
  }),
)

it.effect("requires a done Goal, its runner completion report, and a complete evidenced plan", () =>
  Effect.sync(() => {
    const plan = {
      plan_id: "plan-learning-boundary",
      session_id: "ses_learning_root",
      goal: "finish the task",
      assumptions: [],
      steps: [
        { step_id: "step-1", title: "implement", status: "done" as const },
        { step_id: "step-2", title: "verify", status: "pending" as const },
      ],
      active_step_id: null,
      created_at: "2026-09-18T00:00:00.000Z",
    }
    const activeGoal = {
      goalId: "goal-learning-boundary",
      planDocId: "doc:plan:learning-boundary",
      phase: "done" as const,
      startedAt: "2026-09-18T00:00:00.000Z",
    }
    const completionReport = {
      type: "decision",
      scope: "run:ses_learning_root",
      provenance: { source: "runner" },
      extensions: {
        goal_id: "goal-learning-boundary",
        outcome: "done",
        report_kind: "completion",
      },
    }
    const boundary = {
      plan,
      planDocId: activeGoal.planDocId,
      activeGoal,
      completionReports: [completionReport],
    }

    expect(DurableLearningRuntime.isCompletedLearningBoundary({ ...boundary, plan: null })).toBe(false)
    expect(DurableLearningRuntime.isCompletedLearningBoundary({ ...boundary, activeGoal: null })).toBe(false)
    expect(DurableLearningRuntime.isCompletedLearningBoundary({ ...boundary, completionReports: [] })).toBe(false)
    expect(DurableLearningRuntime.isCompletedLearningBoundary(boundary)).toBe(false)
    expect(
      DurableLearningRuntime.isCompletedLearningBoundary({
        ...boundary,
        plan: {
          ...plan,
          steps: plan.steps.map((step) => ({
            ...step,
            status: "done" as const,
            ...(step.step_id === "step-2" ? { acceptance: "tests pass", evidence: ["bun test: passed"] } : {}),
          })),
        },
      }),
    ).toBe(true)
  }),
)

it.effect("captures a deterministic bounded learning snapshot without command output or external paths", () =>
  Effect.sync(() => {
    const snapshot = DurableLearningRuntime.learningEvidenceSnapshot({
      activityId: "activity-evidence",
      workspacePath: "/workspace/project",
      planGoal: "  Fix   the learning boundary  ",
      documents: [
        { kind: "worklog", id: "completion", version: 3 },
        { kind: "design", id: "design-1", version: 2 },
        { kind: "requirements", id: "requirements-1", version: 1 },
      ],
      changedPaths: [
        "/workspace/project/src/z.ts",
        "/workspace/project/src/a.ts",
        "/workspace/project/src/a.ts",
        "/outside/secret.txt",
      ],
      validations: [
        {
          command: "bun test test/deepagent/learning-runtime.test.ts",
          passed: true,
          kind: "command_exit",
          exit_code: 0,
          output: "private provider output",
          duration_ms: 42,
        },
      ],
    })

    expect(snapshot).toMatchObject({
      schema_version: "deepagent-code.learning_evidence.v1",
      activity_id: "activity-evidence",
      plan_goal: "Fix the learning boundary",
      document_refs: ["design:design-1@v2", "requirements:requirements-1@v1"],
      changed_paths: ["src/a.ts", "src/z.ts"],
      validations: [{ passed: true, kind: "command_exit", exit_code: 0 }],
    })
    expect(snapshot.validations[0]?.command_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain("private provider output")
    expect(JSON.stringify(snapshot)).not.toContain("bun test")
    expect(JSON.stringify(snapshot)).not.toContain("secret.txt")
  }),
)

it.effect("keeps withheld delivery receipts recoverable", () =>
  Effect.sync(() => {
    const git = { branch: "main", head: "abc123" }
    const failed = DurableLearningRuntime.deliveryReceipt("activity-failed", git, 2, {
      kind: "validation_failed",
      files: 2,
      recoveryRef: "refs/deepagent-code/recovery/patch-failed",
    })
    expect(failed).toMatchObject({
      verdict: "withheld_validation_failed",
      recoveryRef: "refs/deepagent-code/recovery/patch-failed",
    })
    expect(DurableLearningRuntime.isLearningDeliveryVerdict(failed)).toBe(false)
    const unverified = DurableLearningRuntime.deliveryReceipt("activity-unverified", git, 1, {
      kind: "unverified",
      files: 1,
      recoveryRef: "refs/deepagent-code/recovery/patch-unverified",
    })
    expect(unverified).toMatchObject({
      verdict: "withheld_unverified",
      recoveryRef: "refs/deepagent-code/recovery/patch-unverified",
    })
    expect(DurableLearningRuntime.isLearningDeliveryVerdict(unverified)).toBe(false)
    expect(
      DurableLearningRuntime.isLearningDeliveryVerdict({
        verdict: "no_changes",
        touchedPaths: 0,
        unattributable: 0,
      }),
    ).toBe(true)
  }),
)

it.effect("ReviewerRegistry isolates registrations and finalizers between runtime roots", () =>
  Effect.gen(function* () {
    const firstScope = yield* Scope.make()
    const secondScope = yield* Scope.make()
    const firstContext = yield* Layer.build(Layer.fresh(DurableLearningRuntime.reviewerRegistryLayer)).pipe(
      Effect.provideService(Scope.Scope, firstScope),
    )
    const secondContext = yield* Layer.build(Layer.fresh(DurableLearningRuntime.reviewerRegistryLayer)).pipe(
      Effect.provideService(Scope.Scope, secondScope),
    )
    const first = Context.get(firstContext, DurableLearningRuntime.CurrentReviewerRegistry)
    const second = Context.get(secondContext, DurableLearningRuntime.CurrentReviewerRegistry)
    if (!first || !second) return yield* Effect.die("reviewer registry did not build")
    const firstReviewer = reviewer("first")
    const secondReviewer = reviewer("second")
    yield* first.register(() => firstReviewer).pipe(Effect.provideService(Scope.Scope, firstScope))
    yield* second.register(() => secondReviewer).pipe(Effect.provideService(Scope.Scope, secondScope))

    expect(first.reviewerForWorkspace("/workspace")).toBe(firstReviewer)
    expect(second.reviewerForWorkspace("/workspace")).toBe(secondReviewer)
    yield* Scope.close(firstScope, Exit.void)
    expect(second.reviewerForWorkspace("/workspace")).toBe(secondReviewer)
    yield* Scope.close(secondScope, Exit.void)
  }),
)

it.effect("DurableLearningRuntime installs record and reconcile methods for AgentGateway", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const database = Context.get(
      yield* Layer.build(Database.layerFromPath(`${root}/learning.sqlite`)),
      Database.Service,
    )
    yield* database.db.insert(ProjectTable).values({
      id: Project.ID.make("project-learning-runtime"),
      worktree: AbsolutePath.make(root),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    })
    yield* database.db.insert(SessionTable).values({
      id: SessionSchema.ID.make("ses_learning_runtime"),
      project_id: Project.ID.make("project-learning-runtime"),
      slug: "ses_learning_runtime",
      directory: root,
      title: "Learning runtime",
      version: "1",
      time_created: 1,
      time_updated: 1,
    })
    const runtimeScope = yield* Scope.make()
    yield* Layer.build(
      Layer.fresh(DurableLearningRuntime.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope))

    AgentGateway.configure({
      enabled: true,
      agentMode: "high",
      baseDir: Global.Path.agent.data,
      runsDir: Global.Path.agent.runs,
      durableLearning: true,
      selfLearning: "manual",
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => AgentGateway.configure({ enabled: false, durableLearning: false, runsDir: undefined })),
    )
    yield* AgentGateway.manageStream(
      {
        callKind: "session_turn",
        feature: "session_chat",
        providerID: "test",
        modelID: "test-model",
        sessionID: "ses_learning_runtime",
        messageID: "msg_learning_runtime",
        workspaceID: root,
      },
      Stream.make(LLMEvent.finish({ reason: "stop" })),
    ).pipe(Stream.runCollect)

    const intents = yield* DeepAgentLearningAdmissionOutbox.pending(database.db)
    expect(intents).toHaveLength(0)
    const row = yield* database.db.select().from(LearningAdmissionOutboxTable).get()
    expect(row).toMatchObject({
      state: "admitted",
      job_id: expect.any(String),
      candidate_input_ref: expect.any(String),
    })

    yield* Scope.close(runtimeScope, Exit.void)
  }),
)

function reviewer(id: string) {
  return {
    identity: () =>
      Effect.succeed({
        reviewSessionId: `session-${id}`,
        providerId: `provider-${id}`,
        modelId: `model-${id}`,
        policyHash: `policy-${id}`,
      }),
    execute: () => Effect.succeed({ verdict: "manual_review" as const, selectedCandidateIds: [] }),
  }
}
