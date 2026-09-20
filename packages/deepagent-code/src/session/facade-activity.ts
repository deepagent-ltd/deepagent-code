/**
 * FEAT-011 T3 — FacadeActivity dispatcher (统一活动 facade 入口).
 *
 * Design: docs/feature-002-407.md (§2 tool contract, §11 non-goals).
 *
 * The facade is a THIN delegation layer over the three existing runners — it NEVER duplicates
 * lifecycle state and NEVER builds a parallel runtime:
 *
 *   task  → the ONE durable V2 owner: TaskRunAuthority.submit (delivery_mode=background); the
 *           process-global TaskRunDispatcher claims + drains the run and the settle transaction
 *           enqueues the outbox notification that wakes the parent.
 *   goal  → GoalManager.start / pause / resume / stop; steer via the goal_steer channel.
 *   panel → PanelConsult.consultPanel wrapped in a BackgroundJob owned by THIS service.
 *
 * Every start first writes a `session_facade_activity` row (state=active). The partial unique
 * index `(parent_session_id, subkind) WHERE state='active'` is the fail-closed admission fence:
 * a second active facade of the same subkind for the same parent session is refused. Terminal
 * state is settled through DeepAgentActivityAuthority.settle(kind=facade) with the
 * mutation_epoch CAS token.
 *
 * Ownership is runtime-owned: each process records its unique process owner token on every row.
 * A newly-built service recovers active rows owned by another process before admitting work.
 */
import { and, desc, eq, isNull } from "drizzle-orm"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionFacadeActivityTable } from "@deepagent-code/core/deepagent/activity-authority.sql"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/index"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { EventV2 } from "@deepagent-code/core/event"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PanelConsult } from "@/panel/consult"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { GoalDriver } from "@/session/goal-driver"
import { GoalManager } from "@/session/goal-manager"
import { GoalLoopWiring } from "@/session/goal-loop-wiring"
import { Snapshot } from "@/snapshot"
import { SessionSteer } from "@/session/steer"
import { SessionActivityOwner } from "@/session/activity-owner"
import { MessageID, SessionID } from "@/session/schema"
import { Identifier } from "@/id/id"
import { closeTask } from "@/tool/task-run"

export type FacadeSubkind = "task" | "goal" | "panel"

/**
 * Hard budget caps the facade enforces (policy ceiling). Model-supplied limits are clamped with
 * `min` against these — mirroring GoalManager's DEFAULT_LIMITS pattern (never loosen the policy).
 */
export const FACADE_POLICY_LIMITS = {
  maxTicks: 50,
  maxTokens: 500_000,
  maxWallclockMs: 60 * 60 * 1000,
} as const

export type FacadeBudget = {
  readonly maxTicks: number
  readonly maxTokens: number
  readonly maxWallclockMs: number
}

const clampPositiveInt = (requested: number | undefined, ceiling: number): number => {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return ceiling
  return Math.min(Math.floor(requested), ceiling)
}

/** min-clamp model limits against the policy ceiling; unset/invalid fields fall back to the ceiling. */
export const clampFacadeBudget = (requested?: Partial<FacadeBudget>): FacadeBudget => ({
  maxTicks: clampPositiveInt(requested?.maxTicks, FACADE_POLICY_LIMITS.maxTicks),
  maxTokens: clampPositiveInt(requested?.maxTokens, FACADE_POLICY_LIMITS.maxTokens),
  maxWallclockMs: clampPositiveInt(requested?.maxWallclockMs, FACADE_POLICY_LIMITS.maxWallclockMs),
})

/**
 * T6 — bounded projection helper. Code-point safe slice (never splits a surrogate pair) with an
 * explicit truncation marker so callers can programmatically detect the bound (design G5).
 */
export const applyResultBound = (
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } => {
  if (text.length <= maxChars) return { text, truncated: false }
  const points = Array.from(text)
  if (points.length <= maxChars) return { text, truncated: false }
  return { text: `${points.slice(0, maxChars).join("")}…[truncated]`, truncated: true }
}

export class FacadeActivityConflict extends Data.TaggedError("FacadeActivity.Conflict")<{
  readonly sessionID: string
  readonly subkind: FacadeSubkind
  readonly reason: string
}> {}

export class FacadeActivityNotFound extends Data.TaggedError("FacadeActivity.NotFound")<{
  readonly sessionID: string
  readonly subkind: FacadeSubkind
}> {}

export class FacadeActivityRunnerUnavailable extends Data.TaggedError("FacadeActivity.RunnerUnavailable")<{
  readonly subkind: FacadeSubkind
  readonly reason: string
}> {}

export class FacadeActivityInvalidInput extends Data.TaggedError("FacadeActivity.InvalidInput")<{
  readonly reason: string
}> {}

export class FacadeActivityUnsupportedControl extends Data.TaggedError("FacadeActivity.UnsupportedControl")<{
  readonly subkind: FacadeSubkind
  readonly action: FacadeControlAction
  readonly reason: string
}> {}

export type FacadeError =
  | FacadeActivityConflict
  | FacadeActivityNotFound
  | FacadeActivityRunnerUnavailable
  | FacadeActivityInvalidInput
  | FacadeActivityUnsupportedControl

export type FacadeStartInput = {
  readonly sessionID: string
  readonly subkind: FacadeSubkind
  readonly objective: string
  readonly budget?: Partial<FacadeBudget>
  /** The spawning tool-call id; doubles as the task_run.tool_call_id join key for task facades. */
  readonly spawnToolCallID?: string
  readonly parentMessageID?: string
  /** task-only: subagent type (defaults to "explore"). */
  readonly subagentType?: string
  /** task-only: the task prompt (defaults to the objective). */
  readonly prompt?: string
}

export type FacadeStartResult = {
  readonly activityID: string
  readonly subkind: FacadeSubkind
  readonly budget: FacadeBudget
  /** Domain reference — task: run/child session; goal: goalId; panel: background job id. */
  readonly ref: Record<string, string>
}

export type FacadeStatusEntry = {
  readonly activityID: string
  readonly subkind: FacadeSubkind
  readonly state: string
  readonly reason?: string
  readonly createdAt: number
  readonly settledAt?: number
  readonly objective?: string
  readonly ref: Record<string, string>
}

export type FacadeResultProjection = {
  readonly activityID: string
  readonly subkind: FacadeSubkind
  readonly terminal: boolean
  /** Facade base state (active/settled/interrupted/failed/recovery_required). */
  readonly state: string
  readonly reason?: string
  readonly summary?: string
  /** task subkind: structured settlement receipt (bounded). */
  readonly receipt?: Record<string, unknown>
  /** panel subkind: the arbiter verdict (bounded). */
  readonly verdict?: unknown
  /** goal subkind: terminal phase snapshot. */
  readonly phase?: string
  readonly truncated: boolean
}

export type FacadeControlAction = "pause" | "resume" | "stop" | "steer"

export type FacadeControlInput = {
  readonly sessionID: string
  readonly subkind: FacadeSubkind
  readonly action: FacadeControlAction
  /** steer-only: the guidance text admitted to the goal_steer channel. */
  readonly message?: string
  readonly reason?: string
}

export type FacadeControlResult = {
  readonly applied: boolean
  readonly subkind: FacadeSubkind
  readonly action: FacadeControlAction
  readonly detail: string
}

export interface Interface {
  readonly start: (input: FacadeStartInput) => Effect.Effect<FacadeStartResult, FacadeError>
  readonly status: (input: {
    readonly sessionID: string
    readonly subkind?: FacadeSubkind
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<FacadeStatusEntry>>
  readonly result: (input: {
    readonly sessionID: string
    readonly subkind: FacadeSubkind
  }) => Effect.Effect<FacadeResultProjection, FacadeActivityNotFound>
  readonly control: (input: FacadeControlInput) => Effect.Effect<FacadeControlResult, FacadeError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/FacadeActivity") {}

type FacadeRow = typeof SessionFacadeActivityTable.$inferSelect

const STATUS_LIMIT_CEILING = 20

/**
 * The dispatcher construction effect. Core V2 execution dependencies are explicit; every legacy
 * runner dependency (GoalManager, BackgroundJob, SessionSteer, Session/Agent/
 * Provider) is resolved via serviceOption so the registry can build the facade inline from
 * whatever the surrounding graph provides. Optional legacy services only control which facade
 * subkinds are advertised; the V2 owner itself may never disappear behind serviceOption.
 */
export const build: Effect.Effect<
  Interface,
  never,
  Database.Service | RuntimeFlags.Service | SessionV2.Service | Snapshot.Service
> = Effect.gen(function* () {
  const database = yield* Database.Service
  const { db } = database
  const flags = yield* RuntimeFlags.Service
  const goals = Option.getOrUndefined(yield* Effect.serviceOption(GoalManager.Service))
  const steerBuffer = Option.getOrUndefined(yield* Effect.serviceOption(SessionSteer.Service))
  const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
  const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
  const agents = Option.getOrUndefined(yield* Effect.serviceOption(Agent.Service))
  const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
  // LEGACY-EXECUTION-ZERO: the V2 session authority + snapshot drive every panel subagent turn.
  const v2Session = yield* SessionV2.Service
  const v2Snapshot = yield* Snapshot.Service
  // The EventV2 authority for durable admissions: the app bridge is the process authority; the
  // bare core service covers compositions (tests) that provide only the core event layer.
  const events =
    Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service)) ??
    Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))

  // ── facade base-table IO ──────────────────────────────────────────────────────────────────

  const insertFacadeRow = (input: {
    activityID: string
    subkind: FacadeSubkind
    sessionID: string
    objective: string
    budget: FacadeBudget
    ownerToken: string
    spawnToolCallID?: string
    parentMessageID?: string
  }) =>
    Effect.gen(function* () {
      const inserted = yield* db
        .insert(SessionFacadeActivityTable)
        .values({
          activity_id: input.activityID,
          subkind: input.subkind,
          parent_session_id: SessionID.make(input.sessionID),
          owner_token: input.ownerToken,
          spawn_tool_call_id: input.spawnToolCallID,
          objective_text: input.objective,
          budget_json: input.budget,
          state: "active",
          source: "activity_facade",
          created_at: Date.now(),
          mutation_epoch: 0,
        })
        // The partial unique index (parent_session_id, subkind) WHERE state='active' is the
        // fail-closed fence: a concurrent/lingering active facade makes this insert vanish.
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!inserted)
        return yield* Effect.fail(
          new FacadeActivityConflict({
            sessionID: input.sessionID,
            subkind: input.subkind,
            reason: "an active facade of this subkind already exists for this session; settle it first",
          }),
        )
      return inserted
    })

  const readFacadeRow = (activityID: string) =>
    db
      .select()
      .from(SessionFacadeActivityTable)
      .where(eq(SessionFacadeActivityTable.activity_id, activityID))
      .get()
      .pipe(Effect.orDie)

  const bindFacadeOwnerSession = (activityID: string, ownerSessionID: SessionID) =>
    Effect.gen(function* () {
      const bound = yield* db
        .update(SessionFacadeActivityTable)
        .set({ owner_session_id: ownerSessionID })
        .where(
          and(
            eq(SessionFacadeActivityTable.activity_id, activityID),
            eq(SessionFacadeActivityTable.state, "active"),
            isNull(SessionFacadeActivityTable.owner_session_id),
          ),
        )
        .returning({ activityID: SessionFacadeActivityTable.activity_id })
        .get()
        .pipe(Effect.orDie)
      if (bound) return
      const current = yield* readFacadeRow(activityID)
      if (current?.state === "active" && current.owner_session_id === ownerSessionID) return
      return yield* Effect.fail(
        new FacadeActivityConflict({
          sessionID: current?.parent_session_id ?? ownerSessionID,
          subkind: "task",
          reason: "facade task owner session binding was lost or changed",
        }),
      )
    })

  const latestFacadeRow = (sessionID: string, subkind: FacadeSubkind) =>
    db
      .select()
      .from(SessionFacadeActivityTable)
      .where(
        and(
          eq(SessionFacadeActivityTable.parent_session_id, SessionID.make(sessionID)),
          eq(SessionFacadeActivityTable.subkind, subkind),
        ),
      )
      .orderBy(desc(SessionFacadeActivityTable.created_at))
      .get()
      .pipe(Effect.orDie)

  const listFacadeRows = (sessionID: string, subkind: FacadeSubkind | undefined, limit: number) =>
    db
      .select()
      .from(SessionFacadeActivityTable)
      .where(
        and(
          eq(SessionFacadeActivityTable.parent_session_id, SessionID.make(sessionID)),
          ...(subkind ? [eq(SessionFacadeActivityTable.subkind, subkind)] : []),
        ),
      )
      .orderBy(desc(SessionFacadeActivityTable.created_at))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)

  // ── settlement via the ActivityAuthority facade branch (mutation_epoch CAS) ───────────────

  const settleFacadeRow = (row: FacadeRow, state: "completed" | "interrupted" | "recovery_required", reason: string) =>
    DeepAgentActivityAuthority.settle({
      activityKind: "facade",
      activityID: row.activity_id,
      expectedVersion: row.mutation_epoch,
      state,
      terminalReason: reason,
    }).pipe(
      // The authority set requires Database.Service; pin it to the instance captured at build
      // time so converge/settle stay requirement-free for the public ports.
      Effect.provideService(Database.Service, database),
      Effect.map(() => true),
      // A lost CAS / already-terminal row is not a facade defect — convergence is best-effort
      // and the domain authority remains the source of truth.
      Effect.catchCause(() => Effect.succeed(false)),
    )

  // ── domain probes (the runners remain the state authority) ────────────────────────────────

  const taskRunForFacade = (row: FacadeRow) => {
    if (!row.spawn_tool_call_id) return Effect.succeed(undefined)
    return db
      .select()
      .from(TaskRunTable)
      .where(
        and(
          eq(TaskRunTable.parent_session_id, row.parent_session_id),
          eq(TaskRunTable.tool_call_id, row.spawn_tool_call_id),
        ),
      )
      .orderBy(desc(TaskRunTable.generation))
      .get()
      .pipe(Effect.orDie)
  }

  // Terminal + quiescent-resolvable run states: recovery_required (v1 rows flipped by the
  // recovery migration) resolves the facade row to its own recovery_required state — never to a
  // fabricated success — so the partial-unique index cannot stay wedged on a dead run.
  const TASK_TERMINAL_STATES = new Set([
    "completed",
    "error",
    "failed",
    "cancelled",
    "interrupted",
    "recovery_required",
  ])
  const GOAL_TERMINAL_PHASES = new Set(["done", "needs_human", "rolled_back", "stopped"])

  /**
   * Lazy convergence: when the domain runner already reached a terminal state but the facade
   * row is still active, settle it through the authority. task/goal runs are NOT owned by the
   * facade, so settlement happens at the next status/result/control touch point (panel settles
   * eagerly from its own background job).
   */
  const converge = (row: FacadeRow): Effect.Effect<FacadeRow> =>
    Effect.gen(function* () {
      if (row.state !== "active") return row
      if (row.subkind === "task") {
        const run = yield* taskRunForFacade(row)
        if (!run || !TASK_TERMINAL_STATES.has(run.state)) return row
        const state =
          run.state === "completed"
            ? ("completed" as const)
            : run.state === "cancelled" || run.state === "interrupted"
              ? ("interrupted" as const)
              : ("recovery_required" as const)
        yield* settleFacadeRow(row, state, run.reason ?? `task_run_${run.state}`)
      } else if (row.subkind === "goal") {
        if (!goals) return row
        const snapshot = yield* goals.status(row.parent_session_id).pipe(Effect.catchCause(() => Effect.succeed(null)))
        if (!snapshot || !GOAL_TERMINAL_PHASES.has(snapshot.phase)) return row
        const state =
          snapshot.phase === "done"
            ? ("completed" as const)
            : snapshot.phase === "rolled_back"
              ? ("recovery_required" as const)
              : ("interrupted" as const)
        yield* settleFacadeRow(row, state, `goal_${snapshot.phase}`)
      } else {
        if (!background) return row
        const job = yield* background.get(row.activity_id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!job || job.status === "running") return row
        const state =
          job.status === "completed"
            ? ("completed" as const)
            : job.status === "cancelled"
              ? ("interrupted" as const)
              : ("recovery_required" as const)
        yield* settleFacadeRow(row, state, `panel_${job.status}`)
      }
      return (yield* readFacadeRow(row.activity_id)) ?? row
    })

  // ── subkind delegation: task ──────────────────────────────────────────────────────────────

  const startTask = (row: FacadeRow, input: FacadeStartInput): Effect.Effect<Record<string, string>, FacadeError> =>
    Effect.gen(function* () {
      if (!agents || !events)
        return yield* Effect.fail(
          new FacadeActivityRunnerUnavailable({
            subkind: "task",
            reason: !agents ? "agent service unavailable" : "EventV2 authority unavailable",
          }),
        )
      const subagentType = input.subagentType ?? "explore"
      const agentInfo = yield* agents.get(subagentType)
      if (!agentInfo)
        return yield* Effect.fail(new FacadeActivityInvalidInput({ reason: `unknown subagent_type: ${subagentType}` }))
      const promptText = input.prompt ?? input.objective
      const toolCallID = row.spawn_tool_call_id ?? `facade:${row.activity_id}`
      const parentMessageID = input.parentMessageID
        ? SessionMessage.ID.make(input.parentMessageID)
        : SessionMessage.ID.create()

      const parent = yield* v2Session
        .get(SessionSchema.ID.make(row.parent_session_id))
        .pipe(
          Effect.mapError(
            () =>
              new FacadeActivityRunnerUnavailable({
                subkind: "task",
                reason: `parent session ${row.parent_session_id} is not visible to the V2 session store`,
              }),
          ),
        )
      // Permission derivation runs on the V1 wire rules the policy module speaks; a parent not
      // visible to the legacy store contributes no inherited rules (fail-closed, read-only facade).
      const parentV1 = sessions
        ? yield* sessions.get(SessionID.make(row.parent_session_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parentAgent = parentV1?.agent
        ? yield* agents.get(parentV1.agent).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parentV1?.permission ?? [],
        parentAgent,
        subagent: agentInfo,
      })

      // ONE durable submission onto the V2 authority: the ledger transaction precedes every
      // external side effect, the child session identity is deterministic, and the single first
      // input lands atomically with the run's input_state pending→ready CAS. Background delivery
      // means the process-global TaskRunDispatcher claims + drains the run and the settle
      // transaction enqueues the outbox notification that wakes this parent session.
      const submission = yield* TaskRunAuthority.submit(db, events, v2Session, {
        parentSessionID: SessionSchema.ID.make(row.parent_session_id),
        parentMessageID,
        toolCallID,
        deliveryMode: "background",
        prompt: new Prompt({ text: promptText }),
        agent: agentInfo.name,
        child: {
          title: `task: ${input.objective} (@${agentInfo.name} facade task)`,
          location: parent.location,
          // The facade never escalates: delegated tasks start read-only; write isolation remains
          // the dedicated task tool's explicit surface.
          permissions: SessionV2.permissionsFromLegacy(childPermission),
        },
      }).pipe(
        Effect.mapError(
          (error) =>
            new FacadeActivityConflict({
              sessionID: row.parent_session_id,
              subkind: "task",
              reason: `task admission refused: ${error._tag}${"reason" in error ? `/${error.reason}` : ""}`,
            }),
        ),
      )

      // Bind the facade to the deterministic execution session. The run is already durable and
      // self-healing (the dispatcher claims it regardless), so a bind failure settles only the
      // facade row — never the run.
      yield* bindFacadeOwnerSession(row.activity_id, SessionID.make(submission.run.childSessionID)).pipe(
        Effect.mapError(
          (error) =>
            new FacadeActivityConflict({
              sessionID: row.parent_session_id,
              subkind: "task",
              reason: error.reason,
            }),
        ),
      )
      return {
        runID: submission.run.runID,
        childSessionID: submission.run.childSessionID,
        ...(submission.exactRetry ? { replayed: "true" } : {}),
      }
    })

  // ── subkind delegation: goal ──────────────────────────────────────────────────────────────

  const startGoal = (
    input: FacadeStartInput,
    budget: FacadeBudget,
  ): Effect.Effect<Record<string, string>, FacadeError> =>
    Effect.gen(function* () {
      if (!goals)
        return yield* Effect.fail(
          new FacadeActivityRunnerUnavailable({ subkind: "goal", reason: "GoalManager service unavailable" }),
        )
      const snapshot = yield* goals
        .start({
          sessionID: input.sessionID,
          objective: input.objective,
          limits: {
            maxTicks: budget.maxTicks,
            maxTokens: budget.maxTokens,
            maxWallclockMs: budget.maxWallclockMs,
          },
        })
        .pipe(Effect.mapError((error) => new FacadeActivityInvalidInput({ reason: `goal rejected: ${error.message}` })))
      return { goalID: snapshot.goalId, planDocID: snapshot.planDocId, phase: snapshot.phase }
    })

  // ── subkind delegation: panel (facade-owned background job) ───────────────────────────────

  const startPanel = (row: FacadeRow, input: FacadeStartInput): Effect.Effect<Record<string, string>, FacadeError> =>
    Effect.gen(function* () {
      if (!background || !sessions || !agents || !provider)
        return yield* Effect.fail(
          new FacadeActivityRunnerUnavailable({
            subkind: "panel",
            reason: "panel runner dependencies (session/agent/provider/background-job) unavailable",
          }),
        )
      const model = yield* provider
        .defaultModel()
        .pipe(
          Effect.catchCause(() =>
            Effect.fail(
              new FacadeActivityRunnerUnavailable({ subkind: "panel", reason: "no default model configured" }),
            ),
          ),
        )
      // Same child-session turn runner the goal loop + HTTP panel route use — no parallel runtime.
      const runTurn = GoalLoopWiring.makeTaskSubagentRunner({
        sessions,
        agents,
        parentSessionID: SessionID.make(row.parent_session_id),
        model: { providerID: model.providerID, modelID: model.modelID },
        purpose: "panel",
        v2Session,
        snapshot: v2Snapshot,
      })
      const panelTurnRunner = (turnInput: Parameters<typeof runTurn>[0]) =>
        runTurn(turnInput).pipe(Effect.map((r) => ({ structured: r.structured })))
      const job = yield* background.start({
        id: row.activity_id,
        type: "facade-panel",
        title: applyResultBound(input.objective, 120).text,
        metadata: { facadeActivityID: row.activity_id, subkind: "panel" },
        run: PanelConsult.consultPanel(
          { question: input.objective, codeRefs: [], parentSessionID: row.parent_session_id },
          { runTurn: panelTurnRunner },
        ).pipe(
          Effect.tap((verdict) => settleFacadeRow(row, "completed", `panel_${verdict.decision}`).pipe(Effect.ignore)),
          Effect.map((verdict) => JSON.stringify(verdict)),
          Effect.catchCause((cause) =>
            settleFacadeRow(row, "recovery_required", "panel_run_error").pipe(
              Effect.ignore,
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        ),
      })
      return { jobID: job.id }
    })

  // ── public ports ──────────────────────────────────────────────────────────────────────────

  const start: Interface["start"] = Effect.fn("FacadeActivity.start")(function* (input) {
    const objective = input.objective.trim()
    if (!objective) return yield* Effect.fail(new FacadeActivityInvalidInput({ reason: "objective must be non-empty" }))
    const budget = clampFacadeBudget(input.budget)
    // "job" is the closest legal ascending prefix for a facade-owned background activity id.
    const activityID = Identifier.ascending("job")
    const spawnToolCallID = input.spawnToolCallID ?? `facade:${activityID}`
    const row = yield* insertFacadeRow({
      activityID,
      subkind: input.subkind,
      sessionID: input.sessionID,
      objective,
      budget,
      ownerToken: SessionActivityOwner.processOwnerToken,
      spawnToolCallID,
    })

    // Delegation failure settles the freshly-admitted row as recovery_required (quiescent,
    // nonterminal) so a failed handoff is visible and never blocks the unique index forever.
    const delegation: Effect.Effect<Record<string, string>, FacadeError> = input.subkind === "task"
      ? startTask({ ...row, spawn_tool_call_id: spawnToolCallID }, input)
      : input.subkind === "goal"
        ? startGoal(input, budget)
        : startPanel(row, input)
    return yield* delegation.pipe(
      Effect.map((ref) => ({ activityID, subkind: input.subkind, budget, ref })),
      Effect.catch((error: FacadeError) =>
        Effect.gen(function* () {
          const current = yield* readFacadeRow(activityID)
          if (current && current.state === "active") {
            yield* settleFacadeRow(current, "recovery_required", `start_failed:${error._tag}`).pipe(Effect.ignore)
          }
          return yield* Effect.fail(error)
        }),
      ),
    )
  })

  const status: Interface["status"] = Effect.fn("FacadeActivity.status")(function* (input) {
    const limit = Math.max(1, Math.min(input.limit ?? STATUS_LIMIT_CEILING, STATUS_LIMIT_CEILING))
    const rows = yield* listFacadeRows(input.sessionID, input.subkind, limit)
    const converged: FacadeStatusEntry[] = []
    for (const row of rows) {
      const current = yield* converge(row)
      const ref: Record<string, string> = {}
      if (current.subkind === "task") {
        const run = yield* taskRunForFacade(current)
        if (run) {
          ref.runID = run.run_id
          ref.childSessionID = run.child_session_id
          ref.runState = run.state
        }
      } else if (current.subkind === "goal") {
        const snapshot = goals
          ? yield* goals.status(current.parent_session_id).pipe(Effect.catchCause(() => Effect.succeed(null)))
          : null
        if (snapshot) {
          ref.goalID = snapshot.goalId
          ref.phase = snapshot.phase
        }
      } else {
        const job = background
          ? yield* background.get(current.activity_id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
        if (job) {
          ref.jobID = job.id
          ref.jobStatus = job.status
        }
      }
      converged.push({
        activityID: current.activity_id,
        subkind: current.subkind,
        state: current.state,
        reason: current.reason_code ?? undefined,
        createdAt: current.created_at,
        settledAt: current.settled_at ?? undefined,
        objective: current.objective_text ? applyResultBound(current.objective_text, 200).text : undefined,
        ref,
      })
    }
    return converged
  })

  const result: Interface["result"] = Effect.fn("FacadeActivity.result")(function* (input) {
    const row = yield* latestFacadeRow(input.sessionID, input.subkind)
    if (!row) return yield* Effect.fail(new FacadeActivityNotFound(input))
    const current = yield* converge(row)
    const maxChars = flags.subagentOutputMaxChars
    const summary = current.objective_text ? applyResultBound(current.objective_text, maxChars) : undefined
    // recovery_required is quiescent/nonterminal: expose a state hint and never project a
    // terminal receipt/verdict that would mislead the caller into treating recovery as done.
    if (current.state === "active" || current.state === "recovery_required") {
      return {
        activityID: current.activity_id,
        subkind: current.subkind,
        terminal: false,
        state: current.state,
        summary: summary?.text,
        truncated: summary?.truncated ?? false,
      }
    }
    let truncated = summary?.truncated ?? false
    let receipt: Record<string, unknown> | undefined
    let verdict: unknown
    let phase: string | undefined
    if (current.subkind === "task") {
      const run = yield* taskRunForFacade(current)
      if (run) {
        const output = run.output ? applyResultBound(run.output, maxChars) : undefined
        truncated = truncated || (output?.truncated ?? false)
        receipt = {
          runID: run.run_id,
          childSessionID: run.child_session_id,
          runState: run.state,
          reason: run.reason ?? undefined,
          output: output?.text,
        }
      }
    } else if (current.subkind === "goal") {
      const snapshot = goals
        ? yield* goals.status(current.parent_session_id).pipe(Effect.catchCause(() => Effect.succeed(null)))
        : null
      phase = snapshot?.phase
    } else {
      const job = background
        ? yield* background.get(current.activity_id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (job?.output) {
        const bounded = applyResultBound(job.output, maxChars)
        truncated = truncated || bounded.truncated
        // A valid JSON document can still exceed the host cap. Returning the parsed object in
        // that case bypasses the bound when the tool serializes it, so only parse untruncated
        // output; oversized verdicts remain a bounded preview string.
        if (bounded.truncated) verdict = bounded.text
        else
          verdict = Option.getOrElse(
            Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(job.output),
            () => bounded.text,
          )
      }
    }
    return {
      activityID: current.activity_id,
      subkind: current.subkind,
      terminal: true,
      state: current.state,
      reason: current.reason_code ?? undefined,
      summary: summary?.text,
      ...(receipt ? { receipt } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(phase !== undefined ? { phase } : {}),
      truncated,
    }
  })

  const control: Interface["control"] = Effect.fn("FacadeActivity.control")(function* (input) {
    const row = yield* latestFacadeRow(input.sessionID, input.subkind)
    if (!row)
      return yield* Effect.fail(new FacadeActivityNotFound({ sessionID: input.sessionID, subkind: input.subkind }))

    if (row.state === "recovery_required")
      return {
        applied: false,
        subkind: input.subkind,
        action: input.action,
        detail: "activity requires explicit recovery; no runner control was attempted",
      }

    let outcome: FacadeControlResult
    if (input.subkind === "goal") {
      if (!goals)
        return yield* Effect.fail(
          new FacadeActivityRunnerUnavailable({ subkind: "goal", reason: "GoalManager service unavailable" }),
        )
      if (input.action === "pause") {
        const applied = yield* goals.pause(input.sessionID)
        outcome = {
          applied,
          subkind: "goal",
          action: "pause",
          detail: applied ? "goal paused" : "no running goal to pause",
        }
      } else if (input.action === "resume") {
        const applied = yield* goals.resume(input.sessionID)
        outcome = {
          applied,
          subkind: "goal",
          action: "resume",
          detail: applied ? "goal resumed" : "no paused goal to resume",
        }
      } else if (input.action === "stop") {
        const applied = yield* goals.stop(input.sessionID)
        outcome = {
          applied,
          subkind: "goal",
          action: "stop",
          detail: applied ? "goal stop requested" : "no active goal to stop",
        }
      } else if (input.action === "steer") {
        const text = input.message?.trim()
        if (!text)
          return yield* Effect.fail(new FacadeActivityInvalidInput({ reason: "steer requires a non-empty message" }))
        if (!steerBuffer)
          return yield* Effect.fail(
            new FacadeActivityRunnerUnavailable({ subkind: "goal", reason: "steer buffer unavailable" }),
          )
        const admitted = yield* steerBuffer
          .admit({
            sessionID: SessionID.make(input.sessionID),
            prompt: Prompt.make({ text }),
            delivery: GoalDriver.GOAL_STEER_DELIVERY,
          })
          .pipe(
            Effect.mapError(
              (error) => new FacadeActivityInvalidInput({ reason: `steer admission refused: ${error._tag}` }),
            ),
          )
        outcome = { applied: true, subkind: "goal", action: "steer", detail: `steer admitted as ${admitted.id}` }
      } else {
        return yield* Effect.fail(
          new FacadeActivityUnsupportedControl({
            subkind: "goal",
            action: input.action,
            reason: "goal supports pause/resume/stop/steer",
          }),
        )
      }
    } else if (input.subkind === "task") {
      // Honest control-plane gap: the durable task surface only offers close (best-effort for
      // active runs, immediate for queued/admitted). pause/resume/steer are NOT fabricated —
      // callers fall back to stop.
      if (input.action !== "stop")
        return yield* Effect.fail(
          new FacadeActivityUnsupportedControl({
            subkind: "task",
            action: input.action,
            reason:
              "task facade supports only stop (delegates to durable task_close); pause/resume/steer are not available",
          }),
        )
      const run = yield* taskRunForFacade(row)
      if (!run)
        outcome = { applied: false, subkind: "task", action: "stop", detail: "no task run recorded for this facade" }
      else {
        const closeResult = yield* closeTask({
          childSessionID: SessionID.make(run.child_session_id),
          parentSessionID: SessionID.make(row.parent_session_id),
          reason: input.reason ?? "facade_stop",
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.mapError(
            (error) =>
              new FacadeActivityConflict({
                sessionID: row.parent_session_id,
                subkind: "task",
                reason: `task close refused: ${error._tag}`,
              }),
          ),
        )
        outcome = {
          applied: closeResult.closed,
          subkind: "task",
          action: "stop",
          detail: closeResult.closed
            ? "task close requested; active runs settle at the next provider boundary"
            : "task has no open run (already settled or closed)",
        }
      }
    } else {
      if (input.action !== "stop")
        return yield* Effect.fail(
          new FacadeActivityUnsupportedControl({
            subkind: "panel",
            action: input.action,
            reason: "panel facade supports only stop (cancels the background consult job)",
          }),
        )
      if (!background)
        return yield* Effect.fail(
          new FacadeActivityRunnerUnavailable({ subkind: "panel", reason: "background job service unavailable" }),
        )
      const cancelled = yield* background.cancel(row.activity_id)
      outcome = {
        applied: cancelled !== undefined,
        subkind: "panel",
        action: "stop",
        detail: cancelled ? "panel consult job cancelled" : "no running panel job to cancel",
      }
    }

    // Best-effort eager convergence so a stop that immediately settles the domain (queued task
    // close, goal stop) also settles the facade row without waiting for the next read.
    const current = yield* readFacadeRow(row.activity_id)
    if (current) yield* converge(current)
    return outcome
  })

  // A facade row is process-local by construction. On service startup, rows owned by a
  // different process (including legacy rows with no owner token) cannot have a live runner in
  // this process and must be made quiescent before the next admission sees the unique index.
  yield* Effect.gen(function* () {
    const stale = yield* db
      .select()
      .from(SessionFacadeActivityTable)
      .where(eq(SessionFacadeActivityTable.state, "active"))
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      stale.filter((row) => row.owner_token !== SessionActivityOwner.processOwnerToken),
      (row) => settleFacadeRow(row, "recovery_required", "facade_owner_lost_after_restart"),
      { discard: true },
    )
  })

  return Service.of({ start, status, result, control })
})

export const layer = Layer.effect(Service, build)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(RuntimeFlags.defaultLayer)),
)

export * as FacadeActivity from "./facade-activity"
