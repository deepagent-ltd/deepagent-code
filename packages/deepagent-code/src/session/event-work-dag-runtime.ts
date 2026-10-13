export * as EventWorkDagRuntime from "./event-work-dag-runtime"

import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { EventWorkController } from "@deepagent-code/core/deepagent/event-work-controller"
import { EventWorkDagPolicy } from "@deepagent-code/core/deepagent/event-work-dag.policy"
import { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import { EventWorkNodeAuthority } from "@deepagent-code/core/deepagent/event-work-node-authority"
import { EventWorkResult } from "@deepagent-code/core/deepagent/event-work-result"
import { EventWorkRule } from "@deepagent-code/core/deepagent/event-work-rule"
import { EventWorkSource } from "@deepagent-code/core/deepagent/event-work-source"
import { EventV2 } from "@deepagent-code/core/event"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Service } from "@/installation/work-execution-profile"
import type { SubagentTurnInput, SubagentTurnResult } from "./goal-loop-wiring"

const failed = (reason: string): SubagentTurnResult => ({ ok: false, reason, structured: undefined, text: "", tokensUsed: 0, cost: 0 })
const known = (value: { terminal: EventWorkDagSchema.Terminal; text: string }): SubagentTurnResult => ({
  ok: value.terminal.outcome === "succeeded", ...(value.terminal.outcome === "failed" ? { reason: "event_node_failed" } : {}),
  structured: undefined, text: value.text, sessionID: value.terminal.sessionID, tokensUsed: value.terminal.chargedTokens, cost: 0,
  ...(value.terminal.workspaceRef ? { continuationRef: value.terminal.workspaceRef } : {}),
  artifacts: [`event-terminal:${EventWorkDagPolicy.hash(value.terminal)}`, `work:${value.terminal.workID}`,
    ...(value.terminal.workspaceCommit ? [`git-commit:${value.terminal.workspaceCommit}`, `git-ref:${value.terminal.workspaceRef}`] : [])],
})

/** Owns no scheduler, model or Session-specific layer. All physical work uses the original Root's
 * process-global Session coordinator and the Core's durable, explicitly approved node authority. */
export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const sessions = yield* SessionV2.Service
  const execution = yield* SessionExecution.Service
  const events = yield* EventV2Bridge.Service
  const installed = yield* Effect.serviceOption(Service)
  const withKnownProof = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(installed) && installed.value.leafProof
      ? effect.pipe(Effect.provideService(WorkToolPolicy.LeafProof, installed.value.leafProof)) : effect
  const release = (workID: string) => Option.isSome(installed) && installed.value.leafProof?.releaseEventTerminal
    ? installed.value.leafProof.releaseEventTerminal(workID) : Effect.void
  const withCurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
    if (Option.isNone(installed)) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
    const runtime = yield* installed.value.eventWorkAuthority
    const prepared = installed.value.eventPlacement ? withKnownProof(effect).pipe(Effect.provideService(EventWorkPlacement.Service, installed.value.eventPlacement)) : withKnownProof(effect)
    return yield* prepared.pipe(Effect.provideService(LocalOperator.Runtime, runtime),
      Effect.provideService(WorkAuthority.Verifier, installed.value.verifier),
      Effect.provideService(Database.Service, database), Effect.provideService(SessionV2.Service, sessions),
      Effect.provideService(EventV2.Service, events))
  })
  const prepare = (event: DeepAgentEvent.Event) => withCurrent(Effect.gen(function* () {
    const history = yield* EventWorkController.read(database.db, { eventID: event.id })
    const knownTerminal = history?.controller.state === "succeeded" || history?.controller.state === "failed"
    const value = knownTerminal ? history! : yield* EventWorkController.prepare(database.db, { eventID: event.id })
    if (event.type !== EventWorkRule.EVENT_TYPE || event.source !== "system" || event.id !== value.receipt.eventID ||
      event.workspaceID !== value.rootBinding.scope.workspaceID || event.projectID !== value.rootBinding.projectScope.projectID ||
      event.actorID !== value.rootBinding.scope.actorID || event.idempotencyKey !== value.receipt.occurrenceKey ||
      EventWorkSource.hash(event.payload) !== value.receipt.sourceHash)
      return yield* EventWorkDagPolicy.failure("EVENT_DAG_CONFLICT")
    const root = yield* WorkAuthority.get(database.db, value.controller.rootWorkID)
    if (!root || root.binding_hash !== value.controller.rootBindingHash) return yield* EventWorkDagPolicy.failure("EVENT_DAG_CONFLICT")
    // Materializing a controller is only a lineage/queue fact. It is never woken or resumed.
    if (!knownTerminal && root.admission_state !== "ready") yield* WorkAdmission.materializeReserved({
      workID: root.work_id, expectedRevision: root.control_revision, auditedText: value.receipt.auditedText,
    })
    return value
  }))
  const terminal = (workID: string) => withKnownProof(Effect.gen(function* () {
    yield* EventWorkResult.prepareTerminal(database.db, workID)
    return yield* database.db.transaction((tx) => EventWorkResult.readTerminal(tx, workID))
  }))
  const readKnown = (eventID: string, nodeID: string) => Effect.gen(function* () {
    const value = yield* EventWorkController.read(database.db, { eventID })
    if (!value || !value.controller.plan.nodes.some((node) => node.id === nodeID)) return undefined
    const ids = EventWorkDagPolicy.identities(value.controller.receiptID, nodeID)
    if (!ids.workID) return undefined
    const work = yield* WorkAuthority.get(database.db, ids.workID)
    if (!work || work.outcome === "pending") return undefined
    if (work.outcome === "unknown") return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNKNOWN")
    return yield* Effect.gen(function* () {
    const authority = yield* EventWorkNodeAuthority.get(database.db, ids.workID!)
    if (authority?.placement) {
      if (Option.isNone(installed) || !installed.value.eventPlacement) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
      yield* withKnownProof(installed.value.eventPlacement.settleKnown(ids.workID))
    }
    const settled = yield* terminal(ids.workID).pipe(Effect.catch((error) => error instanceof EventWorkDagSchema.Error && error.code === "EVENT_DAG_NOT_READY"
      ? Effect.succeed(undefined) : Effect.fail(error)))
    if (settled) yield* withKnownProof(EventWorkController.recordTerminal(database.db, { controllerID: value.controller.controllerID, nodeID }))
    return settled
    }).pipe(Effect.ensuring(release(ids.workID)))
  })
  const run = (input: SubagentTurnInput) => Effect.gen(function* () {
    if (!input.eventID || !input.taskID) return failed("event_node_invalid")
    // Already-occurred terminal facts can settle receipts after expiry, without dispatch authority.
    const prior = yield* readKnown(input.eventID, input.taskID)
    if (prior) return known(prior)
    return yield* withCurrent(Effect.gen(function* () {
      const history = yield* EventWorkController.read(database.db, { eventID: input.eventID! })
      if (!history) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
      const value = yield* EventWorkController.current(database.db, { controllerID: history.controller.controllerID })
      const node = value.controller.plan.nodes.find((item) => item.id === input.taskID)
      if (!node || node.agentID !== input.agentType || input.parentSessionID !== value.controller.rootSessionID)
        return yield* EventWorkDagPolicy.failure("EVENT_DAG_CONFLICT")
      const isolated = EventWorkDagPolicy.requiresPlacement(value.controller.plan, node)
      if (input.requiresWriteIsolation && !isolated) return failed("isolation_unavailable")
      if (Option.isNone(installed)) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
      const port = installed.value.eventPlacement
      if (isolated && !port) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
      const placement = isolated ? yield* port!.prepare({ controllerID: value.controller.controllerID,
        nodeID: node.id, expectedRevision: value.controller.revision }).pipe(Effect.scoped) : undefined
      const revision = placement ? installed.value.eventPlacement?.describe(placement)?.controllerRevision : value.controller.revision
      if (!revision) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
      const reserved = yield* EventWorkNodeAuthority.reserve(database.db, {
        controllerID: value.controller.controllerID, nodeID: node.id, expectedRevision: revision,
      })
      if (Option.isNone(installed)) return yield* EventWorkDagPolicy.failure("EVENT_DAG_UNAVAILABLE")
      return yield* Effect.gen(function* () {
      yield* installed.value.profile.prepareSource?.(reserved.work) ?? Effect.void
      yield* WorkAdmission.materializeReserved({ workID: reserved.work.work_id,
        expectedRevision: reserved.work.control_revision, auditedText: reserved.auditedText })
      yield* EventWorkNodeAuthority.current(database.db, { workID: reserved.work.work_id })
      // Public Session.resume is an ordinary mutation and deliberately refuses bound Work.
      // The original process-global execution service owns this internally admitted drain.
      const result = yield* execution.resume(SessionSchema.ID.make(reserved.work.session_id)).pipe(
        Effect.tapCause((cause) => executionDiagnostic(cause)), Effect.exit)
      const observed = yield* (placement ? installed.value.eventPlacement!.settle(placement).pipe(
        Effect.andThen(() => terminal(reserved.work.work_id))) : terminal(reserved.work.work_id)).pipe(Effect.exit)
      if (Exit.isSuccess(observed)) {
        yield* EventWorkController.recordTerminal(database.db, { controllerID: value.controller.controllerID, nodeID: node.id })
        return known(observed.value)
      }
      // Neither an exception nor an elapsed deadline proves the provider did nothing. Core
      // alone may classify real outstanding Work debt; no new child or ordinary retry is minted.
      yield* EventWorkController.markUnknown(database.db, { controllerID: value.controller.controllerID, nodeID: node.id })
      return failed(Exit.isFailure(result) ? "event_node_execution_unavailable" : "event_node_terminal_unavailable")
      }).pipe(Effect.ensuring(release(reserved.work.work_id)))
    }))
  })
  return { prepare, readKnown, run }
})
export type Port = Effect.Success<typeof make>

function executionDiagnostic(cause: Cause.Cause<unknown>) {
  const known = cause.reasons.flatMap((reason) => {
    const error = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ _tag: WorkAuthoritySchema.Error.fields._tag,
      code: WorkAuthoritySchema.Error.fields.code }))(error)
    return Option.isSome(decoded) ? [decoded.value] : []
  })[0]
  return Effect.logWarning(`event_work_original_execution_refused ${JSON.stringify({ stage: "internal_resume",
    tag: known?._tag ?? "UNCLASSIFIED", code: known?.code ?? "UNCLASSIFIED" })}`)
}

/** The original partitioner still owns dependency construction and ordering. Routing payloads
 * cannot add nodes, agents, write scope or instructions to this reviewed graph. */
export function partitionFor(event: DeepAgentEvent.Event, value: Effect.Success<ReturnType<typeof EventWorkController.prepare>>, agents: readonly AgentDescriptor[]): TaskPartitioner.Partition {
  const planned = TaskPartitioner.partition(event, { stableIDPrefix: event.id, rules: [{ match: event.type,
    steps: value.controller.plan.nodes.map((node) => ({ capability: agents.find((agent) => agent.name === node.agentID && (agent.capabilities?.length ?? 0) > 0)?.capabilities?.[0] ?? "event_work_unavailable",
      intent: node.instruction, dependsOnIdx: node.dependencies.map((id) => value.controller.plan.nodes.findIndex((other) => other.id === id)),
      requiredAutonomy: node.requiresWriteIsolation ? "level_2" : "level_1" })),
  }] })
  return { event, subtasks: planned.subtasks.map((subtask, index) => ({ ...subtask,
    id: value.controller.plan.nodes[index]!.id, dependsOn: value.controller.plan.nodes[index]!.dependencies,
    fileScope: value.controller.plan.nodes[index]!.requiresWriteIsolation ? value.rootBinding.toolPolicy.fileScope.write.map((rule) => rule.path) : [],
  })) }
}
