import { Duration, Effect, Fiber, Stream } from "effect"
import type { AgentProgressPart } from "@deepagent-code/core/im/agent-reply-sink"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { MessageV2 } from "@/session/message-v2"

/**
 * Stream one IM agent turn's live progress (reasoning / assistant text / tool
 * activity) out of the kernel session event bus, batched and throttled, so a
 * caller can forward it to the hub for a real-time "what the agent is doing"
 * view.
 *
 * ## Why this exists
 * The IM reply is one-message-in / one-message-out: the final answer is the only
 * thing persisted. But an agent turn can take tens of seconds (tool calls, long
 * reasoning). Users want to SEE that work as it happens. The kernel already
 * emits fine-grained, always-on V1 events during a turn — we tap them here.
 *
 * ## Source events (V1, no experimental flag required)
 *   - `SessionV1.Event.PartUpdated` — full snapshot of a part (reasoning / text /
 *     tool), carrying its `type` and, for tools, `state.status`. This is how we
 *     learn each part's KIND and a tool's lifecycle.
 *   - `MessageV2.Event.PartDelta`  — incremental text for a part, keyed by
 *     `partID`. Its `field` is always "text", so we classify the delta by the
 *     kind we recorded from the part's first PartUpdated.
 * Both carry `sessionID`; we filter to the turn's fresh session so no other
 * session's traffic leaks in.
 *
 * ## Snapshot semantics (resilience)
 * We keep a per-`partID` accumulator and emit REPLACE snapshots — the client
 * keeps a map keyed by partID and overwrites. A dropped or reordered batch
 * self-heals on the next snapshot, and the authoritative final reply still
 * arrives separately via the sink's `notify`. Text is accumulated locally from
 * deltas and corrected by PartUpdated's full value (PartUpdated is source of
 * truth for a part's final text).
 *
 * ## Lifecycle & the final flush
 * {@link withAgentProgress} wraps the prompt Effect. It forks a collector fiber
 * (folds bus events into the accumulator) and a periodic flusher fiber (emits
 * changed parts every {@link FLUSH_EVERY}) BEFORE running the body, then — no
 * matter how the body exits (success, timeout-interrupt, defect) — interrupts
 * both fibers and performs ONE final flush so the terminal tool-completed /
 * final-reasoning state is never lost in the last unflushed window. Streaming is
 * strictly best-effort: it never changes the body's result or failure.
 */

interface PartAccumulator {
  partID: string
  order: number
  kind: "reasoning" | "text" | "tool"
  text: string
  tool?: string
  status?: string
}

const FLUSH_EVERY = Duration.millis(400)

/**
 * Run `body` (the agent prompt) while streaming its live progress to `onBatch`.
 * Returns exactly what `body` returns; streaming failures are swallowed.
 */
export function withAgentProgress<A, E, R>(input: {
  sessionID: string
  onBatch: (parts: ReadonlyArray<AgentProgressPart>) => Effect.Effect<void, never, never>
  body: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R | EventV2Bridge.Service> {
  return Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    // Live accumulator, mutated only by the collector fiber and read by the
    // flusher / final flush. Single-fiber writes keep this race-free.
    const parts = new Map<string, PartAccumulator>()
    const dirty = new Set<string>()
    let nextOrder = 0

    const ensure = (partID: string, kind: PartAccumulator["kind"]): PartAccumulator => {
      let acc = parts.get(partID)
      if (!acc) {
        acc = { partID, order: nextOrder++, kind, text: "" }
        parts.set(partID, acc)
      }
      return acc
    }

    // Emit the current state of every part changed since the last flush.
    const flush = Effect.suspend(() => {
      if (dirty.size === 0) return Effect.void
      const batch: AgentProgressPart[] = []
      for (const partID of dirty) {
        const acc = parts.get(partID)
        if (!acc) continue
        batch.push({
          partID: acc.partID,
          order: acc.order,
          kind: acc.kind,
          ...(acc.kind === "tool" ? { tool: acc.tool, status: acc.status } : { text: acc.text }),
        })
      }
      dirty.clear()
      batch.sort((a, b) => a.order - b.order)
      return input.onBatch(batch)
    })

    // Collector: fold both source event streams into the accumulator. Subscribe
    // BEFORE the body runs so no early delta is missed (PubSub is live-only).
    const partUpdates = events.subscribe(SessionV1.Event.PartUpdated).pipe(
      Stream.filter((event) => event.data.sessionID === input.sessionID),
      Stream.map((event) => ({ _tag: "part" as const, part: event.data.part })),
    )
    const partDeltas = events.subscribe(MessageV2.Event.PartDelta).pipe(
      Stream.filter((event) => event.data.sessionID === input.sessionID),
      Stream.map((event) => ({ _tag: "delta" as const, partID: event.data.partID, delta: event.data.delta })),
    )
    const collector = Stream.merge(partUpdates, partDeltas).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          if (item._tag === "part") {
            const part = item.part
            if (part.type === "reasoning") {
              const acc = ensure(part.id, "reasoning")
              acc.text = part.text
              dirty.add(acc.partID)
            } else if (part.type === "text") {
              if (part.synthetic || part.ignored) return
              const acc = ensure(part.id, "text")
              acc.text = part.text
              dirty.add(acc.partID)
            } else if (part.type === "tool") {
              const acc = ensure(part.id, "tool")
              acc.tool = part.tool
              acc.status = part.state.status
              dirty.add(acc.partID)
            }
          } else {
            // Delta before its classifying PartUpdated defaults to "text"; the
            // PartUpdated that follows corrects the kind and full value.
            const acc = ensure(item.partID, "text")
            acc.text += item.delta
            dirty.add(acc.partID)
          }
        }),
      ),
      Effect.catchCause(() => Effect.void),
    )

    // Periodic flusher.
    const flusher = flush.pipe(Effect.delay(FLUSH_EVERY), Effect.forever, Effect.catchCause(() => Effect.void))

    const collectorFiber = yield* Effect.forkChild(collector)
    const flusherFiber = yield* Effect.forkChild(flusher)

    return yield* input.body.pipe(
      // Tear down streaming on ANY exit and emit the final coalesced state so
      // the terminal tool/reasoning snapshot isn't stranded in the last window.
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Fiber.interrupt(flusherFiber)
          // Give the collector a beat to drain events the body's completion
          // published just before returning, then stop it and flush once.
          yield* Effect.sleep(Duration.millis(50))
          yield* Fiber.interrupt(collectorFiber)
          yield* flush.pipe(Effect.catchCause(() => Effect.void))
        }).pipe(Effect.catchCause(() => Effect.void)),
      ),
    )
  })
}
