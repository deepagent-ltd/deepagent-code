export * as AgentHandoffConsumer from "./agent-handoff-consumer"

import { Cause, Context, Deferred, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { HandoffAdmission } from "@deepagent-code/core/deepagent/handoff-admission"
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
// FEAT-008: when the retry pump drives a redelivery it carries its claim identity — the claimant id
// is stamped on the admission receipt, and the delivery is settled via the TOKEN-conditioned
// ackClaim/nackClaim so a stale pump (lease lapsed, row re-claimed) can no longer settle a delivery
// its successor already owns. The live-subscription path has no claim and keeps plain ack/nack.
type Claim = { readonly claimantId: string; readonly claimToken: string }

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
      const admission = yield* HandoffAdmission.Service
      const agents = yield* AgentListProviderService
      const security = yield* SecurityResolvers.Service
      const flags = yield* RuntimeFlags.Service
      const runLoop = options?.runLoop ?? true
      const retryPumpIntervalMs = options?.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS

      // Settle the (event, group) delivery. Under a claim the settle is TOKEN-conditioned: a false
      // ackClaim means the lease lapsed and a successor claimant now owns the row — log and move on;
      // the business side effects (accept/reject + receipt) are idempotent by construction.
      const settleDelivery = (event: DeepAgentEvent.Event, claim?: Claim) =>
        claim
          ? bus
              .ackClaim({ subscriptionGroup: HANDOFF_GROUP, eventID: event.id, claimToken: claim.claimToken })
              .pipe(
                Effect.tap((applied) =>
                  applied
                    ? Effect.void
                    : Effect.sync(() =>
                        log.warn("handoff delivery claim stale at ack; successor owns the row", {
                          eventID: event.id,
                        }),
                      ),
                ),
                Effect.asVoid,
              )
          : bus.ack(HANDOFF_GROUP, event.id)

      const reject = (event: DeepAgentEvent.Event, handoff: Handoff, reason: string, claim?: Claim) =>
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
          .pipe(
            // FEAT-008: terminal receipt — conditioned on state='processing', so a stale claimant can
            // never flip a receipt its successor already settled.
            Effect.andThen(admission.settle({ handoffID: handoff.handoffID, state: "rejected", reason })),
            Effect.andThen(settleDelivery(event, claim)),
            Effect.as("rejected" as const),
          )

      const process = (event: DeepAgentEvent.Event, claim?: Claim) =>
        Effect.gen(function* () {
          const handoff = decodeHandoff(event)
          if (!handoff || event.source !== "system") {
            yield* settleDelivery(event, claim)
            return "ignored" as const
          }
          // FEAT-008 durable admission receipt: stamped `processing` BEFORE any side-effecting
          // decision, so a crash mid-handling leaves a durable "not finished" marker instead of
          // "事件即状态". A terminal receipt returned here means this handoff already settled —
          // short-circuit (ack only, never re-run accept/reject).
          const receipt = yield* admission.begin({
            handoffID: handoff.handoffID,
            eventID: event.id,
            workspaceID: event.workspaceID,
            claimantID: claim?.claimantId ?? "agent-handoff-consumer:live",
          })
          if (receipt.state === "accepted") {
            yield* settleDelivery(event, claim)
            return "accepted" as const
          }
          if (receipt.state === "rejected") {
            yield* settleDelivery(event, claim)
            return "rejected" as const
          }
          if (!flags.v4MultiAgentRuntime) {
            return yield* reject(event, handoff, "handoff_flag_disabled", claim)
          }

          const original = yield* bus.getByID(handoff.eventID)
          if (!original || original.workspaceID !== event.workspaceID) {
            return yield* reject(event, handoff, "handoff_original_event_missing", claim)
          }
          const subtask = TaskPartitioner.partition(original, { stableIDPrefix: original.id }).subtasks.find(
            (candidate) => candidate.id === handoff.taskID,
          )
          if (!subtask) return yield* reject(event, handoff, "handoff_task_missing", claim)

          const registry = yield* agents.listAgents({
            workspaceID: original.workspaceID,
            userID: original.actorID ?? "system",
          })
          const target = TaskPartitioner.capableAgents(subtask, registry).find(
            (candidate) => candidate.id === handoff.toAgentID,
          )
          if (!target) return yield* reject(event, handoff, "handoff_target_not_capable", claim)

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
          if (!gate.allowed) return yield* reject(event, handoff, `handoff_security_${gate.failedLayer}`, claim)

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
            if (!alreadyAccepted) return yield* reject(event, handoff, "handoff_state_mismatch", claim)
          }
          yield* admission.settle({ handoffID: handoff.handoffID, state: "accepted" })
          yield* settleDelivery(event, claim)
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
          // RISK-001 / FEAT-008: claim due rows before executing so two processes (Desktop + CLI
          // daemon, or an upgrade overlap) can never re-drive the same handoff retry concurrently.
          // Success settles via the token-conditioned ackClaim (inside process); failure settles via
          // the token-conditioned nackClaim below — a stale token is a no-op, so a claimant whose
          // lease lapsed can never settle a delivery its successor already owns.
          // `process` is shadowed by the local handler in this module — mint a unique claimant id.
          const claimantId = `agent-handoff-consumer:${crypto.randomUUID()}`
          const claim = yield* bus.claimDue({
            subscriptionGroup: HANDOFF_GROUP,
            claimantId,
            now,
          })
          yield* Effect.forEach(
            claim.deliveries,
            (delivery) =>
              bus.getByID(delivery.eventID).pipe(
                Effect.flatMap((event) =>
                  event
                    ? process(event, { claimantId, claimToken: claim.claimToken }).pipe(
                        Effect.catchCause((cause) =>
                          bus
                            .nackClaim({
                              subscriptionGroup: HANDOFF_GROUP,
                              eventID: event.id,
                              claimToken: claim.claimToken,
                              reason: `handoff consumer failure: ${Cause.pretty(cause)}`,
                            })
                            .pipe(Effect.as("retrying" as const)),
                        ),
                      )
                    : Effect.void,
                ),
              ),
            { discard: true },
          )
          return claim.deliveries.length
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
