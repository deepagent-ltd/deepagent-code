// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { EventRouteRef, InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { isEventV2AdmissionEnabled } from "@deepagent-code/core/deepagent/event-admission"
import {
  RuntimeFeatures,
  type RuntimeFeatureRegistry,
} from "@deepagent-code/core/flag/runtime-features"
import { Database } from "@deepagent-code/core/database/database"
import { V2OutboxWriter } from "@/event/v2-outbox-writer"
import "@deepagent-code/core/account"
import "@deepagent-code/core/catalog"
import "@deepagent-code/core/session/event"
import "@deepagent-code/core/proxy/event"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Context, DateTime, Effect, Layer, Schema } from "effect"

// W5 ① — the EventV2 publish surface mirrors C5-registered publishes into `deepagent_event_outbox`
// (V2OutboxWriter) IN THE SAME TRANSACTION as the EventV2 event row (design §8.3). See
// v2-outbox-writer.ts for the idempotency / same-transaction contract.

export class Service extends Context.Service<Service, EventV2.Interface>()("@deepagent-code/EventV2Bridge") {}

// Static declaration table (`as const`, never mutated — mirrors the ownerServices pattern the
// runtime-state scanner classifies as safe_static).
const compatibilityEgressPairs = [
  [SessionEvent.Created, SessionV1.Event.Created],
  [SessionEvent.Updated, SessionV1.Event.Updated],
  [SessionEvent.DiffUpdated, SessionV1.Event.Diff],
  [SessionEvent.RevertChanged, SessionV1.Event.Updated],
  [SessionEvent.Deleted, SessionV1.Event.Deleted],
] as const

/**
 * Client-facing event streams (the SSE `/event` stream and the GlobalBus mirror) deliver these
 * types in the V1 compatibility shape: `compatibilityEvent` rewrites their native V2 facts
 * before client delivery. OpenAPI unions describing those streams must declare the V1
 * definition for exactly these types — every other type (including multi-version types without
 * an egress adapter, e.g. `session.next.compaction.ended`) is delivered raw at its published
 * version and must stay declared at the registry's latest version.
 */
export function compatibilityEgressDefinition(type: string): EventV2.Definition | undefined {
  return compatibilityEgressPairs.find(([native]) => native.type === type)?.[1]
}

/** V1 is an egress shape only: the durable event and projection remain native V2. */
export function compatibilityEvent(event: EventV2.Payload): EventV2.Payload {
  if (Schema.is(SessionEvent.DiffUpdated)(event))
    return {
      ...event,
      data: {
        sessionID: event.data.sessionID,
        diff: event.data.diff,
        manifest: event.data.summary.diffManifest,
      },
    }
  if (Schema.is(SessionEvent.RevertChanged)(event))
    return {
      ...event,
      type: SessionV1.Event.Updated.type,
      version: SessionV1.Event.Updated.sync?.version,
      data: {
        sessionID: event.data.sessionID,
        info: {
          ...legacySessionInfo(event.data, null),
          summary: event.data.summary
            ? {
                additions: event.data.summary.additions,
                deletions: event.data.summary.deletions,
                files: event.data.summary.files,
                diffManifest: event.data.summary.diffManifest,
              }
            : undefined,
          revert: event.data.revert ?? undefined,
        },
      },
    }
  if (event.version !== 2) return event
  if (Schema.is(SessionEvent.Created)(event))
    return { ...event, data: { sessionID: event.data.sessionID, info: legacySessionInfo(event.data, undefined) } }
  if (Schema.is(SessionEvent.Updated)(event))
    // `null` (not a dropped key) clears the archived flag for V1 clients on unarchive — the V2 info
    // schema cannot express the explicit clear, so the egress adapter restores it.
    return { ...event, data: { sessionID: event.data.sessionID, info: legacySessionInfo(event.data, null) } }
  if (Schema.is(SessionEvent.Deleted)(event))
    return { ...event, data: { sessionID: event.data.sessionID, info: legacySessionInfo(event.data, undefined) } }
  return event
}

// The native created/updated payloads share the same { sessionID, info, slug, version } mirror, so
// one mapping rebuilds the legacy client shape for both. `unarchived` selects the absent-vs-null
// encoding of a cleared archived flag (created omits; updated clears explicitly).
function legacySessionInfo(
  data: Pick<typeof SessionEvent.Created.Type.data, "info" | "slug" | "version">,
  unarchived: null | undefined,
) {
  return SessionV1.SessionInfo.make({
    id: data.info.id,
    parentID: data.info.parentID,
    slug: data.slug,
    projectID: data.info.projectID,
    workspaceID: data.info.location.workspaceID,
    directory: data.info.location.directory,
    path: data.info.subpath,
    title: data.info.title,
    agent: data.info.agent,
    model: data.info.model,
    version: data.version,
    cost: data.info.cost,
    tokens: data.info.tokens,
    metadata: data.info.metadata,
    share: data.info.share,
    summary: data.info.summary,
    time: {
      created: DateTime.toEpochMillis(data.info.time.created),
      updated: DateTime.toEpochMillis(data.info.time.updated),
      archived: data.info.time.archived ? DateTime.toEpochMillis(data.info.time.archived) : unarchived,
    },
    permission: data.info.permissions.map((rule) => ({
      permission: rule.action,
      pattern: rule.resource,
      action: rule.effect,
    })),
    preview: data.info.preview,
  })
}

export const assertSynchronizedOutboxRegistry = (
  registry: Parameters<typeof V2OutboxWriter.registrationForEventType>[1],
) => {
  const invalid = registry.eventTypes().filter((type) => EventV2.registry.get(type)?.sync === undefined)
  if (invalid.length > 0)
    throw new Error(`C5 outbox registrations require synchronized EventV2 definitions: ${invalid.join(", ")}`)
}

export const layerWithRegistry = (
  registry: Parameters<typeof V2OutboxWriter.registrationForEventType>[1],
  runtimeFeatures: RuntimeFeatureRegistry = RuntimeFeatures,
) => {
  // Every registered type must have a durable EventV2 row. Validate at graph construction so a
  // non-sync registration cannot silently turn an authorized C5 fact into a best-effort event.
  assertSynchronizedOutboxRegistry(registry)
  return Layer.effect(
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
        const registration = V2OutboxWriter.registrationForEventType(event.type, registry)
        if (!registration) return Effect.void
        if (event.version === undefined || EventV2.registry.get(event.type)?.sync === undefined)
          return Effect.die(new Error(`registered C5 event is not synchronized: ${event.type}`))
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
          // outbox refuses arbitrary types, design §8.8). Registry validation above rejects
          // registered non-sync types before this graph starts.
          const commit =
            definition.sync !== undefined
              ? (seq: number, event: EventV2.Payload) =>
                  Effect.gen(function* () {
                    if (options?.commit) yield* options.commit(seq, event)
                    return yield* landIfRegistered(event)
                  })
              : options?.commit
          const event = yield* options?.location
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
              })
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
          if (isEventV2AdmissionEnabled(runtimeFeatures)) return
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
}

export const layerWithRuntimeFeatures = (runtimeFeatures: RuntimeFeatureRegistry) =>
  layerWithRegistry(V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY, runtimeFeatures)

export const layer = layerWithRuntimeFeatures(RuntimeFeatures)

export const defaultLayerWithRuntimeFeatures = (runtimeFeatures: RuntimeFeatureRegistry) =>
  layerWithRuntimeFeatures(runtimeFeatures).pipe(
    Layer.provide(EventV2.defaultLayer),
    // W5 ① — the outbox landing needs the shared Database (EventV2.defaultLayer owns its own internal
    // one; the bridge uses the graph's Database so the landing ledger is the runtime's DB).
    Layer.provide(Database.defaultLayer),
  )

export const defaultLayer = defaultLayerWithRuntimeFeatures(RuntimeFeatures)

export * as EventV2Bridge from "./event-v2-bridge"
