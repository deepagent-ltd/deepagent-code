export * as DurableLearningRuntime from "./learning-runtime"

import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { and, count, desc, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentDurableLearning } from "@deepagent-code/core/deepagent/durable-learning"
import { DeepAgentLearningLifecycleTrigger } from "@deepagent-code/core/deepagent/learning-lifecycle-trigger"
import { createInitialRoundState } from "@deepagent-code/core/deepagent/round-state"
import { writeFileAtomic } from "@deepagent-code/core/deepagent/atomic-write"
import { Global } from "@deepagent-code/core/global"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { EventTable } from "@deepagent-code/core/event/sql"
import { V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { finalizeSessionWork } from "./session-finalizer"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { Cause, Context, Duration, Effect, Layer, Schedule, Scope } from "effect"

const pollInterval = Duration.seconds(1)

type ReviewerFactory = (workspacePath: string) => DeepAgentDurableLearning.ReviewerPort | undefined

export interface ReviewerRegistryInterface {
  readonly register: (factory: ReviewerFactory) => Effect.Effect<void, never, Scope.Scope>
  readonly reviewerForWorkspace: (workspacePath: string) => DeepAgentDurableLearning.ReviewerPort | undefined
}

export const CurrentReviewerRegistry = Context.Reference<ReviewerRegistryInterface | undefined>(
  "@deepagent-code/DurableLearningRuntime/ReviewerRegistry",
  { defaultValue: () => undefined },
)

export const reviewerRegistryLayer = Layer.effectContext(
  Effect.gen(function* () {
    const factories = new Map<symbol, ReviewerFactory>()
    yield* Effect.addFinalizer(() => Effect.sync(() => factories.clear()))
    const registry: ReviewerRegistryInterface = {
      register: Effect.fn("DurableLearningRuntime.ReviewerRegistry.register")(function* (factory) {
        const token = Symbol("learning-reviewer-factory")
        factories.set(token, factory)
        yield* Effect.addFinalizer(() => Effect.sync(() => factories.delete(token)))
      }),
      reviewerForWorkspace: (workspacePath) =>
        [...factories.values()]
          .toReversed()
          .map((factory) => factory(workspacePath))
          .find((reviewer) => reviewer !== undefined),
    }
    return Context.make(CurrentReviewerRegistry, registry)
  }),
)

export const registerLearningReviewerFactory = Effect.fn("DurableLearningRuntime.registerLearningReviewerFactory")(
  function* (factory: ReviewerFactory) {
    const registry = yield* CurrentReviewerRegistry
    if (!registry) return
    yield* registry.register(factory)
  },
)

export const learningAuthority = (database: Database.Interface): AgentGateway.LearningAuthority => ({
  record: (admission) => Effect.runPromise(DeepAgentDurableLearning.record(database.db, admission).pipe(Effect.asVoid)),
  enqueue: (admission) =>
    Effect.runPromise(
      DeepAgentDurableLearning.admit(database.db, admission, {
        authorityRoot: Global.Path.agent.data,
      }).pipe(Effect.asVoid),
    ),
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const reviewers = yield* CurrentReviewerRegistry
    const owner = `learning-worker:${process.pid}:${crypto.randomUUID()}`
    const tick = Effect.suspend(() =>
      DeepAgentDurableLearning.drain(database.db, {
        owner,
        authorityRoot: Global.Path.agent.data,
        reviewerForWorkspace: reviewers?.reviewerForWorkspace,
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable learning worker tick failed", { cause: Cause.pretty(cause) }).pipe(Effect.as([])),
      ),
    )

    const releaseLearningAuthority = AgentGateway.setLearningAuthority(learningAuthority(database))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseLearningAuthority()
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

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(reviewerRegistryLayer))

export const lifecycleObserverLayer = Layer.effect(
  DeepAgentLearningLifecycleTrigger.CurrentRuntimeObserver,
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      observe: (input: DeepAgentLearningLifecycleTrigger.ObserveInput) =>
        Effect.runPromise(
          DeepAgentLearningLifecycleTrigger.observe(database.db, input, {
            authorityRoot: Global.Path.agent.data,
            runsDir: Global.Path.agent.runs,
          }),
        ),
    }
  }),
)

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

export function onSessionSettled(
  database: Database.Interface,
): (input: SessionRunner.OnSessionSettledInput, runtime?: AgentGateway.RuntimeInterface) => Effect.Effect<void> {
  return (input, runtime) => {
    const withStorage = runtime?.withStorage ?? (<A>(operation: () => A) => operation())
    return Effect.gen(function* () {
      if (input.activityId === undefined) return
      // W4 (gap audit B3): the completion worklog — RUNNER facts only (plan terminal state),
      // written at settle into the run document set next to the plan. Model self-reports never
      // enter it (V3.3 completion-report contract). Independent of the learning flag: this is
      // the run's own record, not learning extraction.
      yield* Effect.sync(() => {
        withStorage(() => {
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
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("completion worklog write failed", { cause }).pipe(Effect.asVoid),
        ),
      )
      // G2 unified finalizer: deliver the session's uncommitted work. The abs failure mode —
      // implementation finished, model never committed, verifier graded an empty diff — is a
      // runtime responsibility now. Runs before the learning gate so EVERY settled activity
      // finalizes (learning off must not turn delivery off). Best-effort posture: a finalizer
      // failure logs and never fails the settle; the tree is left untouched on any failure.
      // Review fix: only the paths THIS session's own write/edit calls touched are committed —
      // `git add -A` on the project root would absorb the user's unrelated uncommitted work.
      yield* Effect.promise(async () => {
        const workspace = input.workspacePath
        if (input.activityId === undefined) return { finalized: false, detail: "skipped: no activity" }
        // Review round 5: harvest THIS activity's validation evidence from the durable event log
        // and record it WITH the activity binding BEFORE reading it back — under the V2 owner
        // branch the V1 request-prep harvester never runs (prompt.ts returns from the v2Drain
        // before the legacy loop), so without this the evidence is always empty and the verdict
        // collapses to "unverified" forever. The classifier mirrors the V1 authority order: the
        // bash exit trailer is definitive; structured exitCode (from the core bash tool) is the
        // same fact; no signal means the command says nothing about validation. Both the record
        // and the read run INSIDE withStorage so they address the same SessionState runtime the
        // gateway configured (a bare module call would hit the defaultRuntime instead).
        const validation = withStorage(() => {
          harvestActivityValidation(database, input.sessionID, input.activityId!, workspace)
          const state = AgentGateway.DeepAgentSessionState.get(input.sessionID)
          if (!state || state.lastValidationResults.length === 0) return "unverified" as const
          // Only evidence attributed to THIS activity authorizes delivery; anything else
          // (none, an older activity's, or unattributed legacy state) withholds. Withholding
          // defers delivery — the tree keeps the work; it never loses it.
          if (state.lastValidationActivityId !== input.activityId) return "unverified" as const
          return state.lastValidationResults.every((result) => result.passed) ? ("validated" as const) : ("validation_failed" as const)
        })
        const touchedPaths = activityTouchedPaths(database, input.sessionID, input.activityId)
        const outcome = await finalizeSessionWork({ directory: workspace, validation, touchedPaths })
        if (outcome.kind === "committed")
          return { finalized: true, detail: `committed ${outcome.files} file(s) at ${outcome.commit}` }
        if (outcome.kind === "validation_failed")
          return { finalized: false, detail: `withheld: last validation failed (${outcome.files} changed)` }
        if (outcome.kind === "unverified")
          return { finalized: false, detail: `withheld: no validation evidence for this activity (${outcome.files} changed)` }
        if (outcome.kind === "no_changes") return { finalized: false, detail: "no changes to deliver" }
        return { finalized: false, detail: `skipped: ${outcome.reason}` }
      }).pipe(
        Effect.flatMap((result) => Effect.logInfo(`session finalizer: ${result.detail}`)),
        Effect.catchCause((cause) =>
          Effect.logWarning("session finalizer failed", { cause }).pipe(Effect.asVoid),
        ),
      )
      if (!(runtime?.durableLearning ?? AgentGateway.durableLearningEnabled())) return
      const session = yield* database.db
        .select({ projectId: SessionTable.project_id, directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return
      const config = runtime ?? AgentGateway.learningAuthorityConfig()
      const baseDir = config.baseDir
      const runsDir = config.runsDir
      const runID = `v2_${input.activityId}`
      const mode = runtime?.snapshot.agentMode ?? AgentGateway.snapshot().agentMode
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
          policy:
            (runtime?.selfLearning ?? AgentGateway.selfLearningPolicy()) === "auto"
              ? "auto_merge_safe_project"
              : "manual_review",
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

// G2 review fix (round 3) — the file-attribution source for the session finalizer.
//
// The durable JOIN chain (no sequence arithmetic — reviewer's blocking finding: message seq and
// event seq are DISJOINT sequence spaces, and history_source_end_message_id marks a turn's START
// boundary, so the previous (floorSeq, endSeq] window over event.seq could only ever produce an
// empty set):
//
//   session_v2_tool_effect (receipt_id + tool_call_id + tool_name, written at settlement for
//     every tool call the activity's provider turns made)
//     → session_v2_provider_turn_receipt (activity_id) — restricts to THIS activity
//   session.next.tool.success events (data.callID = effect.tool_call_id) → the tool's STRUCTURED
//     OUTPUT, whose `resource`/`applied[].resource` fields carry the RESOLVED canonical path of
//     every file the call changed — more reliable than the model-supplied input path, and the
//     ONLY source for apply_patch_chunk commits (whose commit call carries no patchText at all:
//   the assembled patch lives in the transaction map, not the event).
//
// Only SUCCESSFUL effects attribute files — a failed tool call changed nothing durable. Bash
// stays excluded (no resource); malformed shapes contribute nothing (never guess).
// Review round 5 — the V2 validation harvester. Under the V2 owner branch the V1 request-prep
// harvester never runs (prompt.ts returns from the v2Drain before the legacy loop), so nothing
// ever wrote lastValidationResults for a V2 session and the finalizer's verdict was permanently
// "unverified". This harvests THIS activity's bash evidence from the same durable join the
// attribution uses (tool_effect → receipt.activity_id → events by callID), classifies it with
// the V1 authority order (the exit trailer is definitive; the core bash tool's structured
// exitCode is the same fact; no signal says nothing), and records it WITH the activity binding.
// Fail-safe: any doubt (no commands inferable, no matching calls, unreadable rows) records
// nothing — the finalizer then withholds, which defers delivery without losing work.
export function harvestActivityValidation(
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  activityId: string,
  workspace: string,
): void {
  // Same workspace signals the V1 detector uses (workspace-context.ts): package.json scripts,
  // tsconfig, python markers. Sync fs probes — the settle path must not depend on the async
  // detect cache being warm. An empty inference records nothing (finalizer withholds — safe).
  const readJsonIfExists = (file: string): { scripts?: Record<string, string> } | undefined => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }
    } catch {
      return undefined
    }
  }
  const packageJson = readJsonIfExists(path.join(workspace, "package.json"))
  const hasTypeScript =
    existsSync(path.join(workspace, "tsconfig.json")) || packageJson?.scripts?.typecheck !== undefined
  const hasPython = ["pyproject.toml", "requirements.txt", "setup.py"].some((file) =>
    existsSync(path.join(workspace, file)),
  )
  const commands = AgentGateway.DeepAgentValidation.inferValidationCommands({
    cwd: workspace,
    packageJson,
    hasTypeScript,
    hasPython,
    runner: "bun run",
  })
  if (commands.length === 0) return
  // bash tool calls of THIS activity (inputs from tool.called, outcomes from tool.success)
  const effects: ReadonlyArray<{ toolCallId: string; toolName: string }> = Effect.runSync(
    database.db
      .select({ toolCallId: V2ToolEffectTable.tool_call_id, toolName: V2ToolEffectTable.tool_name })
      .from(V2ToolEffectTable)
      .innerJoin(
        V2ProviderTurnReceiptTable,
        eq(V2ToolEffectTable.receipt_id, V2ProviderTurnReceiptTable.receipt_id),
      )
      .where(
        and(
          eq(V2ToolEffectTable.session_id, sessionID),
          eq(V2ProviderTurnReceiptTable.activity_id, activityId),
          eq(V2ToolEffectTable.state, "settled"),
          eq(V2ToolEffectTable.tool_name, "bash"),
        ),
      )
      .all(),
  )
  if (effects.length === 0) return
  const callIds = new Set(effects.map((row) => row.toolCallId))
  const calledInputs = new Map<string, string>()
  const successOutputs = new Map<string, { exitCode?: unknown; output?: unknown }>()
  for (const row of Effect.runSync(
    database.db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          inArray(EventTable.type, ["session.next.tool.called", "session.next.tool.success"]),
        ),
      )
      .all(),
  )) {
    const callID = (row.data as { callID?: unknown } | null)?.callID
    if (typeof callID !== "string" || !callIds.has(callID)) continue
    if (row.type === "session.next.tool.called") {
      const input = (row.data as { input?: unknown } | null)?.input
      const command = (input as { command?: unknown } | null)?.command
      if (typeof command === "string") calledInputs.set(callID, command)
    } else {
      const structured = (row.data as { structured?: unknown } | null)?.structured
      if (structured !== null && typeof structured === "object")
        successOutputs.set(callID, structured as { exitCode?: unknown; output?: unknown })
    }
  }
  const results: AgentGateway.ValidationResult[] = []
  for (const [callId, command] of calledInputs) {
    // Same matching rule as the V1 classifier: the executed command must CONTAIN an inferred
    // validation command (the model prefixes runners / wraps with cd).
    if (!commands.some((candidate) => command.includes(candidate))) continue
    const outcome = successOutputs.get(callId)
    if (outcome === undefined) continue
    const exit = typeof outcome.exitCode === "number" ? outcome.exitCode : undefined
    if (exit === undefined) continue // no authoritative signal — says nothing (never guess)
    const textOutput = typeof outcome.output === "string" ? outcome.output : ""
    results.push({
      command,
      passed: exit === 0,
      kind: "command_exit",
      exit_code: exit,
      output: textOutput,
      duration_ms: 0,
    })
  }
  if (results.length === 0) return
  const output = results.map((r) => `${r.command}: ${r.passed ? "PASS" : "FAIL"}`).join("\n")
  // SessionState resolves through AsyncLocalStorage with a default-runtime fallback, so a plain
  // synchronous call from the settle path reaches the same store the drain fibers use.
  AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
  AgentGateway.DeepAgentSessionState.recordValidation(sessionID, results, output, activityId)
}

const FILE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch", "apply_patch_chunk"])

// Exported for the real-DB integration test (receipt/event/tool_effect tables seeded with the
// production column shapes, exactly as the V2 runner writes them).
export function activityTouchedPaths(database: Database.Interface, sessionID: SessionSchema.ID, activityId: string): readonly string[] {
  // receipt ids of this activity
  const receiptRows: ReadonlyArray<{ receiptId: string }> = Effect.runSync(
    database.db
      .select({ receiptId: V2ProviderTurnReceiptTable.receipt_id })
      .from(V2ProviderTurnReceiptTable)
      .where(and(eq(V2ProviderTurnReceiptTable.session_id, sessionID), eq(V2ProviderTurnReceiptTable.activity_id, activityId)))
      .all(),
  )
  if (receiptRows.length === 0) return []
  // every tool effect settled under those receipts, with its exact tool name
  const effectRows: ReadonlyArray<{ toolCallId: string; toolName: string }> = Effect.runSync(
    database.db
      .select({ toolCallId: V2ToolEffectTable.tool_call_id, toolName: V2ToolEffectTable.tool_name })
      .from(V2ToolEffectTable)
      .where(
        and(
          eq(V2ToolEffectTable.session_id, sessionID),
          inArray(
            V2ToolEffectTable.receipt_id,
            receiptRows.map((row) => row.receiptId),
          ),
          eq(V2ToolEffectTable.state, "settled"),
        ),
      )
      .all(),
  )
  const mutating = effectRows.filter((row) => FILE_MUTATING_TOOLS.has(row.toolName))
  if (mutating.length === 0) return []
  const callIds = new Set(mutating.map((row) => row.toolCallId))
  // successful tool outputs from the durable event log, keyed by callID
  const successRows: ReadonlyArray<{ data: { callID?: unknown; structured?: unknown; outputPaths?: unknown } }> =
    Effect.runSync(
      database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, "session.next.tool.success")))
        .all(),
    )
  const paths = new Set<string>()
  let unattributedMutatingCalls = 0
  for (const row of successRows) {
    if (typeof row.data?.callID !== "string" || !callIds.has(row.data.callID)) continue
    const fromStructured = toolSuccessResources(row.data.structured)
    for (const path of fromStructured) paths.add(path)
    if (fromStructured.length === 0) {
      // outputPaths (review round 4) is the event-schema field the runner always writes on
      // success — but its PRODUCER is the tool-output overflow store: the paths point at
      // internal archive files (`.deepagent` data dir), never at workspace files the tool
      // mutated. Committing them would pollute the tree, so they are FILTERED — but their
      // presence on a mutating call with no structured resource is an anomaly worth surfacing.
      const outputPaths = Array.isArray(row.data.outputPaths) ? row.data.outputPaths.length : 0
      if (outputPaths > 0) unattributedMutatingCalls++
    }
  }
  if (unattributedMutatingCalls > 0) {
    Effect.runSync(Effect.logWarning("finalizer attribution: mutating calls with only archive outputPaths", { count: unattributedMutatingCalls }))
  }
  return [...paths]
}

/**
 * Extract the changed-file paths from a mutating tool's STRUCTURED SUCCESS output:
 *   write/edit         → output.resource (the mutation-resolved canonical path)
 *   apply_patch(_chunk)→ output.applied[].resource (one per applied hunk; commit carries the
 *                        assembled result even though its own input has no patchText)
 * Reads ONLY schema-declared fields; anything else contributes nothing. Exported for tests.
 */
export function toolSuccessResources(structured: unknown): readonly string[] {
  if (structured === null || typeof structured !== "object") return []
  const record = structured as Record<string, unknown>
  const resource = record.resource
  if (typeof resource === "string" && resource.trim().length > 0) return [resource]
  const applied = record.applied
  if (!Array.isArray(applied)) return []
  const resources: string[] = []
  for (const item of applied) {
    if (item === null || typeof item !== "object") continue
    const r = (item as Record<string, unknown>).resource
    if (typeof r === "string" && r.trim().length > 0) resources.push(r)
  }
  return resources
}
