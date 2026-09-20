export * as V2OutboxRuntime from "./v2-outbox-runtime"

import { GlobalBus } from "@/bus/global"
import { compatibilityEvent, EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@deepagent-code/core/database/database"
import { EventConsumer } from "@deepagent-code/core/deepagent/event-consumer"
import { EventOutbox } from "@deepagent-code/core/deepagent/event-outbox"
import { DeepAgentEventConsumerDeliveryTable, DeepAgentEventConsumerTable } from "@deepagent-code/core/deepagent/event-consumer-sql"
import { DeepAgentEventOutboxTable } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { isEventV2AdmissionEnabled } from "@deepagent-code/core/deepagent/event-admission"
import {
  RuntimeFeatures,
  type RuntimeFeatureRegistry,
} from "@deepagent-code/core/flag/runtime-features"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, FiberSet, Layer, Semaphore } from "effect"
import { randomUUID } from "node:crypto"

export interface Interface {
  readonly drain: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/EventOutboxRuntime") {}

const ConsumerKey = "runtime"
const ContractVersion = "event.v1"
const ClaimantID = `runtime:${process.pid}:${randomUUID()}`

export const layerWithRuntimeFeatures = (runtimeFeatures: RuntimeFeatureRegistry) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const semaphore = Semaphore.makeUnsafe(1)
    yield* EventConsumer.register(db, {
      consumerKey: ConsumerKey,
      deliveryContractVersion: ContractVersion,
      now: Date.now(),
    }).pipe(Effect.orDie)

    const drain = semaphore.withPermit(
      Effect.gen(function* () {
        const now = Date.now()
        yield* EventOutbox.publish(db, {
          // This process is the local durable broker: accepting the claimed row means making it
          // eligible for assignment below. Physical consumer effects remain separately fenced by
          // the delivery ledger, so a crash between these phases is repaired by the next scan.
          dispatch: () => Effect.void,
          claimantId: ClaimantID,
          now,
          leaseMs: 15_000,
          batchSize: 100,
          maxAttempts: 5,
        })

        const missingAssignments = yield* db
          .select({ outboxId: DeepAgentEventOutboxTable.outbox_id, consumerKey: DeepAgentEventConsumerTable.consumer_key })
          .from(DeepAgentEventOutboxTable)
          .innerJoin(DeepAgentEventConsumerTable, eq(DeepAgentEventOutboxTable.status, "published"))
          .leftJoin(
            DeepAgentEventConsumerDeliveryTable,
            and(
              eq(DeepAgentEventConsumerDeliveryTable.outbox_id, DeepAgentEventOutboxTable.outbox_id),
              eq(DeepAgentEventConsumerDeliveryTable.consumer_key, DeepAgentEventConsumerTable.consumer_key),
            ),
          )
          .where(
            and(
              eq(DeepAgentEventOutboxTable.status, "published"),
              isNull(DeepAgentEventConsumerDeliveryTable.outbox_id),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(
          missingAssignments,
          (assignment) =>
            EventConsumer.schedule(db, {
              outboxId: assignment.outboxId,
              consumerKey: assignment.consumerKey,
              now,
            }).pipe(Effect.orDie),
          { discard: true },
        )

        const claimed = yield* EventConsumer.claimDue(db, {
          consumerKey: ConsumerKey,
          contractVersion: ContractVersion,
          claimantId: ClaimantID,
          now,
          leaseMs: 15_000,
          limit: 100,
        }).pipe(Effect.orDie)
        yield* Effect.forEach(
          claimed.deliveries,
          (delivery) =>
            Effect.gen(function* () {
              const outbox = yield* EventOutbox.getByID(db, delivery.outboxId)
              if (!outbox) return yield* Effect.fail(new Error(`missing outbox ${delivery.outboxId}`))
              const row = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.id, EventV2.ID.make(outbox.eventId)))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* Effect.fail(new Error(`missing EventV2 row ${outbox.eventId}`))
              if (isEventV2AdmissionEnabled(runtimeFeatures)) {
                const session = yield* db
                  .select({
                    directory: SessionTable.directory,
                    project: SessionTable.project_id,
                    workspace: SessionTable.workspace_id,
                  })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, SessionSchema.ID.make(outbox.aggregateId)))
                  .get()
                  .pipe(Effect.orDie)
                const version = Number(row.type.slice(outbox.eventType.length + 1))
                // Rehydrated rows carry the wire form (epoch millis, not Date instances), while
                // compatibilityEvent's Schema.is guards validate decoded payloads. Feeding the
                // raw row silently no-ops the legacy egress rebuild and clients receive native
                // V2 shapes (e.g. session info without a top-level `directory`).
                const sync = EventV2.syncRegistry.get(EventV2.versionedType(outbox.eventType, version))
                const data = sync ? sync.decode(row.data) : row.data
                const event = compatibilityEvent({
                  id: EventV2.ID.make(outbox.eventId),
                  type: outbox.eventType,
                  version,
                  seq: row.seq,
                  data,
                })
                const info = row.data.info as
                  | { location?: { directory?: string; workspaceID?: string; project?: { id?: string } } }
                  | undefined
                GlobalBus.emit("event", {
                  directory: info?.location?.directory ?? session?.directory,
                  project: info?.location?.project?.id ?? session?.project,
                  workspace:
                    info?.location?.workspaceID ?? session?.workspace ?? (outbox.envelope.workspaceId || undefined),
                  payload: { id: event.id, type: event.type, properties: event.data },
                })
                GlobalBus.emit("event", {
                  directory: info?.location?.directory ?? session?.directory,
                  project: info?.location?.project?.id ?? session?.project,
                  workspace:
                    info?.location?.workspaceID ?? session?.workspace ?? (outbox.envelope.workspaceId || undefined),
                  payload: {
                    type: "sync",
                    syncEvent: {
                      id: event.id,
                      type: row.type,
                      seq: row.seq,
                      aggregateID: row.aggregate_id,
                      data: row.data,
                    },
                  },
                })
              }
            }).pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  EventConsumer.commitResult(db, {
                    outboxId: delivery.outboxId,
                    consumerKey: ConsumerKey,
                    claimToken: claimed.claimToken,
                    now: Date.now(),
                  }).pipe(Effect.asVoid),
                onFailure: (error) =>
                  EventConsumer.nack(db, {
                    outboxId: delivery.outboxId,
                    consumerKey: ConsumerKey,
                    claimToken: claimed.claimToken,
                    reason: String(error).slice(0, 500),
                    now: Date.now(),
                  }).pipe(Effect.orDie, Effect.asVoid),
              }),
            ),
          { discard: true },
        )
      }),
    )

    yield* drain
    // Per-EVENT drain fanout: every published event forked a full drain, and a single streaming
    // turn emits thousands of events — each drain re-scans the outbox and re-reads every delivery
    // (measured: 48k outbox selects / 27k transactions in one run). Drain is idempotent and only
    // needs to eventually observe pending work, so coalesce triggers with a short debounce: a burst
    // of events yields ONE drain shortly after it settles, and the 1s poll below stays the backstop.
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    let drainScheduled = false
    const unsubscribe = yield* events.listen(() =>
      Effect.sync(() => {
        if (drainScheduled) return
        drainScheduled = true
        fork(
          Effect.sleep("150 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                drainScheduled = false
              }),
            ),
            Effect.andThen(drain),
            Effect.catchCause((cause) => Effect.logError("V2 outbox drain failed", cause)),
          ),
        )
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* Effect.forkScoped(
      Effect.sleep("1 second").pipe(
        Effect.andThen(drain),
        Effect.catchCause((cause) => Effect.logError("V2 outbox drain failed", cause)),
        Effect.forever,
      ),
    )
    return Service.of({ drain })
    }),
  )

export const layer = layerWithRuntimeFeatures(RuntimeFeatures)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
