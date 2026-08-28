export * as SessionCompletedPublisher from "./session-completed-publisher"

import { Context, Effect, Layer, Stream, Cause, Option, Fiber, Duration, Scope, Clock } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionStatus } from "./status"
import { SessionID } from "./schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §L — the `session.completed` PRODUCER (the bridge that finally gives the §L EventDrivenArchiver a
// trigger). The archiver (wiki/event-driven-archiver.ts) subscribes to `session.completed` /
// `goal.completed` and archives the execution trajectory as a Wiki page — but until now NOTHING
// published `session.completed`, so the archiver was dead in prod. `goal.completed` already rides the
// bus (goal-manager.ts); this closes the symmetric gap for a plain session.
//
// WHY A STANDALONE BRIDGE (not a publish inside prompt.ts): archival must be DECOUPLED from the session
// loop (that is the whole point of §L moving the trigger to the bus). This service subscribes to the
// EXISTING end-of-turn signal — the `session.status` EventV2 the runner already emits when a session
// goes idle after a turn (run-state.ts onIdle → SessionStatus.set → publish Event.Status) — and
// republishes it as a V4 `session.completed` DeepAgentEvent. It invents NO new completion concept and
// touches no hot file; it is pure bus→bus glue merged alongside the other V4 daemons.
//
// GRANULARITY — two problems, two guards:
//
//  (1) ROOT sessions only: the idle signal fires for EVERY session, including subagent/child sessions
//      (task tool, panelists, goal steps). Archiving each child would spam the archiver with partial
//      traces. We gate to ROOT sessions (parentID == null): the archiver already reaches every
//      run-scoped graph the root spawned (session-archive.ts openWikiGraph walks the session's runs/).
//
//  (2) ONE-PER-EXECUTION, not per-turn (DEBOUNCE/COALESCE): an INTERACTIVE root session goes idle after
//      EVERY turn — a 20-turn conversation fires `session.idle` 20 times. Publishing `session.completed`
//      on each would re-project the whole execution trace 20 times. A per-idle idempotencyKey does NOT
//      fix this (each idle is a distinct completion instant → distinct key → 20 rows); it only dedupes
//      RE-DELIVERY of ONE idle. So instead we DEBOUNCE per session: each idle (re)arms a quiet-window
//      timer; only after the session stays idle for `debounceMs` (no new turn) does ONE
//      `session.completed` publish, carrying the session's LATEST state (resolved at fire time). A burst
//      of turns collapses to one archive; a genuinely separate later completion (after another quiet
//      window) re-archives the then-current final state — so the archiver reflects the FINAL trajectory,
//      not a frozen first-turn snapshot (which a pure per-session idempotencyKey would lock in). The
//      idempotencyKey carries the window's FIRE-TIME as its completionToken (computed once at fire and
//      passed into publishCompleted), so a window's own re-entrancy/retry reuses the same key and stays
//      idempotent, while distinct later completions fire at a later time → new token → their own archive.
//      (The per-session `epoch` is an internal map delete-guard identity only — NOT part of the key.)
//
// FLAG-GATED: v4EventDrivenArchive (default OFF). With it off the layer builds but starts NO
// subscription (inert) — byte-identical to pre-§L behavior. Independent of IM per the archiver's own
// header ("archival is a §L capability independent of IM").
//
// LAYERING: `deepagent-code`. Bridges the session-status EventV2 (deepagent-code) to the V4 bus (core).

const log = Log.create({ service: "session-completed-publisher" })

// The quiet window a root session must stay idle (no new turn) before its completion is archived. Long
// enough that a normal think-then-continue interactive cadence collapses to one archive, short enough
// that a genuinely finished session is archived promptly. Overridable per layer (tests use TestClock).
export const DEFAULT_DEBOUNCE_MS = 45_000

// The session facts the bridge needs to decide + shape the event. Kept as an injected PORT so the bridge
// is testable without the full session-creation stack (production wires it to Session.Service.get).
export interface SessionFacts {
  readonly parentID?: string
  readonly directory: string
  readonly workspaceID?: string
}

// Port: resolve a session's facts by id. Returns undefined when the session is gone (deleted between the
// idle signal and this lookup) — a terminal skip, not an error. Production = Session.Service.get.
export type SessionResolver = (sessionID: string) => Effect.Effect<SessionFacts | undefined>

export interface Interface {
  /**
   * React to ONE end-of-turn idle signal by (RE)ARMING the per-session debounce window. Does NOT publish
   * synchronously — an interactive root session idles after every turn, so publishing per idle would spam
   * the archiver. Instead each idle resets a quiet-window timer; only after the session stays idle for
   * `debounceMs` does exactly ONE `session.completed` publish (see `publishCompleted`), carrying the
   * session's latest state. Returns whether the window was armed (false = feature off). The background
   * subscription calls this per idle; exposed for deterministic testing.
   */
  readonly handleIdle: (input: { readonly sessionID: string }) => Effect.Effect<boolean>
  /**
   * Publish ONE `session.completed` for a session RIGHT NOW (the debounce window's fire action), applying
   * the root-only + has-directory gates and resolving the session's current state. `completionToken` makes
   * the idempotencyKey deterministic per completion: the daemon passes the window's FIRE TIME (monotonic
   * per settled completion), so a single window's retry/re-entrancy dedupes while a genuinely separate
   * later completion (a new window at a later instant) gets its own archive reflecting the FINAL state.
   * Returns whether an event was published. Exposed so a test can assert the publish shape / idempotency
   * without waiting on a timer.
   */
  readonly publishCompleted: (input: {
    readonly sessionID: string
    readonly completionToken: string | number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionCompletedPublisher") {}

export interface LayerOptions {
  // start the background EventV2 subscription as a scoped daemon. Default true; tests set false and call
  // handleIdle()/publishCompleted() directly for determinism.
  readonly runLoop?: boolean
  // override the session-facts resolver (tests inject a stub); defaults to Session.Service.get.
  readonly resolveSession?: SessionResolver
  // the debounce quiet-window (ms). Defaults to DEFAULT_DEBOUNCE_MS; tests shorten it + drive TestClock.
  readonly debounceMs?: number
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const flags = yield* RuntimeFlags.Service
      const runLoop = options?.runLoop ?? true
      const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS
      // The layer's own scope — debounce timer fibers are forked here so they outlive the single idle
      // signal that armed them (a signal handler's own scope closes when it returns) yet are still torn
      // down when the layer/daemon stops. Captured once at build time.
      const layerScope = yield* Scope.Scope
      // Per-session debounce state: the in-flight quiet-window timer fiber (interrupted + replaced on each
      // new idle) and a monotonic epoch (incremented once per FIRED window → a stable idempotencyKey per
      // completion). Keyed by sessionID; entries are pruned when a window fires.
      interface Pending {
        fiber: Fiber.Fiber<void>
        epoch: number
      }
      const pending = new Map<string, Pending>()
      // Session + the EventV2 bus are only needed for the PRODUCTION default (durable resolver + the idle
      // subscription). A test that injects its own resolver and sets runLoop:false doesn't need either,
      // so we take them OPTIONALLY — keeping the bridge unit-testable with just Bus + Flags. Production
      // always provides both (they are in the shared app graph), so the defaults are always available there.
      const sessions = yield* Effect.serviceOption(Session.Service)
      const events = yield* Effect.serviceOption(EventV2Bridge.Service)
      // default resolver: read the durable session row (Session.get uses only the db, so it works on a
      // background daemon fiber that carries no InstanceRef). A missing session → undefined (skip).
      const resolveSession: SessionResolver =
        options?.resolveSession ??
        ((sessionID) =>
          Option.isNone(sessions)
            ? Effect.succeed(undefined)
            : sessions.value.get(SessionID.make(sessionID)).pipe(
                Effect.map(
                  (info): SessionFacts => ({
                    ...(info.parentID != null ? { parentID: info.parentID } : {}),
                    directory: info.directory,
                    ...(info.workspaceID != null ? { workspaceID: info.workspaceID } : {}),
                  }),
                ),
                Effect.orElseSucceed(() => undefined),
              ))

      // The fire action of a debounce window: publish ONE session.completed for this session, applying the
      // root-only + has-directory gates against the session's CURRENT state (resolved here, at fire time,
      // so the archive reflects the latest trajectory — not a stale first-turn snapshot).
      const publishCompleted: Interface["publishCompleted"] = (input) =>
        Effect.gen(function* () {
          if (!flags.v4EventDrivenArchive) return false

          const facts = yield* resolveSession(input.sessionID)
          if (!facts) return false // session gone → nothing to archive.
          // ROOT sessions only — a child/subagent completion is a partial trace; its trajectory is folded
          // into the root's archive (openWikiGraph walks the root session's run graphs). Skip children.
          if (facts.parentID != null) return false
          // A session with no real working directory cannot be archived (archiveSessionOnCompletion needs
          // a workspacePath to open the graph union) — skip rather than publish an unarchivable trigger.
          if (!facts.directory) return false

          // workspaceID key mirrors goal-manager's emitGoalLifecycleEvent: prefer the genuine workspace
          // id, fall back to the filesystem directory, then the sessionID — so the event is scoped the
          // same way the rest of the V4 surface scopes a session.
          const workspaceID = facts.workspaceID ?? facts.directory ?? input.sessionID
          // Deterministic idempotencyKey = sessionID + completionToken (the window's FIRE TIME). One
          // settled debounce window = one token = one session.completed (§A3 幂等 dedupes a window's own
          // retry/re-entrancy), while a genuinely separate later completion fires at a LATER instant → a
          // distinct token → a fresh archive of the then-final state. This is the fix for per-turn spam:
          // N idles inside one quiet window collapse to one window → one token → one archive.
          const idempotencyKey = `session-completed:${input.sessionID}:${input.completionToken}`

          // Best-effort + NON-shedding: session.completed is a bounded first-party event (one per debounced
          // completion, not a user-driven flood), and it is an ARCHIVE TRIGGER — dropping it silently loses
          // an archive. So we use plain `publish` (bypasses the §E2 per-workspace rate gate that
          // `tryPublish` applies) rather than risk shedding the trigger. A bus EXCEPTION must never break
          // anything downstream (this runs on a detached daemon), so we catch the cause and log it.
          const outcome = yield* bus
            .publish({
              type: LMNEvents.SESSION_COMPLETED,
              // "system" — session completion is a first-party runtime event. It is in
              // DEFAULT_TRUSTED_SOURCES, so it passes the §E1 L1 trusted-source gate.
              source: "system",
              workspaceID,
              actorID: input.sessionID,
              correlationID: input.sessionID,
              idempotencyKey,
              priority: "normal",
              payload: { sessionID: input.sessionID, workspacePath: facts.directory },
            })
            .pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause })),
            )
          if (!outcome.ok) {
            yield* Effect.logError("session.completed publish failed").pipe(
              Effect.annotateLogs({
                reason: "publish_error",
                sessionID: input.sessionID,
                workspaceID,
                cause: Cause.pretty(outcome.cause),
              }),
            )
            return false
          }
          log.info("published session.completed", { sessionID: input.sessionID, workspaceID })
          return true
        })

      // (RE)ARM the per-session debounce window. Each idle interrupts the prior in-flight timer and forks a
      // fresh one into the LAYER scope (so it survives the arming signal's own scope). When the timer's
      // quiet window elapses without a newer idle superseding it, it fires publishCompleted with the epoch
      // captured at arm time, then removes its own entry. NOTE: we do NOT resolve session facts here — the
      // root/directory gate is applied at FIRE time so a child never even short-circuits an arm, and the
      // published state is the latest. This keeps arming O(1) and free of a DB read on every turn.
      const handleIdle: Interface["handleIdle"] = (input) =>
        Effect.gen(function* () {
          if (!flags.v4EventDrivenArchive) return false
          const prior = pending.get(input.sessionID)
          if (prior) yield* Fiber.interrupt(prior.fiber)
          // epoch is a per-arm IDENTITY (not the idempotency token): it lets the fire path verify the map
          // entry is still OURS before deleting it, so a re-arm that raced in doesn't get its entry wiped.
          const epoch = (prior?.epoch ?? 0) + 1
          const timer = Effect.sleep(Duration.millis(debounceMs)).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                // window survived the full quiet period → this is a SETTLED completion. Drop our entry
                // (only if it is still ours — guard on epoch so a racing re-arm's entry is preserved).
                const current = pending.get(input.sessionID)
                if (current && current.epoch === epoch) pending.delete(input.sessionID)
                // completionToken = the window's FIRE TIME (monotonic per settled completion). Distinct
                // completions fire at distinct instants → distinct idempotencyKeys → each archives the
                // then-final state; a burst inside one window is one fire → one token → one archive.
                const firedAt = yield* Clock.currentTimeMillis
                yield* publishCompleted({ sessionID: input.sessionID, completionToken: firedAt }).pipe(Effect.asVoid)
              }),
            ),
            // a fire-path failure must never kill the daemon; log + swallow.
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("debounced session.completed failed", { cause: Cause.pretty(cause) })),
            ),
          )
          const fiber = yield* timer.pipe(Effect.forkIn(layerScope))
          pending.set(input.sessionID, { fiber, epoch })
          return true
        })

      // Background daemon: subscribe to the session-status EventV2 stream, react only to idle transitions,
      // and (re)arm the debounce window. Started only when the flag is on (else the layer is inert). A
      // failure in one signal is logged + swallowed so the loop never dies on one bad item.
      if (runLoop && flags.v4EventDrivenArchive && Option.isSome(events)) {
        yield* events.value
          .subscribe(SessionStatus.Event.Status)
          .pipe(
            Stream.runForEach((payload) =>
              payload.data.status.type === "idle"
                ? handleIdle({ sessionID: payload.data.sessionID }).pipe(
                    Effect.asVoid,
                    Effect.catchCause((cause) =>
                      Effect.sync(() => log.error("session-completed handle failed", { cause: Cause.pretty(cause) })),
                    ),
                  )
                : Effect.void,
            ),
            Effect.forkScoped,
          )
      }

      return Service.of({ handleIdle, publishCompleted })
    }),
  )

export const layer = layerWith()
