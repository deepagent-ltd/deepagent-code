// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { EventRouteRef, InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { isEventV2AdmissionEnabled } from "@deepagent-code/core/deepagent/event-admission"
import { Database } from "@deepagent-code/core/database/database"
import * as Log from "@deepagent-code/core/util/log"
import { V2OutboxWriter } from "@/event/v2-outbox-writer"
import "@deepagent-code/core/account"
import "@deepagent-code/core/catalog"
import "@deepagent-code/core/session/event"
import { Context, Effect, Layer } from "effect"

// W5 ① — the EventV2 publish surface mirrors C5-registered publishes into `deepagent_event_outbox`
// (V2OutboxWriter). See v2-outbox-writer.ts for the idempotency / crash-window replay contract.
const log = Log.create({ service: "event-v2-bridge" })

export class Service extends Context.Service<Service, EventV2.Interface>()("@deepagent-code/EventV2Bridge") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        const event = yield* (options?.location
          ? events.publish(definition, data, options)
          : Effect.gen(function* () {
              const route = yield* EventRouteRef
              const ctx = route ?? (yield* InstanceRef)
              if (!ctx) return yield* events.publish(definition, data, options)
              const workspaceID = route?.workspaceID ?? (yield* WorkspaceRef)
              return yield* events.publish(definition, data, {
                ...options,
                location: new Location.Info({
                  directory: AbsolutePath.make(ctx.directory),
                  ...(workspaceID ? { workspaceID } : {}),
                  project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
                }),
              })
            }))

        // W5 ① — 旁路 outbox landing, AFTER the EventV2 durable commit. Only C5-registered types land
        // (the outbox refuses arbitrary self-authorizing types, design §8.8); everything else is left to
        // the hot path untouched. Landing is BYPASS: a landing failure never fails the publish (the
        // EventV2 commit is the authority) — it is logged so the gap stays visible.
        const registration = V2OutboxWriter.registrationForEventType(event.type)
        if (registration) {
          yield* V2OutboxWriter.land(db, { event, registration, now: Date.now() }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.warn("eventv2 outbox landing failed", { eventID: event.id, eventType: event.type, cause })),
            ),
          )
        }
        return event
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        // C5-12 — the V2 admission path is the SINGLE writer when enabled. The GlobalBus mirror + sync
        // emission are a legacy DOUBLE-WRITE of the same EventV2 authority onto the frontend/UI plane; when
        // `isEventV2AdmissionEnabled()` is ON the durable V2 consumer is the authority, so the mirror is
        // skipped entirely (the UI is fed the durable path, never a second copy). When OFF the current
        // runtime stays authoritative and the mirror is unchanged.
        if (isEventV2AdmissionEnabled()) return
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        const sync = EventV2.registry.get(event.type)?.sync
        if (sync === undefined || event.seq === undefined || event.version === undefined) return
        const aggregateID = (event.data as Record<string, unknown>)[sync.aggregate]
        if (typeof aggregateID !== "string") return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.version),
              seq: event.seq,
              aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  // W5 ① — the outbox landing needs the shared Database (EventV2.defaultLayer owns its own internal
  // one; the bridge uses the graph's Database so the landing ledger is the runtime's DB).
  Layer.provide(Database.defaultLayer),
)

export * as EventV2Bridge from "./event-v2-bridge"
