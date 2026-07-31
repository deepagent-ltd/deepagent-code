export * as AgentHandoffConsumer from "./agent-handoff-consumer"

import { Cause, Context, Deferred, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { SecurityGate } from "@deepagent-code/core/deepagent/security-gate"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"

const log = Log.create({ service: "agent-handoff-consumer" })

export const HANDOFF_GROUP = "agent-handoff"
export const DEFAULT_RETRY_PUMP_INTERVAL_MS = 30_000

type Outcome = "accepted" | "rejected" | "ignored" | "retrying"
type Handoff = Extract<DeepAgentEvent.AgentCoordinationEvent, { readonly type: "agent.handoff.requested" }>

export interface Interface {
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<Outcome>
  readonly pumpRetries: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/AgentHandoffConsumer") {}

export interface LayerOptions {
  readonly runLoop?: boolean
  readonly retryPumpIntervalMs?: number
}

const decodeHandoff = (event: DeepAgentEvent.Event): Handoff | undefined => {
  if (event.type !== LMNEvents.AGENT_HANDOFF_REQUESTED) return undefined
  const decoded = Schema.decodeUnknownOption(DeepAgentEvent.AgentCoordinationEvent)(event.payload)
  if (Option.isNone(decoded) || decoded.value.type !== LMNEvents.AGENT_HANDOFF_REQUESTED) return undefined
  return decoded.value
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const execution = yield* AgentExecution.Service
      const agents = yield* AgentListProviderService
      const security = yield* SecurityResolvers.Service
      const flags = yield* RuntimeFlags.Service
      const runLoop = options?.runLoop ?? true
      const retryPumpIntervalMs = options?.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS

      const ack = (event: DeepAgentEvent.Event) => bus.ack(HANDOFF_GROUP, event.id)

      const reject = (event: DeepAgentEvent.Event, handoff: Handoff, reason: string) =>
        execution
          .rejectHandoff({
            workspaceID: event.workspaceID,
            eventID: handoff.eventID,
            taskID: handoff.taskID,
            handoffID: handoff.handoffID,
            generation: handoff.generation,
            fromAgentID: handoff.fromAgentID,
            toAgentID: handoff.toAgentID,
            reason,
          })
          .pipe(Effect.andThen(ack(event)), Effect.as("rejected" as const))

      const process = (event: DeepAgentEvent.Event) =>
        Effect.gen(function* () {
          const handoff = decodeHandoff(event)
          if (!handoff || event.source !== "system") {
            yield* ack(event)
            return "ignored" as const
          }
          if (!flags.v4MultiAgentRuntime) {
            return yield* reject(event, handoff, "handoff_flag_disabled")
          }

          const original = yield* bus.getByID(handoff.eventID)
          if (!original || original.workspaceID !== event.workspaceID) {
            return yield* reject(event, handoff, "handoff_original_event_missing")
          }
          const subtask = TaskPartitioner.partition(original, { stableIDPrefix: original.id }).subtasks.find(
            (candidate) => candidate.id === handoff.taskID,
          )
          if (!subtask) return yield* reject(event, handoff, "handoff_task_missing")

          const registry = yield* agents.listAgents({
            workspaceID: original.workspaceID,
            userID: original.actorID ?? "system",
          })
          const target = TaskPartitioner.capableAgents(subtask, registry).find(
            (candidate) => candidate.id === handoff.toAgentID,
          )
          if (!target) return yield* reject(event, handoff, "handoff_target_not_capable")

          const trusted = yield* security.resolveTrustedSources(original.workspaceID)
          const actorAllowed = yield* security.actorHasWorkspacePermission({
            workspaceID: original.workspaceID,
            ...(original.actorID ? { actorID: original.actorID } : {}),
            agentID: target.id,
          })
          const runtimeAllowed = yield* security.runtimeAllowsOperation({
            workspaceID: original.workspaceID,
            agent: target,
            capability: subtask.capability,
          })
          const gate = SecurityGate.check({
            eventSourceTrusted: SecurityGate.isTrustedSource(original.source, trusted),
            actorHasPermission: actorAllowed,
            agentCapabilities: target.capabilities ?? [],
            requiredCapability: subtask.capability,
            runtimeAllowed,
          })
          if (!gate.allowed) return yield* reject(event, handoff, `handoff_security_${gate.failedLayer}`)

          const accepted = yield* execution.acceptHandoff({
            workspaceID: event.workspaceID,
            eventID: handoff.eventID,
            taskID: handoff.taskID,
            handoffID: handoff.handoffID,
            generation: handoff.generation,
            fromAgentID: handoff.fromAgentID,
            toAgentID: handoff.toAgentID,
          })
          if (!accepted) {
            const current = yield* execution.get({
              workspaceID: event.workspaceID,
              eventID: handoff.eventID,
              taskID: handoff.taskID,
            })
            const alreadyAccepted =
              current?.handoffID === handoff.handoffID &&
              (current.status === "available" || current.status === "running" || current.status === "completed") &&
              (current.assignedAgentID === handoff.toAgentID || current.agentID === handoff.toAgentID)
            if (!alreadyAccepted) return yield* reject(event, handoff, "handoff_state_mismatch")
          }
          yield* ack(event)
          return "accepted" as const
        })

      const handle: Interface["handle"] = (event) =>
        process(event).pipe(
          Effect.catchCause((cause) =>
            bus
              .nack({
                subscriptionGroup: HANDOFF_GROUP,
                eventID: event.id,
                reason: `handoff consumer failure: ${Cause.pretty(cause)}`,
              })
              .pipe(Effect.as("retrying" as const)),
          ),
        )

      const pumpRetries: Interface["pumpRetries"] = (now) =>
        Effect.gen(function* () {
          const due = yield* bus.dueRetries(now)
          const owned = due.filter((delivery) => delivery.subscriptionGroup === HANDOFF_GROUP)
          yield* Effect.forEach(
            owned,
            (delivery) =>
              bus.getByID(delivery.eventID).pipe(Effect.flatMap((event) => (event ? handle(event) : Effect.void))),
            { discard: true },
          )
          return owned.length
        })

      if (runLoop) {
        yield* bus.registerConsumerGroup(HANDOFF_GROUP, LMNEvents.AGENT_HANDOFF_REQUESTED)
        const ready = yield* Deferred.make<void>()
        yield* bus.subscribe({ group: HANDOFF_GROUP, type: LMNEvents.AGENT_HANDOFF_REQUESTED }).pipe(
          Stream.onStart(Deferred.succeed(ready, undefined)),
          Stream.runForEach((event) => handle(event).pipe(Effect.asVoid)),
          Effect.forkScoped,
        )
        yield* Deferred.await(ready)
        yield* pumpRetries().pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("handoff retry pump failed", { cause: Cause.pretty(cause) })).pipe(
              Effect.as(0),
            ),
          ),
          Effect.repeat(Schedule.spaced(Duration.millis(retryPumpIntervalMs))),
          Effect.forkScoped,
        )
      }

      return Service.of({ handle, pumpRetries })
    }),
  )
