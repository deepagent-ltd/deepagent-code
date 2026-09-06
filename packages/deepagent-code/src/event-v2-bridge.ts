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
import { V2OutboxWriter } from "@/event/v2-outbox-writer"
import "@deepagent-code/core/account"
import "@deepagent-code/core/catalog"
import "@deepagent-code/core/session/event"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Context, DateTime, Effect, Layer, Schema } from "effect"

// W5 ① — the EventV2 publish surface mirrors C5-registered publishes into `deepagent_event_outbox`
// (V2OutboxWriter) IN THE SAME TRANSACTION as the EventV2 event row (design §8.3). See
// v2-outbox-writer.ts for the idempotency / same-transaction contract.

export class Service extends Context.Service<Service, EventV2.Interface>()("@deepagent-code/EventV2Bridge") {}

/** V1 is an egress shape only: the durable event and projection remain native V2. */
export function compatibilityEvent(event: EventV2.Payload): EventV2.Payload {
  if (event.version !== 2 || !Schema.is(SessionEvent.Created)(event)) return event
  return {
    ...event,
    data: {
      sessionID: event.data.sessionID,
      info: SessionV1.SessionInfo.make({
        id: event.data.info.id,
        parentID: event.data.info.parentID,
        slug: event.data.slug,
        projectID: event.data.info.projectID,
        workspaceID: event.data.info.location.workspaceID,
        directory: event.data.info.location.directory,
        path: event.data.info.subpath,
        title: event.data.info.title,
        agent: event.data.info.agent,
        model: event.data.info.model,
        version: event.data.version,
        cost: event.data.info.cost,
        tokens: event.data.info.tokens,
        time: {
          created: DateTime.toEpochMillis(event.data.info.time.created),
          updated: DateTime.toEpochMillis(event.data.info.time.updated),
          archived: event.data.info.time.archived
            ? DateTime.toEpochMillis(event.data.info.time.archived)
            : undefined,
        },
        permission: event.data.info.permissions.map((rule) => ({
          permission: rule.action,
          pattern: rule.resource,
          action: rule.effect,
        })),
      }),
    },
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    // W5 ① — the in-transaction outbox landing (design §8.3: 跨 aggregate publish 必须先写 durable
    // outbox, and 禁止状态提交后 best-effort publish). This is called as the `commit` hook of
    // `EventV2.publish` / `EventV2.replay`, i.e. INSIDE the event's transaction:
    //   - the outbox row commits with the event row or not at all (no missing-row window);
    //   - a landing failure FAILS the transaction (fail-closed — never a durable event its C5 consumers
    //     cannot see), unlike the removed post-commit best-effort + warn-only bypass;
    //   - an exact retry re-runs the hook; `land` is idempotent on `eventv2:<eventId>` (already_landed).
    const landIfRegistered = (event: EventV2.Payload): Effect.Effect<void, unknown> => {
      const registration = V2OutboxWriter.registrationForEventType(event.type)
      if (!registration) return Effect.void
      return V2OutboxWriter.land(db, { event, registration, now: Date.now() }).pipe(Effect.asVoid)
    }

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        // The in-transaction landing hook. Only attached for synchronized (durable) events: EventV2
        // dies on a commit hook for a non-sync event (there is no event transaction to share) — for a
        // non-sync definition the caller's own hook (if any) is passed through untouched. The hook
        // COMPOSES with the caller's hook rather than replacing it: a caller may already commit its own
        // local projection in the same transaction (e.g. the fork-delivery cursor), so the outbox
        // landing runs after it, never instead of it. The hook itself checks the C5 registration (the
        // outbox refuses arbitrary types, design §8.8) — a registered NON-sync type is therefore not
        // landed (documented: C5-registered facts are sync).
        const commit =
          definition.sync !== undefined
            ? (seq: number, event: EventV2.Payload) =>
                Effect.gen(function* () {
                  if (options?.commit) yield* options.commit(seq, event)
                  return yield* landIfRegistered(event)
                })
            : options?.commit
        const event = yield* (options?.location
          ? events.publish(definition, data, { ...options, commit })
          : Effect.gen(function* () {
              const route = yield* EventRouteRef
              const ctx = route ?? (yield* InstanceRef)
              if (!ctx) return yield* events.publish(definition, data, { ...options, commit })
              const workspaceID = route?.workspaceID ?? (yield* WorkspaceRef)
              return yield* events.publish(definition, data, {
                ...options,
                commit,
                location: new Location.Info({
                  directory: AbsolutePath.make(ctx.directory),
                  ...(workspaceID ? { workspaceID } : {}),
                  project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
                }),
              })
            }))
        return event
      })

    // W5 ① replay driver — the EventV2 replay surface (sync / import / control-plane re-commit of the
    // serialized event log) lands C5-registered event ids in-transaction too. Replayed commits carry the
    // SAME `eventv2:<eventId>` idempotency key, so a re-replay fenced on the same key. The hook COMPOSES
    // with a caller-supplied in-transaction hook (never replaces it).
    const replay: EventV2.Interface["replay"] = (serialized, options) =>
      events.replay(serialized, {
        ...options,
        onCommit: (seq, event) =>
          Effect.gen(function* () {
            if (options?.onCommit) yield* options.onCommit(seq, event)
            return yield* landIfRegistered(event)
          }),
      })

    const replayAll: EventV2.Interface["replayAll"] = (serialized, options) =>
      events.replayAll(serialized, {
        ...options,
        onCommit: (seq, event) =>
          Effect.gen(function* () {
            if (options?.onCommit) yield* options.onCommit(seq, event)
            return yield* landIfRegistered(event)
          }),
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
        const compatible = compatibilityEvent(event)
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: compatible.id, type: compatible.type, properties: compatible.data },
        })
        if (event.seq === undefined || event.version === undefined) return
        const sync = EventV2.syncRegistry.get(EventV2.versionedType(event.type, event.version))?.sync
        if (sync === undefined) return
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

    return Service.of({
      ...events,
      publish,
      replay,
      replayAll,
      listen: (listener) => events.listen((event) => listener(compatibilityEvent(event))),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  // W5 ① — the outbox landing needs the shared Database (EventV2.defaultLayer owns its own internal
  // one; the bridge uses the graph's Database so the landing ledger is the runtime's DB).
  Layer.provide(Database.defaultLayer),
)

export * as EventV2Bridge from "./event-v2-bridge"
