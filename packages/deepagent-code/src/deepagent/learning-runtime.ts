export * as DurableLearningRuntime from "./learning-runtime"

import path from "node:path"
import { and, count, desc, eq, isNull, ne, notInArray, or } from "drizzle-orm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentDurableLearning } from "@deepagent-code/core/deepagent/durable-learning"
import { DeepAgentLearningLifecycleTrigger } from "@deepagent-code/core/deepagent/learning-lifecycle-trigger"
import { createInitialRoundState } from "@deepagent-code/core/deepagent/round-state"
import { writeFileAtomic } from "@deepagent-code/core/deepagent/atomic-write"
import { Global } from "@deepagent-code/core/global"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"

const pollInterval = Duration.seconds(1)

type ReviewerFactory = (workspacePath: string) => DeepAgentDurableLearning.ReviewerPort | undefined
const reviewerFactories = new Map<symbol, ReviewerFactory>()

export const registerLearningReviewerFactory = (factory: ReviewerFactory) => {
  const token = Symbol("learning-reviewer-factory")
  reviewerFactories.set(token, factory)
  return () => reviewerFactories.delete(token)
}

function reviewerForWorkspace(workspacePath: string) {
  return [...reviewerFactories.values()]
    .toReversed()
    .map((factory) => factory(workspacePath))
    .find((reviewer) => reviewer !== undefined)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const owner = `learning-worker:${process.pid}:${crypto.randomUUID()}`
    const tick = Effect.suspend(() =>
      DeepAgentDurableLearning.drain(database.db, {
        owner,
        authorityRoot: Global.Path.agent.data,
        reviewerForWorkspace,
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable learning worker tick failed", { cause: Cause.pretty(cause) }).pipe(Effect.as([])),
      ),
    )

    AgentGateway.setLearningAuthority({
      record: (admission) =>
        Effect.runPromise(DeepAgentDurableLearning.record(database.db, admission).pipe(Effect.asVoid)),
      enqueue: (admission) =>
        Effect.runPromise(
          DeepAgentDurableLearning.admit(database.db, admission, {
            authorityRoot: Global.Path.agent.data,
          }).pipe(Effect.asVoid),
        ),
    })
    DeepAgentLearningLifecycleTrigger.setRuntimeObserver({
      observe: (input) =>
        Effect.runPromise(
          DeepAgentLearningLifecycleTrigger.observe(database.db, input, {
            authorityRoot: Global.Path.agent.data,
            runsDir: Global.Path.agent.runs,
          }),
        ),
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        AgentGateway.setLearningAuthority(undefined)
        DeepAgentLearningLifecycleTrigger.setRuntimeObserver(undefined)
      }),
    )

    yield* DeepAgentLearningLifecycleTrigger.recover(database.db, { authorityRoot: Global.Path.agent.data }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable learning lifecycle recovery failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as([]),
        ),
      ),
    )
    yield* tick
    yield* tick.pipe(Effect.repeat(Schedule.spaced(pollInterval)), Effect.forkScoped)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

// ---------------------------------------------------------------------------
// W7 — settle-triggered durable learning (the SessionRunner `onSessionSettled` hook).
// A drained V2 activity is admitted as a `session_finalization` learning run: the same
// outbox → reconcile → job pipeline the legacy gateway close path drives, with:
//   - trigger   = session_finalization
//   - runID     = `v2_<activityId>` (one run per durable V2 activity)
//   - totalRounds = non-rebuild / non-isolation provider-turn receipts observed for the
//     activity (W15: `owner_mode='v2'` rows only, minus pre-dispatch rebuild abandons)
//   - roundState = initial round state (V2 has no V1 diagnoses; extraction sees the
//     first-pass/multi-round candidates only)
// W15 (P2): the admission is gated on the activity's LATEST receipt terminal state — only a
// `settled` receipt admits (finalStatus "completed"); a `failed` / `indeterminate_after_crash`
// / non-terminal activity is NOT admitted (the legacy `learningFinalStatus` contract: failed
// and unresolved runs do not enter learning extraction).
// The terminal `DEEPAGENT_RUN_STATE.json` is written under the configured runsDir
// (<baseDir>/runs/<runID>/), the SAME directory convention the legacy run-close path uses — a later
// lifecycle-trigger wave can pick up V2-settled sources without layout changes (the V2 path itself
// does not write a LEARNING_ADMISSION_RECEIPT.json yet). All writes follow the configured
// `AgentGateway` storage root (baseDir/runsDir), not the module-level Global path, so a host/test
// with an isolated root stays isolated.
// The flag gate (`DEEPAGENT_DURABLE_LEARNING`, default ON) is read through
// `AgentGateway.durableLearningEnabled()` — `=false` keeps the legacy-only learning path exactly as
// before W7 (no V2 admission).
// ---------------------------------------------------------------------------

export function onSessionSettled(database: Database.Interface): (input: SessionRunner.OnSessionSettledInput) => Effect.Effect<void> {
  return (input) =>
    Effect.gen(function* () {
      if (input.activityId === undefined) return
      // W4 (gap audit B3): the completion worklog — RUNNER facts only (plan terminal state),
      // written at settle into the run document set next to the plan. Model self-reports never
      // enter it (V3.3 completion-report contract). Independent of the learning flag: this is
      // the run's own record, not learning extraction.
      yield* Effect.sync(() => {
        const plan = AgentGateway.DeepAgentPlanStore.getPlanDoc(input.sessionID)
        if (!plan) return
        const progress = AgentGateway.DeepAgentPlanController.planProgress(plan)
        AgentGateway.DeepAgentPlanStore.writeSpecDoc(input.sessionID, {
          kind: "worklog",
          title: "completion",
          origin: "runner",
          body: JSON.stringify(
            {
              plan_id: plan.plan_id,
              goal: plan.goal,
              steps_done: progress.done,
              steps_total: progress.total,
              completed: progress.done === progress.total,
              activity: input.activityId,
            },
            null,
            2,
          ),
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("completion worklog write failed", { cause }).pipe(Effect.asVoid),
        ),
      )
      if (!AgentGateway.durableLearningEnabled()) return
      const session = yield* database.db
        .select({ projectId: SessionTable.project_id, directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return
      const { baseDir, runsDir } = AgentGateway.learningAuthorityConfig()
      const runID = `v2_${input.activityId}`
      const mode = AgentGateway.snapshot().agentMode
      const roundState = createInitialRoundState(mode)
      // W15 (P2) — non-rebuilt / non-isolation rounds only. The row set distinguishes both:
      //   - isolation: shadow-parity probe rows carry `owner_mode = 'shadow_v2'` (never a learning
      //     round); only the real `v2` rows count.
      //   - rebuild: a pre-dispatch rebuild terminalizes the admitted receipt in place as
      //     `failed` with one of the abandon codes below — the provider NEVER received the
      //     request, so it is not a dispatched round. Post-dispatch `failed` receipts (e.g.
      //     provider_stream_failed) are real rounds and stay counted.
      const preDispatchRebuildErrorCodes = [
        "turn_aborted_before_dispatch",
        "epoch_mismatch_rebuild",
        "config_drift_rebuild_required",
        "wire_seal_failed_before_dispatch",
      ]
      const turns = yield* database.db
        .select({ count: count() })
        .from(V2ProviderTurnReceiptTable)
        .where(
          and(
            eq(V2ProviderTurnReceiptTable.session_id, input.sessionID),
            eq(V2ProviderTurnReceiptTable.activity_id, input.activityId),
            eq(V2ProviderTurnReceiptTable.owner_mode, "v2"),
            or(
              ne(V2ProviderTurnReceiptTable.state, "failed"),
              // A `failed` row always carries an error_code (settle(failed)/abandon require one),
              // so a NULL error_code cannot occur on a failed row; the isNull arm keeps the
              // predicate total regardless.
              isNull(V2ProviderTurnReceiptTable.error_code),
              notInArray(V2ProviderTurnReceiptTable.error_code, preDispatchRebuildErrorCodes),
            ),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      // Drain-only activities (e.g. goal_steer) never dispatch a provider turn: nothing to learn.
      if ((turns?.count ?? 0) === 0) return
      roundState.round = Math.max(turns?.count ?? 1, 1)
      // W15 (P2) — the admission status mirrors the activity's LATEST receipt terminal state
      // instead of the hardcoded "completed": only a terminal `settled` receipt admits. A `failed`
      // terminal is exactly the legacy `learningFinalStatus` failed case — a failed activity does
      // not enter learning extraction (V2 has no failure-dossier diagnoses to extract), same for
      // `indeterminate_after_crash` and any non-terminal receipt (no proven success).
      const latestTurn = yield* database.db
        .select({ state: V2ProviderTurnReceiptTable.state })
        .from(V2ProviderTurnReceiptTable)
        .where(
          and(
            eq(V2ProviderTurnReceiptTable.session_id, input.sessionID),
            eq(V2ProviderTurnReceiptTable.activity_id, input.activityId),
          ),
        )
        .orderBy(desc(V2ProviderTurnReceiptTable.provider_turn_seq), desc(V2ProviderTurnReceiptTable.request_ordinal))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (latestTurn?.state !== "settled") return
      const terminalPath = path.join(runsDir, runID, "DEEPAGENT_RUN_STATE.json")
      const admission: DeepAgentDurableLearning.Admission = {
        baseDir,
        workspacePath: session.directory,
        rejectedBufferDir: path.join(baseDir, "memory"),
        terminalArtifact: {
          schema_version: "deepagent-code.learning_terminal_artifact.v1",
          path: terminalPath,
          sha256: "0".repeat(64),
          learning_admission_fingerprint: "0".repeat(64),
        },
        input: {
          projectID: session.projectId,
          sessionID: input.sessionID,
          runID,
          mode,
          roundState,
          totalRounds: roundState.round,
          finalStatus: "completed",
          trigger: "session_finalization",
          policy: AgentGateway.selfLearningPolicy() === "auto" ? "auto_merge_safe_project" : "manual_review",
        },
      }
      const fingerprint = DeepAgentDurableLearning.admissionFingerprint(admission)
      const content = CanonicalJson.stringify({
        schema_version: "deepagent_global_run_state.v1",
        run_id: runID,
        agent_mode: mode,
        state: "completed",
        generic_agent_session_id: input.sessionID,
        updated_at: new Date().toISOString(),
        learning_admission_fingerprint: fingerprint,
      })
      // The terminal-artifact hash is bound after the content is final (the admission fingerprint
      // does NOT cover the sha256 — it covers the terminal path + admission identity), mirroring
      // the legacy close() write order.
      const sha256 = Hash.sha256(content)
      const sealed: DeepAgentDurableLearning.Admission = {
        ...admission,
        terminalArtifact: { ...admission.terminalArtifact, sha256, learning_admission_fingerprint: fingerprint },
      }
      yield* Effect.sync(() => writeFileAtomic(terminalPath, content))
      yield* DeepAgentDurableLearning.admit(database.db, sealed, { authorityRoot: baseDir }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("V2 settle learning admission failed", { cause: Cause.pretty(cause) }),
        ),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("V2 settle learning admission failed", { cause: Cause.pretty(cause) }),
      ),
    )
}

/** W7 — the runner seam: inject the real settle hook into the SessionRunner subtree. Provided the
 * same way as `PromptEpoch.v2RunnerSeamLayer` (INTO the base graph), so the drain fibers built
 * inside `SessionV2.liveLayer` resolve it. */
export const onSessionSettledSeamLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Database.Service
    return Context.make(SessionRunner.CurrentOnSessionSettled, onSessionSettled(database))
  }),
)
