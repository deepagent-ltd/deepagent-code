import { Effect, Option } from "effect"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import type { DocType } from "@deepagent-code/core/deepagent/document-store"
import * as Log from "@deepagent-code/core/util/log"

/**
 * FEAT-006 — wiki/knowledge change eventing (LMNEvents.WIKI_PAGE_CHANGED).
 *
 * The wiki domain was a pure event CONSUMER (the §L event-driven archiver) that never emitted
 * anything; this module adds the producer side: a MINIMAL bus port + the best-effort publisher for
 * `wiki.page.changed`, shared by both producers — WikiService.editKnowledge (governed human edit)
 * and archiveSessionOnCompletion (execution-archive page persist).
 *
 * BUS PORT: `WikiEventPublisher` is the structural subset of the core bus the wiki needs (just
 * `publish`) so the pure WikiService class never depends on the full bus service — tests wire an
 * in-memory bus through the same port. `DeepAgentEventBus.Interface` satisfies it structurally.
 *
 * BENEFIT BOUNDARY (see the LMNEvents.WIKI_PAGE_CHANGED contract): federation knowledge graphs only
 * ever consume released snapshots — this event is audit / UI notification / future cache
 * invalidation only; no federation-side reaction is expected.
 *
 * LAYERING: `deepagent-code` (bridges the core bus vocabulary to the wiki producers).
 */

const log = Log.create({ service: "wiki-events" })

// The minimal bus port the wiki producers need. Structurally satisfied by DeepAgentEventBus.Interface
// (same port shape tests use with the in-memory bus layer).
export type WikiEventPublisher = {
  readonly publish: (input: DeepAgentEvent.PublishInput) => Effect.Effect<DeepAgentEvent.Event>
}

// One committed wiki page mutation. `archive` is present ONLY for execution-archive persists (the §L
// archiver path) — it folds an archive marker into the idempotency key and labels the payload.
export type WikiPageChange = {
  readonly workspacePath?: string
  readonly docId: string
  readonly type: DocType
  readonly version: number
  readonly editor: string
  readonly archive?: { readonly sessionID: string }
}

// FEAT-003 idempotency pattern: the idempotency key IS the write's natural dedup identity —
// docId+version — so a redelivered write never double-publishes (the bus dedupes on the key).
// Archive persists prefix `archive:` so an archive page can never collide with a human edit of the
// same doc, and callers can tell the origin from the key alone. (Takes only the key-relevant slice
// of WikiPageChange so tests/callers can derive a key without materializing the full payload.)
export const wikiPageChangedIdempotencyKey = (change: {
  readonly docId: string
  readonly version: number
  readonly archive?: { readonly sessionID: string }
}): string =>
  `wiki.page.changed:${change.archive ? "archive:" : ""}${change.docId}:${change.version}`

// Publish wiki.page.changed for a COMMITTED page write. BEST-EFFORT by contract (mirrors FEAT-003's
// publishPackChanged): the DocumentStore write already succeeded and stays authoritative — a bus
// failure logs and is swallowed, never fails the edit/archive. `priority: "normal"` — a sheddable
// observation, never a driver.
export const publishWikiPageChanged = (bus: WikiEventPublisher, change: WikiPageChange): Effect.Effect<void> =>
  bus
    .publish({
      type: LMNEvents.WIKI_PAGE_CHANGED,
      source: "system",
      workspaceID: change.workspacePath ?? "unknown",
      actorID: change.editor,
      idempotencyKey: wikiPageChangedIdempotencyKey(change),
      priority: "normal",
      payload: {
        workspacePath: change.workspacePath,
        docId: change.docId,
        type: change.type,
        version: change.version,
        editor: change.editor,
        ...(change.archive ? { archive: true, sessionID: change.archive.sessionID } : {}),
      },
    })
    .pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          log.error("wiki.page.changed publish failed (page write already committed)", {
            cause: String(cause),
            docId: change.docId,
            version: change.version,
          }),
        ),
      ),
    )

// Resolve the bus port: an EXPLICITLY injected publisher wins (constructor/test wiring); otherwise
// fall back to the DeepAgentEventBus.Service from the Effect environment when the surrounding
// runtime provides it (the HTTP route runtime provides DeepAgentEventBus.defaultLayer — the same
// seam the packs handlers use — so the unmodified wikiEdit handler gets eventing for free). No bus
// anywhere → None → the producer silently degrades to the pre-FEAT-006 behavior (no event).
export const resolveBus = (explicit?: WikiEventPublisher): Effect.Effect<Option.Option<WikiEventPublisher>> =>
  explicit
    ? Effect.succeed(Option.some(explicit))
    : Effect.serviceOption(DeepAgentEventBus.Service).pipe(
        Effect.map(Option.map((bus): WikiEventPublisher => bus)),
      )
