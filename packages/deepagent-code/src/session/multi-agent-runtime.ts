export * as MultiAgentRuntime from "./multi-agent-runtime"

import path from "node:path"
import { Cause, Context, Duration, Effect, Fiber, Layer, Schedule } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { ConflictArbiter } from "@deepagent-code/core/deepagent/conflict-arbiter"
import { AutonomyPolicy } from "@deepagent-code/core/deepagent/autonomy-policy"
import { SecurityGate } from "@deepagent-code/core/deepagent/security-gate"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { WorkspaceConcurrency } from "@deepagent-code/core/deepagent/workspace-concurrency"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { FileLock } from "@deepagent-code/core/file-lock"
import { Identifier } from "@deepagent-code/core/util/identifier"
import type { SubagentTurnRunner, SubagentTurnResult } from "./goal-loop-wiring"
import type { EventDispatcher } from "./event-dispatcher"
import { SessionID } from "./schema"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §C — the Multi-Agent Runtime. This is the DispatchPort the Event Dispatcher (§A4 Wave 2b) hands
// a routed event to. It coordinates the full §C pipeline for ONE event:
//   1. §C2 partition the event into a subtask DAG (TaskPartitioner, pure).
//   2. for each subtask: bind a capable agent, apply the §D autonomy gate and §E1 four-layer security
//      gate (both pure, fail-closed) — a subtask that fails a gate is skipped/blocked, never executed.
//   3. §C3 arbitrate conflicting claims (ConflictArbiter, pure) so two admitted subtasks never edit the
//      same files/symbols concurrently — the loser is deferred.
//   4. drive the winning subtask through the injected SubagentTurnRunner (the SAME one-turn runner the
//      goal loop uses — it creates a permission-derived child session; the runtime never elevates).
//   5. emit §C4 AgentCoordinationEvents (agent.task.started / .completed / .blocked) back onto the bus
//      so other agents + the Oversight trace observe progress WITHOUT calling internals.
//
// LAYERING: `deepagent-code` — this is the only §C piece that touches the session runtime (via the
// runner). All decisions delegate to the pure core policy modules. It implements EventDispatcher's
// DispatchPort so turning on v4MultiAgentRuntime swaps the observe-only port for real execution.

const log = Log.create({ service: "multi-agent-runtime" })

// The §C4 coordination event source — coordination events originate from the runtime ("system").
const COORDINATION_SOURCE: DeepAgentEvent.EventSource = "system"
const GIT_REF_ARTIFACT_PREFIX = "git-ref:"

const requiresWriteIsolation = (subtask: TaskPartitioner.Subtask): boolean => subtask.requiredAutonomy === "level_2"

const continuationRefFrom = (artifacts: ReadonlyArray<string>): string | undefined =>
  artifacts.find((artifact) => artifact.startsWith(GIT_REF_ARTIFACT_PREFIX))?.slice(GIT_REF_ARTIFACT_PREFIX.length)

export interface Interface {
  /** The DispatchPort surface — the Event Dispatcher calls this for a routed `dispatch` decision. */
  readonly dispatch: (request: EventDispatcher.DispatchRequest) => Effect.Effect<void, unknown>
  /**
   * Coordinate ONE event end-to-end (partition → gate → arbitrate → run → emit). Exposed for
   * deterministic testing; `dispatch` delegates here. Returns a summary of what ran / was blocked.
   */
  readonly coordinate: (event: DeepAgentEvent.Event) => Effect.Effect<CoordinationSummary, unknown>
}

export interface SubtaskOutcome {
  readonly taskID: string
  readonly capability: string
  readonly status: "completed" | "blocked" | "deferred"
  readonly agentID?: string
  readonly reason?: string
}
export interface CoordinationSummary {
  readonly event: DeepAgentEvent.Event
  readonly outcomes: ReadonlyArray<SubtaskOutcome>
  // true if any subtask was deferred (conflict), had an unmet dependency, or its runner turn failed —
  // the event is NOT fully handled and `dispatch` fails so the bus retries it.
  readonly hasUnfinished: boolean
}

export interface CompletedTurn {
  readonly task: TaskPartitioner.Subtask
  readonly agentID?: string
  readonly sessionID?: string
  readonly continuationRef?: string
  readonly artifacts: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/MultiAgentRuntime") {}

export interface LayerOptions {
  // the one-turn runner (production: makeTaskSubagentRunner). Tests inject a fake.
  readonly runner: SubagentTurnRunner
  // Deterministic partition seam. Production uses TaskPartitioner.partition with stable event IDs;
  // tests can inject a valid DAG to prove same-wave scheduling without duplicating scheduler logic.
  readonly partition?: (event: DeepAgentEvent.Event) => TaskPartitioner.Partition
  // resolved facts the pure gates need but the runtime can't know purely:
  //   trusted event sources (§E1 layer 1) — default: all sources trusted (lenient; tighten per deploy).
  readonly trustedSources?: ReadonlyArray<DeepAgentEvent.EventSource>
  //   trusted event sources resolved PER-EVENT (§E1 layer 1, PRODUCTION). Trusted sources are a
  //   PER-WORKSPACE fact (SecurityResolvers.resolveTrustedSources(workspaceID)), so the static
  //   `trustedSources` array cannot express them; when provided this resolver is consulted with the
  //   actual event and TAKES PRECEDENCE over `trustedSources`. FAIL CLOSED: any resolver failure (typed
  //   error OR defect) resolves the source to NOT trusted rather than opening. The static option is kept
  //   for tests/back-compat.
  readonly trustedSourcesFor?: (event: DeepAgentEvent.Event) => Effect.Effect<ReadonlyArray<DeepAgentEvent.EventSource>>
  //   whether the actor has workspace/project permission (§E1 layer 2). Default: allow (the HTTP layer
  //   already authenticated the actor; tighten with a real resolver in a multi-tenant deploy).
  readonly actorHasPermission?: (event: DeepAgentEvent.Event, agent: AgentDescriptor) => Effect.Effect<boolean>
  //   whether the tool/session runtime allows the operation (§E1 layer 4). Default: allow (the child
  //   session's own permission path is the real enforcement; this is a coarse pre-gate). The subtask's
  //   required `capability` is passed so a production resolver can pre-gate it against the agent's
  //   declared toolWhitelist (defense-in-depth).
  readonly runtimeAllowed?: (
    event: DeepAgentEvent.Event,
    agent: AgentDescriptor,
    capability: string,
  ) => Effect.Effect<boolean>
  //   §E2 per-workspace agent-execution concurrency cap. When provided, a subtask is admitted only if
  //   the workspace is below its cap (default 5); over-cap subtasks defer (retryable), never drop.
  //   Omitted ⇒ no cap (current behavior; tests don't need it).
  readonly concurrency?: WorkspaceConcurrency.Interface
  //   §C3.1 physical file-lock enforcement. When provided, a subtask that is about to run acquires an
  //   AGENT lock on each file in its scope; a file already held by another agent OR by a human (human
  //   locks make an agent acquire return null) DEFERS the subtask (retryable) so two concurrently-
  //   admitted subtasks never edit the same file — the arbiter DECIDES conflicts (§C3.3), the lock
  //   ENFORCES them. FAIL CLOSED: an acquire that returns null defers, never runs. Omitted ⇒ no locking
  //   (current behavior; the arbiter's in-pass claim tracking is the only guard).
  readonly fileLock?: FileLock.Interface
  //   §C3.3 code-graph symbol resolution. When provided, the symbols a subtask's file scope touches are
  //   resolved from the code graph and put on its ConflictArbiter.Claim so the arbiter's SEMANTIC layer
  //   (symbol overlap) can fire, not just file-scope overlap. FAIL SAFE: any resolver failure resolves to
  //   [] so file-level conflict detection still works. Omitted ⇒ symbols default to [] (file-level only).
  readonly symbolsForFiles?: (
    event: DeepAgentEvent.Event,
    files: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>>
  //   §E2 token budget — injectable clock for the per-agent-per-hour LLM token budget's fixed window.
  //   Defaults to Date.now; tests inject a mutable clock to cross the window boundary deterministically.
  readonly now?: () => number
  //   §E2 token budget window (ms). Defaults to 1 hour — the §E2 "max_tokens_per_hour" cadence.
  readonly tokenBudgetWindowMs?: number
  // V4.1 L40-2/L40-6/L40-7 durable execution authority. Production always supplies this service;
  // omission is retained only for narrow policy tests that do not exercise durable multi-process ownership.
  readonly execution?: AgentExecution.Interface
  // Unique identity for this runtime process. A different process uses a different owner while sharing
  // the durable execution table. Tests inject stable values to prove cross-runtime exclusion.
  readonly ownerID?: string
  readonly leaseMs?: number
  // Production collaboration boundary. Called only after every DAG node is durably terminal and receives
  // terminal leaf refs, so a serial fix -> test lineage becomes one PR while independent leaves stay separate.
  readonly onEventCompleted?: (input: {
    readonly event: DeepAgentEvent.Event
    readonly parentSessionID: SessionID
    readonly turns: ReadonlyArray<CompletedTurn>
  }) => Effect.Effect<void, unknown>
}

export const parentSessionIDFor = (eventID: DeepAgentEvent.ID): SessionID =>
  SessionID.make(`ses_v4_${eventID.replace(/^dae_/, "")}`)

export const layerWith = (options: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const agentList = yield* AgentListProviderService
      const approvalQueue = yield* ApprovalQueue.Service
      const concurrency = options.concurrency
      const fileLock = options.fileLock
      const symbolsForFiles = options.symbolsForFiles
      const runner = options.runner
      const partition =
        options.partition ??
        ((event: DeepAgentEvent.Event) => TaskPartitioner.partition(event, { stableIDPrefix: event.id }))
      const now = options.now ?? Date.now
      const tokenBudgetWindowMs = options.tokenBudgetWindowMs ?? 3_600_000 // 1h — §E2 max_tokens_per_hour
      const execution = options.execution
      const ownerID = options.ownerID ?? `mar_${Identifier.ascending()}`
      const leaseMs = options.leaseMs ?? AgentExecution.DEFAULT_LEASE_MS
      // §E2 LLM token budget fallback for policy tests that omit AgentExecution. Production reads and
      // debits the durable SQLite token ledger instead. The event turn runner threads the real per-turn
      // input+output+reasoning total, so an agent over maxTokensPerHour genuinely defers.
      const tokenUsage = new Map<string, { windowStart: number; used: number }>()
      const localTokensUsedThisHour = (agentID: string, at: number): number => {
        const bucket = tokenUsage.get(agentID)
        if (!bucket || at - bucket.windowStart >= tokenBudgetWindowMs) return 0
        return bucket.used
      }
      const debitLocalTokens = (agentID: string, tokens: number, at: number): void => {
        if (tokens <= 0) return
        const bucket = tokenUsage.get(agentID)
        if (!bucket || at - bucket.windowStart >= tokenBudgetWindowMs) {
          tokenUsage.set(agentID, { windowStart: at, used: tokens })
        } else {
          bucket.used += tokens
        }
      }
      const trustedSources = options.trustedSources
      const trustedSourcesFor = options.trustedSourcesFor
      const actorHasPermission = options.actorHasPermission ?? (() => Effect.succeed(true))
      const runtimeAllowed = options.runtimeAllowed ?? (() => Effect.succeed(true))

      const withExecutionLease = <A, E, R>(
        event: DeepAgentEvent.Event,
        record: AgentExecution.Record | undefined,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => {
        if (!execution || !record) return effect
        const heartbeat = execution
          .renew({
            workspaceID: event.workspaceID,
            eventID: event.id,
            taskID: record.taskID,
            ownerID,
            generation: record.generation,
            leaseMs,
          })
          .pipe(
            Effect.flatMap((renewed) => (renewed ? Effect.void : Effect.die(new Error("execution_lease_lost")))),
            Effect.repeat(Schedule.spaced(Duration.millis(Math.max(10, Math.floor(leaseMs / 3))))),
            Effect.flatMap(() => Effect.never),
          )
        return Effect.scoped(
          Effect.gen(function* () {
            const running = yield* Effect.forkScoped(effect)
            const renewal = yield* Effect.forkScoped(heartbeat)
            return yield* Effect.raceFirst(Fiber.join(running), Fiber.join(renewal)).pipe(
              Effect.ensuring(Effect.all([Fiber.interrupt(running), Fiber.interrupt(renewal)], { discard: true })),
            )
          }),
        )
      }

      const emit = (event: DeepAgentEvent.Event, payload: DeepAgentEvent.AgentCoordinationEvent, key: string) =>
        bus
          .publish({
            type: payload.type,
            source: COORDINATION_SOURCE,
            workspaceID: event.workspaceID,
            ...(event.projectID != null ? { projectID: event.projectID } : {}),
            correlationID: event.correlationID ?? event.id, // chain coordination to the triggering event
            causationID: event.id,
            idempotencyKey: key,
            priority: event.priority,
            payload,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("coordination emit failed", { cause: Cause.pretty(cause) })),
            ),
            Effect.asVoid,
          )

      // §D — publish an agent.task.needs_human escalation and offer it to the §D2 Approval Queue, so a
      // gated subtask (autonomy ceiling exceeded / suggestion_only) reaches a human instead of being
      // silently dropped. Best-effort: a bus/queue failure must not break coordination.
      const escalateForHuman = (
        event: DeepAgentEvent.Event,
        subtask: TaskPartitioner.Subtask,
        agent: AgentDescriptor,
        reason: string,
      ) =>
        bus
          .publish({
            type: LMNEvents.AGENT_TASK_NEEDS_HUMAN,
            source: COORDINATION_SOURCE,
            workspaceID: event.workspaceID,
            ...(event.projectID != null ? { projectID: event.projectID } : {}),
            correlationID: event.correlationID ?? event.id,
            causationID: event.id,
            idempotencyKey: `coord:${subtask.id}:needs_human`,
            priority: "high",
            payload: {
              taskID: subtask.id,
              agentID: agent.id,
              capability: subtask.capability,
              intent: subtask.intent,
              reason,
            },
          })
          .pipe(
            Effect.flatMap((escalation) => approvalQueue.offer(escalation)),
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("autonomy escalation failed", { cause: Cause.pretty(cause) })),
            ),
            Effect.asVoid,
          )

      const coordinate: Interface["coordinate"] = (event) =>
        Effect.gen(function* () {
          // stable ids keyed on event.id ⇒ re-dispatch (retry pump) mints the SAME subtask ids, so the
          // coordination idempotency keys + started-guard below dedupe duplicate execution.
          const p = partition(event)

          // §E1 layer-agnostic: a registry-lookup FAILURE is transient and must NOT be silently read as
          // "no agents" (which would block+ack every subtask and lose the event). Fail the Effect so the
          // dispatcher nacks for retry — matching event-dispatcher.handle's contract.
          const agents = yield* agentList.listAgents({
            workspaceID: event.workspaceID,
            userID: event.actorID ?? "system",
          })
          const promptPayload =
            event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
              ? Object.fromEntries(Object.entries(event.payload).filter(([key]) => key !== "directory"))
              : event.payload

          const outcomes: SubtaskOutcome[] = []
          // §C2 DAG gating: a subtask runs ONLY after all its dependencies COMPLETED. `completed` holds
          // ids that finished successfully this pass; a subtask whose dep is missing is itself blocked.
          const completed = new Set<string>()
          // Durable git refs produced by completed write turns. Dependents start from these exact refs, so
          // fix → test → review observes one continuous branch chain rather than restarting from HEAD.
          const completedTurns = new Map<
            string,
            {
              readonly agentID?: string
              readonly sessionID?: string
              readonly continuationRef?: string
              readonly artifacts: ReadonlyArray<string>
            }
          >()
          // Subtasks that may succeed on a later delivery (capacity, lock, transient runner failure). A
          // dependent inherits retryability only from this set; permanent policy/security blocks settle.
          const retryable = new Set<string>()
          // set when a subtask was DEFERRED (conflict) or its dep is unresolved — the event is not fully
          // handled, so `dispatch` must surface it (nack → retry) rather than ack it away.
          let hasUnfinished = false

          // transitive dependency set per subtask: a subtask that (transitively) DEPENDS ON another is
          // serialized AFTER it by the DAG, so the two never edit concurrently — they must NOT be
          // treated as a §C3 conflict even when their declared file scopes overlap. The arbiter only
          // governs subtasks that could run at the SAME time (no dependency ordering between them).
          const byID = new Map(p.subtasks.map((s) => [s.id, s]))
          const ancestorsOf = (id: string): Set<string> => {
            const acc = new Set<string>()
            const walk = (cur: string) => {
              const node = byID.get(cur)
              if (!node) return
              for (const dep of node.dependsOn) {
                if (!acc.has(dep)) {
                  acc.add(dep)
                  walk(dep)
                }
              }
            }
            walk(id)
            return acc
          }

          const waveByID = p.subtasks.reduce((levels, subtask) => {
            const dependencies = subtask.dependsOn.map((dependencyID) => levels.get(dependencyID))
            if (dependencies.some((level) => level === undefined)) {
              throw new Error(`MultiAgentRuntime: subtask ${subtask.id} depends on a missing or later task`)
            }
            levels.set(subtask.id, Math.max(-1, ...dependencies.filter((level) => level !== undefined)) + 1)
            return levels
          }, new Map<string, number>())
          const waves = [...new Set(waveByID.values())]
            .sort((a, b) => a - b)
            .map((wave) => p.subtasks.filter((subtask) => waveByID.get(subtask.id) === wave))

          for (const wave of waves) {
            // Admission is serialized within a wave so conflict claims, file locks, and concurrency slots
            // remain deterministic. Only fully-admitted runners execute in parallel.
            const admittedClaims: ConflictArbiter.Claim[] = []
            const running: Array<
              Effect.Effect<{
                readonly subtask: TaskPartitioner.Subtask
                readonly agent: AgentDescriptor
                readonly capable: ReadonlyArray<AgentDescriptor>
                readonly lease?: AgentExecution.Record
                readonly result: SubagentTurnResult
              }>
            > = []

            for (const subtask of wave) {
              // §C2 DAG gate: every dependency must have COMPLETED this pass. A dep that was blocked or
              // deferred leaves this subtask un-runnable — block it too (never run a dependent against a
              // dependency that didn't apply, e.g. review a change that was never made).
              const unmetDeps = subtask.dependsOn.filter((d) => !completed.has(d))
              if (unmetDeps.length > 0) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  reason: "dependency_not_met",
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: "dependency_not_met" },
                  `coord:${subtask.id}:blocked`,
                )
                if (unmetDeps.some((dependencyID) => retryable.has(dependencyID))) {
                  retryable.add(subtask.id)
                  hasUnfinished = true
                }
                continue
              }

              const dependencyWithoutContinuation = subtask.dependsOn.find((dependencyID) => {
                const dependency = byID.get(dependencyID)
                return (
                  dependency && requiresWriteIsolation(dependency) && !completedTurns.get(dependencyID)?.continuationRef
                )
              })
              if (dependencyWithoutContinuation) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "deferred",
                  reason: "dependency_continuation_missing",
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: "dependency_continuation_missing" },
                  `coord:${subtask.id}:blocked`,
                )
                retryable.add(subtask.id)
                hasUnfinished = true
                continue
              }
              const dependencyRefs = [
                ...new Set(
                  subtask.dependsOn.flatMap((dependencyID) => {
                    const continuationRef = completedTurns.get(dependencyID)?.continuationRef
                    return continuationRef ? [continuationRef] : []
                  }),
                ),
              ]
              if (dependencyRefs.length > 1) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "deferred",
                  reason: "dependency_branches_diverged",
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: "dependency_branches_diverged" },
                  `coord:${subtask.id}:blocked`,
                )
                retryable.add(subtask.id)
                hasUnfinished = true
                continue
              }

              // Durable execution state closes the crash window between committing a runner result and
              // publishing its coordination event. A completed row is authoritative; replay synthesizes
              // the idempotent event and restores the exact continuation without running the model again.
              const executionRecord = execution
                ? yield* execution.get({ workspaceID: event.workspaceID, eventID: event.id, taskID: subtask.id })
                : undefined
              if (executionRecord?.status === "completed") {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "completed",
                  agentID: executionRecord.agentID,
                  reason: "already_completed",
                })
                completed.add(subtask.id)
                completedTurns.set(subtask.id, {
                  agentID: executionRecord.agentID,
                  sessionID: executionRecord.artifacts
                    .find((artifact) => artifact.startsWith("session:"))
                    ?.slice("session:".length),
                  continuationRef: executionRecord.continuationRef,
                  artifacts: executionRecord.artifacts,
                })
                yield* emit(
                  event,
                  { type: "agent.task.completed", taskID: subtask.id, artifacts: executionRecord.artifacts },
                  `coord:${subtask.id}:completed`,
                )
                continue
              }
              if (executionRecord?.status === "failed") {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  agentID: executionRecord.agentID,
                  reason: executionRecord.lastError ?? "execution_failed",
                })
                continue
              }
              if (executionRecord?.status === "handoff_pending") {
                if (executionRecord.handoffID && executionRecord.agentID && executionRecord.handoffToAgentID) {
                  yield* emit(
                    event,
                    {
                      type: LMNEvents.AGENT_HANDOFF_REQUESTED,
                      handoffID: executionRecord.handoffID,
                      eventID: event.id,
                      taskID: subtask.id,
                      fromAgentID: executionRecord.agentID,
                      toAgentID: executionRecord.handoffToAgentID,
                      generation: executionRecord.generation,
                      reason: executionRecord.handoffReason ?? "runner_failed",
                      ...(executionRecord.continuationRef ? { continuationRef: executionRecord.continuationRef } : {}),
                    },
                    `handoff:${executionRecord.handoffID}`,
                  )
                }
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "deferred",
                  agentID: executionRecord.agentID,
                  reason: "handoff_pending",
                })
                retryable.add(subtask.id)
                hasUnfinished = true
                continue
              }

              // Event-level idempotency remains the compatibility path for rows completed before durable
              // execution ownership existed.
              // We check the `completed` marker, NOT `started`: a subtask emits `started` before running,
              // so guarding on `started` would treat a subtask that started-then-FAILED (runner_failed →
              // nacked → retried) as done and ack the retry away without ever redoing the work. Guarding on
              // `completed` means only genuinely-finished subtasks short-circuit; a failed one re-runs on
              // retry (the stable id keeps the started/completed idempotency keys stable across retries).
              const priorCompletion = yield* bus
                .recentByType({
                  type: "agent.task.completed",
                  workspaceID: event.workspaceID,
                  windowMs: Number.MAX_SAFE_INTEGER,
                  now: event.createdAt,
                })
                .pipe(
                  Effect.map((events) =>
                    events.find(
                      (candidate) => (candidate.payload as { taskID?: string } | undefined)?.taskID === subtask.id,
                    ),
                  ),
                  Effect.orElseSucceed(() => undefined),
                )
              if (priorCompletion) {
                const artifacts =
                  (priorCompletion.payload as { artifacts?: ReadonlyArray<string> } | undefined)?.artifacts ?? []
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "completed",
                  reason: "already_completed",
                })
                completed.add(subtask.id) // treat as done so dependents can proceed
                completedTurns.set(subtask.id, {
                  sessionID: artifacts.find((artifact) => artifact.startsWith("session:"))?.slice("session:".length),
                  continuationRef: continuationRefFrom(artifacts),
                  artifacts,
                })
                continue
              }

              // §C2 binds the durable handoff assignment when present; otherwise registry order wins.
              const capable = TaskPartitioner.capableAgents(subtask, agents)
              const agent = executionRecord?.assignedAgentID
                ? capable.find((candidate) => candidate.id === executionRecord.assignedAgentID)
                : capable[0]
              if (!agent) {
                const reason = executionRecord?.assignedAgentID ? "assigned_agent_unavailable" : "no_capable_agent"
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  reason,
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason },
                  `coord:${subtask.id}:blocked`,
                )
                continue
              }

              // §C1 max_files_changed — the agent's declared per-subtask file-scope ceiling. A subtask
              // whose declared write scope exceeds it is BLOCKED (terminal, not deferred): the partition's
              // fileScope is fixed, so a retry would present the SAME oversized scope — blocking is the
              // honest outcome (deferring would spin forever). Unset ⇒ no ceiling. Checked right after the
              // bind (it is an agent-vs-subtask fact) and before the autonomy/security gates.
              const maxFilesChanged = agent.limits?.maxFilesChanged
              if (maxFilesChanged != null && maxFilesChanged >= 0 && subtask.fileScope.length > maxFilesChanged) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  agentID: agent.id,
                  reason: "max_files_changed",
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: "max_files_changed" },
                  `coord:${subtask.id}:blocked`,
                )
                // terminal (retrying won't shrink the scope) — do NOT mark hasUnfinished.
                continue
              }

              // §D autonomy gate — the agent's ceiling vs the subtask's required level.
              const autonomy = AutonomyPolicy.decide({
                agentCeiling: AutonomyPolicy.resolveCeiling(agent),
                actionRequires: subtask.requiredAutonomy,
              })
              if (!autonomy.allowed) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  agentID: agent.id,
                  reason: `autonomy:${autonomy.reason}`,
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: `autonomy_exceeds_ceiling` },
                  `coord:${subtask.id}:blocked`,
                )
                // §D — surface to the human Approval Queue rather than silently dropping: the action needs
                // an autonomy level above this agent's ceiling.
                yield* escalateForHuman(event, subtask, agent, "autonomy_exceeds_ceiling")
                continue
              }
              // suggestion_only (level_5) never auto-executes — record as blocked-for-human, no run.
              if (autonomy.gate === "suggestion_only") {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  agentID: agent.id,
                  reason: "suggestion_only",
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: "suggestion_only" },
                  `coord:${subtask.id}:blocked`,
                )
                // §D — a level_5 suggestion_only action is a human decision by design → Approval Queue.
                yield* escalateForHuman(event, subtask, agent, "suggestion_only")
                continue
              }

              // §E1 four-layer security gate (fail-closed).
              // Layer 1 — event source trust. Prefer the PER-EVENT resolver (production: resolves the
              // workspace's trusted-source set); it TAKES PRECEDENCE over the static `trustedSources` and
              // FAILS CLOSED — a resolver error/defect resolves the source to NOT trusted rather than
              // opening. Only when NEITHER is configured does trust default open (tests/back-compat).
              const sourceTrusted = trustedSourcesFor
                ? yield* trustedSourcesFor(event).pipe(
                    Effect.map((sources) => SecurityGate.isTrustedSource(event.source, sources)),
                    Effect.catchCause(() => Effect.succeed(false)), // resolver failure ⇒ fail closed
                  )
                : trustedSources == null
                  ? true
                  : SecurityGate.isTrustedSource(event.source, trustedSources)
              const actorOk = yield* actorHasPermission(event, agent)
              const runtimeOk = yield* runtimeAllowed(event, agent, subtask.capability)
              const security = SecurityGate.check({
                eventSourceTrusted: sourceTrusted,
                actorHasPermission: actorOk,
                agentCapabilities: agent.capabilities ?? [],
                requiredCapability: subtask.capability,
                runtimeAllowed: runtimeOk,
              })
              if (!security.allowed) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "blocked",
                  agentID: agent.id,
                  reason: `security:${security.failedLayer}`,
                })
                yield* emit(
                  event,
                  { type: "agent.task.blocked", taskID: subtask.id, reason: `security_${security.failedLayer}` },
                  `coord:${subtask.id}:blocked`,
                )
                continue
              }

              // §C3 conflict arbitration — does this subtask's claim conflict with an already-admitted one?
              // §C3.3 resolve the code-graph symbols this subtask touches (fully-qualified per host file so
              // the same symbol name in different files does NOT false-conflict). FAIL SAFE: a resolver
              // failure resolves to [] so file-level detection still works.
              const symbols = symbolsForFiles
                ? yield* symbolsForFiles(event, subtask.fileScope).pipe(
                    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)),
                  )
                : []
              const claim: ConflictArbiter.Claim = {
                taskID: subtask.id,
                agentID: agent.id,
                files: subtask.fileScope,
                symbols,
                priority: event.priority,
                origin:
                  event.source === "im" || event.actorID != null
                    ? "human"
                    : event.source === "schedule"
                      ? "schedule"
                      : "system",
              }
              // only claims NOT in this subtask's dependency chain are true concurrent conflicts.
              const deps = ancestorsOf(subtask.id)
              const conflicting = admittedClaims.filter(
                (c) => !deps.has(c.taskID) && ConflictArbiter.conflicts(c, claim),
              )
              if (conflicting.length > 0) {
                const resolution = ConflictArbiter.resolve([...conflicting, claim])
                if (
                  resolution.type === "needs_human" ||
                  (resolution.type === "winner" && resolution.winner.taskID !== claim.taskID)
                ) {
                  // this claim lost (or the group needs a human) → defer it, don't run now.
                  outcomes.push({
                    taskID: subtask.id,
                    capability: subtask.capability,
                    status: "deferred",
                    agentID: agent.id,
                    reason: resolution.type === "needs_human" ? "conflict_needs_human" : "conflict_deferred",
                  })
                  // deferred = a DELAY, not a terminal drop (§C3): the conflicting winner must complete
                  // first. Mark the event unfinished so `dispatch` nacks → the retry pump re-drives it
                  // once the winner's claim clears, rather than acking the deferred work away forever.
                  retryable.add(subtask.id)
                  hasUnfinished = true
                  continue
                }
              }
              // §E2 LLM token budget — a per-agent-per-hour ceiling on tokens consumed. If the agent is
              // ALREADY at/over its declared maxTokensPerHour, DEFER this subtask (retryable — the window
              // rolls over, unlike max_files_changed which is terminal). Checked before acquiring a slot so
              // there is nothing to release on defer. Only bites when a budget is declared AND the runner
              // reports real token usage. P4.1: the production event turn runner now threads the real
              // per-turn total (input+output+reasoning) from the prompt result, so this gate is live in
              // production. A stub runner that reports 0 is a harmless no-op debit (budget enforcement
              // is correct; the gate just never triggers for stubs).
              const maxTokensPerHour = agent.limits?.maxTokensPerHour
              const usedTokens = execution
                ? yield* execution.tokensUsed({
                    workspaceID: event.workspaceID,
                    agentID: agent.id,
                    at: now(),
                    windowMs: tokenBudgetWindowMs,
                  })
                : localTokensUsedThisHour(agent.id, now())
              if (maxTokensPerHour != null && maxTokensPerHour >= 0 && usedTokens >= maxTokensPerHour) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "deferred",
                  agentID: agent.id,
                  reason: "token_budget_exceeded",
                })
                retryable.add(subtask.id)
                hasUnfinished = true
                continue
              }

              // §E2 concurrency cap — acquire a per-workspace execution slot. Over cap ⇒ DEFER (retryable
              // via the bus, not dropped), so a burst never runs more than the workspace's cap at once.
              const slot = concurrency ? yield* concurrency.acquire(event.workspaceID) : undefined
              if (slot && !slot.admitted) {
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "deferred",
                  agentID: agent.id,
                  reason: "concurrency_capped",
                })
                retryable.add(subtask.id)
                hasUnfinished = true
                continue
              }
              // §C3.1 physical file-lock enforcement (the ConflictArbiter above DECIDES conflicts; the
              // FileLock ENFORCES them). Acquire an AGENT lock on every file this subtask will write. A
              // file already held by another agent — OR by a HUMAN (a human lock makes an agent acquire
              // return null) — DEFERS the subtask (retryable), so two concurrently-admitted subtasks never
              // edit the same file. FAIL CLOSED: acquire === null ⇒ defer, never run.
              // §C3.2 physical isolation is enforced by the production runner. Write turns fail closed when
              // no worktree can be created; dependent turns receive the upstream durable ref below.
              const acquiredLocks: string[] = []
              if (fileLock) {
                // fileScope entries are repo-relative; resolve against the event's directory when it carries
                // one (a NON-"wrk" workspaceID doubles as a directory), else lock on the raw scope string —
                // lock keys only need to be CONSISTENT across subtasks of the same event, not real paths.
                const eventDir =
                  typeof (event.payload as { directory?: unknown } | null)?.directory === "string"
                    ? (event.payload as { directory: string }).directory
                    : event.workspaceID && !event.workspaceID.startsWith("wrk")
                      ? event.workspaceID
                      : undefined
                let contended = false
                for (const file of subtask.fileScope) {
                  const lockKey = eventDir ? path.resolve(eventDir, file) : file
                  const entry = fileLock.acquire(lockKey, "agent")
                  if (entry === null) {
                    contended = true
                    break
                  }
                  acquiredLocks.push(entry.lockId)
                }
                if (contended) {
                  for (const id of acquiredLocks) fileLock.release(id)
                  concurrency?.release(event.workspaceID)
                  outcomes.push({
                    taskID: subtask.id,
                    capability: subtask.capability,
                    status: "deferred",
                    agentID: agent.id,
                    reason: "file_locked",
                  })
                  // deferred = a DELAY, not a drop (§C3.1): the holding agent/human must release first.
                  retryable.add(subtask.id)
                  hasUnfinished = true
                  continue
                }
              }

              const releaseLocalAdmission = () => {
                concurrency?.release(event.workspaceID)
                if (fileLock) for (const id of acquiredLocks) fileLock.release(id)
              }
              const durableClaim = execution
                ? yield* execution.claim({
                    workspaceID: event.workspaceID,
                    eventID: event.id,
                    taskID: subtask.id,
                    ownerID,
                    agentID: agent.id,
                    resources: [
                      ...claim.files.map((file) => `file:${file}`),
                      ...claim.symbols.map((symbol) => `symbol:${symbol}`),
                    ],
                    leaseMs,
                  })
                : undefined
              if (durableClaim && durableClaim.type !== "claimed") {
                releaseLocalAdmission()
                if (durableClaim.type === "completed" && durableClaim.record) {
                  outcomes.push({
                    taskID: subtask.id,
                    capability: subtask.capability,
                    status: "completed",
                    agentID: durableClaim.record.agentID,
                    reason: "already_completed",
                  })
                  completed.add(subtask.id)
                  completedTurns.set(subtask.id, {
                    agentID: durableClaim.record.agentID,
                    sessionID: durableClaim.record.artifacts
                      .find((artifact) => artifact.startsWith("session:"))
                      ?.slice("session:".length),
                    continuationRef: durableClaim.record.continuationRef,
                    artifacts: durableClaim.record.artifacts,
                  })
                  yield* emit(
                    event,
                    { type: "agent.task.completed", taskID: subtask.id, artifacts: durableClaim.record.artifacts },
                    `coord:${subtask.id}:completed`,
                  )
                  continue
                }
                const terminal = durableClaim.type === "failed"
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: terminal ? "blocked" : "deferred",
                  agentID: durableClaim.record?.agentID ?? agent.id,
                  reason: `execution_${durableClaim.type}`,
                })
                if (!terminal) {
                  retryable.add(subtask.id)
                  hasUnfinished = true
                }
                continue
              }
              const executionLease = durableClaim?.record

              // record the claim only for a subtask that WILL run this pass — a concurrency-deferred task
              // must not leave a phantom claim that later subtasks would needlessly arbitrate against.
              admittedClaims.push(claim)

              // §C4 starts only after deterministic admission. Effect.all below runs every admitted turn
              // in this DAG wave concurrently; the next wave waits for all of them to settle.
              running.push(
                emit(
                  event,
                  { type: "agent.task.started", taskID: subtask.id, agentID: agent.id },
                  `coord:${subtask.id}:started`,
                ).pipe(
                  Effect.andThen(
                    withExecutionLease(
                      event,
                      executionLease,
                      runner({
                        agentType: agent.name,
                        prompt: [
                          subtask.intent,
                          "Work only inside the current Session directory and use repo-relative paths.",
                          `Triggering event: ${event.type} (${event.id}).`,
                          `Declared file scope: ${subtask.fileScope.length > 0 ? subtask.fileScope.join(", ") : "unspecified"}.`,
                          `Event payload: ${JSON.stringify(promptPayload)}`,
                        ].join("\n\n"),
                        workspaceID: event.workspaceID,
                        parentSessionID: parentSessionIDFor(event.id),
                        requiresWriteIsolation: requiresWriteIsolation(subtask),
                        ...(executionRecord?.continuationRef || dependencyRefs[0]
                          ? { baseRef: executionRecord?.continuationRef ?? dependencyRefs[0] }
                          : {}),
                        correlationID: event.correlationID ?? event.id,
                        ...(agent.limits?.maxTurnDurationMs != null
                          ? { maxTurnDurationMs: agent.limits.maxTurnDurationMs }
                          : {}),
                        ...(typeof (event.payload as { directory?: unknown } | null)?.directory === "string"
                          ? { directory: (event.payload as { directory: string }).directory }
                          : {}),
                      }),
                    ).pipe(
                      Effect.catchCause((cause) => {
                        log.error("subtask runner failed", { taskID: subtask.id, cause: Cause.pretty(cause) })
                        const reason = Cause.pretty(cause).includes("execution_lease_lost")
                          ? "execution_lease_lost"
                          : "runner_failed"
                        return Effect.succeed({
                          ok: false,
                          reason,
                          structured: undefined,
                          text: "",
                          tokensUsed: 0,
                          cost: 0,
                        } satisfies SubagentTurnResult)
                      }),
                    ),
                  ),
                  Effect.map((result) => ({ subtask, agent, capable, lease: executionLease, result })),
                  Effect.ensuring(Effect.sync(releaseLocalAdmission)),
                ),
              )
            }

            const settled = yield* Effect.all(running, { concurrency: "unbounded" })
            for (const { subtask, agent, capable, lease, result } of settled) {
              if (result.ok) {
                const artifacts = [
                  ...new Set([
                    ...(result.sessionID ? [`session:${result.sessionID}`] : []),
                    ...(result.artifacts ?? []),
                    ...(result.continuationRef ? [`${GIT_REF_ARTIFACT_PREFIX}${result.continuationRef}`] : []),
                  ]),
                ]
                const completedLease =
                  execution && lease
                    ? yield* execution.complete({
                        workspaceID: event.workspaceID,
                        eventID: event.id,
                        taskID: subtask.id,
                        ownerID,
                        generation: lease.generation,
                        ...(result.continuationRef ? { continuationRef: result.continuationRef } : {}),
                        artifacts,
                        tokensUsed: result.tokensUsed,
                        tokenAt: now(),
                        tokenWindowMs: tokenBudgetWindowMs,
                      })
                    : true
                if (!completedLease) {
                  outcomes.push({
                    taskID: subtask.id,
                    capability: subtask.capability,
                    status: "deferred",
                    agentID: agent.id,
                    reason: "execution_lease_lost",
                  })
                  retryable.add(subtask.id)
                  hasUnfinished = true
                  continue
                }
                if (!execution) debitLocalTokens(agent.id, result.tokensUsed, now())
                outcomes.push({
                  taskID: subtask.id,
                  capability: subtask.capability,
                  status: "completed",
                  agentID: agent.id,
                })
                completed.add(subtask.id)
                completedTurns.set(subtask.id, {
                  agentID: agent.id,
                  sessionID: result.sessionID,
                  continuationRef: result.continuationRef,
                  artifacts,
                })
                yield* emit(
                  event,
                  { type: "agent.task.completed", taskID: subtask.id, artifacts },
                  `coord:${subtask.id}:completed`,
                )
                continue
              }

              const reason = result.reason ?? "runner_failed"
              const permanent = reason === "isolation_unavailable" || reason === "isolation_preservation_failed"
              if (execution && lease) {
                const alternate = permanent ? undefined : capable.find((candidate) => candidate.id !== agent.id)
                if (alternate) {
                  const handoffID = `${event.id}:${subtask.id}:${lease.generation}:${alternate.id}`
                  const pending = yield* execution.prepareHandoff({
                    workspaceID: event.workspaceID,
                    eventID: event.id,
                    taskID: subtask.id,
                    ownerID,
                    generation: lease.generation,
                    handoffID,
                    toAgentID: alternate.id,
                    reason,
                    ...(result.continuationRef ? { continuationRef: result.continuationRef } : {}),
                    tokensUsed: result.tokensUsed,
                    tokenAt: now(),
                    tokenWindowMs: tokenBudgetWindowMs,
                  })
                  if (pending) {
                    yield* emit(
                      event,
                      {
                        type: LMNEvents.AGENT_HANDOFF_REQUESTED,
                        handoffID,
                        eventID: event.id,
                        taskID: subtask.id,
                        fromAgentID: agent.id,
                        toAgentID: alternate.id,
                        generation: lease.generation,
                        reason,
                        ...(result.continuationRef ? { continuationRef: result.continuationRef } : {}),
                      },
                      `handoff:${handoffID}`,
                    )
                    outcomes.push({
                      taskID: subtask.id,
                      capability: subtask.capability,
                      status: "deferred",
                      agentID: agent.id,
                      reason: "handoff_requested",
                    })
                    retryable.add(subtask.id)
                    hasUnfinished = true
                    continue
                  }
                }
                const released = yield* execution.release({
                  workspaceID: event.workspaceID,
                  eventID: event.id,
                  taskID: subtask.id,
                  ownerID,
                  generation: lease.generation,
                  retryable: !permanent,
                  reason,
                  tokensUsed: result.tokensUsed,
                  tokenAt: now(),
                  tokenWindowMs: tokenBudgetWindowMs,
                })
                if (!released) {
                  outcomes.push({
                    taskID: subtask.id,
                    capability: subtask.capability,
                    status: "deferred",
                    agentID: agent.id,
                    reason: "execution_lease_lost",
                  })
                  retryable.add(subtask.id)
                  hasUnfinished = true
                  continue
                }
              }
              if (!execution) debitLocalTokens(agent.id, result.tokensUsed, now())
              outcomes.push({
                taskID: subtask.id,
                capability: subtask.capability,
                status: "blocked",
                agentID: agent.id,
                reason,
              })
              yield* emit(
                event,
                { type: "agent.task.blocked", taskID: subtask.id, reason },
                `coord:${subtask.id}:blocked`,
              )
              if (permanent) {
                yield* escalateForHuman(event, subtask, agent, reason)
                continue
              }
              retryable.add(subtask.id)
              hasUnfinished = true
            }
          }

          if (!hasUnfinished && options.onEventCompleted) {
            const dependedOn = new Set(p.subtasks.flatMap((subtask) => subtask.dependsOn))
            const turns = p.subtasks.flatMap((subtask) => {
              const completedTurn = completedTurns.get(subtask.id)
              if (dependedOn.has(subtask.id) || !completedTurn) return []
              return [{ task: subtask, ...completedTurn } satisfies CompletedTurn]
            })
            yield* options.onEventCompleted({ event, parentSessionID: parentSessionIDFor(event.id), turns })
          }

          return { event, outcomes, hasUnfinished }
        })

      // dispatch: if any subtask was deferred / dep-unmet / runner-failed, FAIL so the Event Dispatcher
      // nacks and the retry pump re-drives the event (idempotent thanks to stable ids + started-guard).
      // A coordination where every subtask reached a terminal state (completed, or blocked for a
      // permanent reason like no_capable_agent / autonomy / security / suggestion_only) returns void →
      // the dispatcher acks. NOTE: no_capable_agent/autonomy/security are treated as TERMINAL here
      // (retrying won't change the registry/gates); only deferred + runner_failed + dep_not_met retry.
      const dispatch: Interface["dispatch"] = (request) =>
        coordinate(request.event).pipe(
          Effect.flatMap((summary) =>
            summary.hasUnfinished
              ? Effect.fail(new Error(`multi-agent coordination incomplete for event ${request.event.id}`))
              : Effect.void,
          ),
        )

      return Service.of({ dispatch, coordinate })
    }),
  )
