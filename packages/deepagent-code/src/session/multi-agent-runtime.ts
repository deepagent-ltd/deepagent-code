export * as MultiAgentRuntime from "./multi-agent-runtime"

import path from "node:path"
import { Context, Effect, Layer, Cause } from "effect"
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
import { FileLock } from "@deepagent-code/core/file-lock"
import type { SubagentTurnRunner, SubagentTurnResult } from "./goal-loop-wiring"
import type { EventDispatcher } from "./event-dispatcher"
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

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/MultiAgentRuntime") {}

export interface LayerOptions {
  // the one-turn runner (production: makeTaskSubagentRunner). Tests inject a fake.
  readonly runner: SubagentTurnRunner
  // resolved facts the pure gates need but the runtime can't know purely:
  //   trusted event sources (§E1 layer 1) — default: all sources trusted (lenient; tighten per deploy).
  readonly trustedSources?: ReadonlyArray<DeepAgentEvent.EventSource>
  //   trusted event sources resolved PER-EVENT (§E1 layer 1, PRODUCTION). Trusted sources are a
  //   PER-WORKSPACE fact (SecurityResolvers.resolveTrustedSources(workspaceID)), so the static
  //   `trustedSources` array cannot express them; when provided this resolver is consulted with the
  //   actual event and TAKES PRECEDENCE over `trustedSources`. FAIL CLOSED: any resolver failure (typed
  //   error OR defect) resolves the source to NOT trusted rather than opening. The static option is kept
  //   for tests/back-compat.
  readonly trustedSourcesFor?: (
    event: DeepAgentEvent.Event,
  ) => Effect.Effect<ReadonlyArray<DeepAgentEvent.EventSource>>
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
}

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
      const now = options.now ?? Date.now
      const tokenBudgetWindowMs = options.tokenBudgetWindowMs ?? 3_600_000 // 1h — §E2 max_tokens_per_hour
      // §E2 LLM token budget — a per-agent fixed-window token accumulator (agentID → {windowStart, used}).
      // A subtask is admitted only if the agent is not ALREADY over its declared maxTokensPerHour; after a
      // turn we DEBIT the runner's reported tokensUsed. In-memory + process-local (mirrors the bus's
      // publishLimiter): a single runtime instance owns it. P4.1 — the production event turn runner now
      // threads the REAL per-turn token total (input+output+reasoning) from the prompt result, so this
      // budget is LIVE: an agent over maxTokensPerHour genuinely defers. (A stub runner that reports 0 is
      // still a harmless no-op debit — the tracker + enforcement are real either way.)
      const tokenUsage = new Map<string, { windowStart: number; used: number }>()
      const tokensUsedThisHour = (agentID: string, at: number): number => {
        const bucket = tokenUsage.get(agentID)
        if (!bucket || at - bucket.windowStart >= tokenBudgetWindowMs) return 0
        return bucket.used
      }
      const debitTokens = (agentID: string, tokens: number, at: number): void => {
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
            payload: { taskID: subtask.id, agentID: agent.id, capability: subtask.capability, intent: subtask.intent, reason },
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
          const p = TaskPartitioner.partition(event, { stableIDPrefix: event.id })

          // §E1 layer-agnostic: a registry-lookup FAILURE is transient and must NOT be silently read as
          // "no agents" (which would block+ack every subtask and lose the event). Fail the Effect so the
          // dispatcher nacks for retry — matching event-dispatcher.handle's contract.
          const agents = yield* agentList.listAgents({
            workspaceID: event.workspaceID,
            userID: event.actorID ?? "system",
          })

          const outcomes: SubtaskOutcome[] = []
          // built up as subtasks are admitted, so the arbiter sees the running claim set (§C3).
          const admittedClaims: ConflictArbiter.Claim[] = []
          // §C2 DAG gating: a subtask runs ONLY after all its dependencies COMPLETED. `completed` holds
          // ids that finished successfully this pass; a subtask whose dep is missing is itself blocked.
          const completed = new Set<string>()
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

          for (const subtask of p.subtasks) {
            // §C2 DAG gate: every dependency must have COMPLETED this pass. A dep that was blocked or
            // deferred leaves this subtask un-runnable — block it too (never run a dependent against a
            // dependency that didn't apply, e.g. review a change that was never made).
            const unmetDeps = subtask.dependsOn.filter((d) => !completed.has(d))
            if (unmetDeps.length > 0) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", reason: "dependency_not_met" })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: "dependency_not_met" }, `coord:${subtask.id}:blocked`)
              hasUnfinished = true
              continue
            }

            // idempotency: if a prior coordination already COMPLETED this subtask, don't re-run it.
            // We check the `completed` marker, NOT `started`: a subtask emits `started` before running,
            // so guarding on `started` would treat a subtask that started-then-FAILED (runner_failed →
            // nacked → retried) as done and ack the retry away without ever redoing the work. Guarding on
            // `completed` means only genuinely-finished subtasks short-circuit; a failed one re-runs on
            // retry (the stable id keeps the started/completed idempotency keys stable across retries).
            const alreadyCompleted = yield* bus
              .recentByType({ type: "agent.task.completed", workspaceID: event.workspaceID, windowMs: Number.MAX_SAFE_INTEGER, now: event.createdAt })
              .pipe(
                Effect.map((events) =>
                  events.some((e) => (e.payload as { taskID?: string } | undefined)?.taskID === subtask.id),
                ),
                Effect.orElseSucceed(() => false),
              )
            if (alreadyCompleted) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "completed", reason: "already_completed" })
              completed.add(subtask.id) // treat as done so dependents can proceed
              continue
            }

            // §C2 bind a capable agent (first in registry order).
            const capable = TaskPartitioner.capableAgents(subtask, agents)
            const agent = capable[0]
            if (!agent) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", reason: "no_capable_agent" })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: "no_capable_agent" }, `coord:${subtask.id}:blocked`)
              continue
            }

            // §C1 max_files_changed — the agent's declared per-subtask file-scope ceiling. A subtask
            // whose declared write scope exceeds it is BLOCKED (terminal, not deferred): the partition's
            // fileScope is fixed, so a retry would present the SAME oversized scope — blocking is the
            // honest outcome (deferring would spin forever). Unset ⇒ no ceiling. Checked right after the
            // bind (it is an agent-vs-subtask fact) and before the autonomy/security gates.
            const maxFilesChanged = agent.limits?.maxFilesChanged
            if (maxFilesChanged != null && maxFilesChanged >= 0 && subtask.fileScope.length > maxFilesChanged) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", agentID: agent.id, reason: "max_files_changed" })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: "max_files_changed" }, `coord:${subtask.id}:blocked`)
              // terminal (retrying won't shrink the scope) — do NOT mark hasUnfinished.
              continue
            }

            // §D autonomy gate — the agent's ceiling vs the subtask's required level.
            const autonomy = AutonomyPolicy.decide({
              agentCeiling: AutonomyPolicy.resolveCeiling(agent),
              actionRequires: subtask.requiredAutonomy,
            })
            if (!autonomy.allowed) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", agentID: agent.id, reason: `autonomy:${autonomy.reason}` })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: `autonomy_exceeds_ceiling` }, `coord:${subtask.id}:blocked`)
              // §D — surface to the human Approval Queue rather than silently dropping: the action needs
              // an autonomy level above this agent's ceiling.
              yield* escalateForHuman(event, subtask, agent, "autonomy_exceeds_ceiling")
              continue
            }
            // suggestion_only (level_5) never auto-executes — record as blocked-for-human, no run.
            if (autonomy.gate === "suggestion_only") {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", agentID: agent.id, reason: "suggestion_only" })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: "suggestion_only" }, `coord:${subtask.id}:blocked`)
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
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", agentID: agent.id, reason: `security:${security.failedLayer}` })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: `security_${security.failedLayer}` }, `coord:${subtask.id}:blocked`)
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
              origin: event.source === "im" || event.actorID != null ? "human" : event.source === "schedule" ? "schedule" : "system",
            }
            // only claims NOT in this subtask's dependency chain are true concurrent conflicts.
            const deps = ancestorsOf(subtask.id)
            const conflicting = admittedClaims.filter((c) => !deps.has(c.taskID) && ConflictArbiter.conflicts(c, claim))
            if (conflicting.length > 0) {
              const resolution = ConflictArbiter.resolve([...conflicting, claim])
              if (resolution.type === "needs_human" || (resolution.type === "winner" && resolution.winner.taskID !== claim.taskID)) {
                // this claim lost (or the group needs a human) → defer it, don't run now.
                outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "deferred", agentID: agent.id, reason: resolution.type === "needs_human" ? "conflict_needs_human" : "conflict_deferred" })
                // deferred = a DELAY, not a terminal drop (§C3): the conflicting winner must complete
                // first. Mark the event unfinished so `dispatch` nacks → the retry pump re-drives it
                // once the winner's claim clears, rather than acking the deferred work away forever.
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
            if (maxTokensPerHour != null && maxTokensPerHour >= 0 && tokensUsedThisHour(agent.id, now()) >= maxTokensPerHour) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "deferred", agentID: agent.id, reason: "token_budget_exceeded" })
              hasUnfinished = true
              continue
            }

            // §E2 concurrency cap — acquire a per-workspace execution slot. Over cap ⇒ DEFER (retryable
            // via the bus, not dropped), so a burst never runs more than the workspace's cap at once.
            const slot = concurrency ? yield* concurrency.acquire(event.workspaceID) : undefined
            if (slot && !slot.admitted) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "deferred", agentID: agent.id, reason: "concurrency_capped" })
              hasUnfinished = true
              continue
            }
            // §C3.1 physical file-lock enforcement (the ConflictArbiter above DECIDES conflicts; the
            // FileLock ENFORCES them). Acquire an AGENT lock on every file this subtask will write. A
            // file already held by another agent — OR by a HUMAN (a human lock makes an agent acquire
            // return null) — DEFERS the subtask (retryable), so two concurrently-admitted subtasks never
            // edit the same file. FAIL CLOSED: acquire === null ⇒ defer, never run.
            // §C3.2: physical branch/worktree isolation per agent is DEFERRED; the FileLock acquisition
            // (§C3.1) + ConflictArbiter (§C3.3) provide the concurrency-safety guarantee (no two
            // concurrently-admitted subtasks edit the same file/symbol) without separate worktrees.
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
                outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "deferred", agentID: agent.id, reason: "file_locked" })
                // deferred = a DELAY, not a drop (§C3.1): the holding agent/human must release first.
                hasUnfinished = true
                continue
              }
            }

            // record the claim only for a subtask that WILL run this pass — a concurrency-deferred task
            // must not leave a phantom claim that later subtasks would needlessly arbitrate against.
            admittedClaims.push(claim)

            // §C4 started → run one turn → completed/blocked. Release the concurrency slot AND the file
            // locks when the turn settles (ensuring runs on success, failure, and interruption).
            yield* emit(event, { type: "agent.task.started", taskID: subtask.id, agentID: agent.id }, `coord:${subtask.id}:started`)
            const result = yield* runner({
              agentType: agent.name,
              prompt: `${subtask.intent}\n\nTriggering event: ${event.type} (${event.id}).`,
              // §C — root the turn in the triggering event's workspace (the event-driven runner has no
              // parent session; it creates a fresh root session here). actorID-less events fall back to
              // the workspaceID as the directory (single-user / directory-routed model).
              workspaceID: event.workspaceID,
              // §F2 trace back-half — carry the triggering event's correlationID (falling back to its id,
              // mirroring the coordination-event chaining above) into the child session the runner creates.
              // The runner STAMPS this onto the child session's metadata.correlationID, and
              // Observability.trace READS it back (json_extract on metadata) to append the child session as
              // a "session" node — together these two halves let the §F2 trace follow correlationID from the
              // event DOWN into the child session's activity (its message / tool-call turns), instead of
              // stopping at the coordination events. The stamp alone is inert without the trace-query read.
              correlationID: event.correlationID ?? event.id,
              // §C1/§G — thread the agent's declared per-turn wall-clock ceiling to the runner; the event
              // turn runner applies it via Effect.timeout, falling back to its fixed default when unset.
              ...(agent.limits?.maxTurnDurationMs != null ? { maxTurnDurationMs: agent.limits.maxTurnDurationMs } : {}),
              ...(typeof (event.payload as { directory?: unknown } | null)?.directory === "string"
                ? { directory: (event.payload as { directory: string }).directory }
                : {}),
            }).pipe(
              Effect.catchCause((cause) => {
                log.error("subtask runner failed", { taskID: subtask.id, cause: Cause.pretty(cause) })
                return Effect.succeed({ ok: false, structured: undefined, text: "", tokensUsed: 0, cost: 0 } satisfies SubagentTurnResult)
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  concurrency?.release(event.workspaceID)
                  if (fileLock) for (const id of acquiredLocks) fileLock.release(id)
                }),
              ),
            )
            // §E2 — DEBIT the tokens this turn actually consumed against the agent's per-hour budget, so
            // the NEXT subtask this pass (and future events within the window) see the running total. P4.1 —
            // the event turn runner now reports the real total, so this debit is live (a stub runner that
            // reports 0 is simply a no-op debit).
            debitTokens(agent.id, result.tokensUsed, now())

            if (result.ok) {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "completed", agentID: agent.id })
              completed.add(subtask.id) // unblocks dependents in this pass
              // §F2 artifacts — emit the REAL artifacts this subtask produced, not a hardcoded []. What is
              // honestly available at this seam is the child session the runner ran in (result.sessionID,
              // added in P1): a stable `session:<id>` handle the §F2 trace + Oversight use to pivot from the
              // completed event into the child's activity (its tool calls / message / PR are queried by
              // sessionID). The changed-file set is NOT resolvable here — the runtime holds no Session
              // handle (the runner is an injected port) — so we emit what we genuinely have rather than
              // fabricating a file list. An older/stub runner that returns no sessionID yields [].
              const artifacts = result.sessionID ? [`session:${result.sessionID}`] : []
              yield* emit(event, { type: "agent.task.completed", taskID: subtask.id, artifacts }, `coord:${subtask.id}:completed`)
            } else {
              outcomes.push({ taskID: subtask.id, capability: subtask.capability, status: "blocked", agentID: agent.id, reason: "runner_failed" })
              yield* emit(event, { type: "agent.task.blocked", taskID: subtask.id, reason: "runner_failed" }, `coord:${subtask.id}:blocked`)
              hasUnfinished = true // a failed turn should be retried
            }
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
