import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { createRecoveryLifecycle, type LifecycleSnapshot, type RecoveryLifecycle } from "./recovery-lifecycle-state"
import { createExecutionJournalSubscription } from "./lifecycle-execution-pump"

// C6-11 + W9.5 + W9.6 — live wiring of the lifecycle state machine. SOLE source: the durable
// per-session journal drain (context.eventsCursor/events, snapshot-at-watermark, seq-resumed
// poll). W9.6 — the SSE fallback subscription was REMOVED: it always double-delivered the same
// published events (SessionExecution publishes through EventV2 in BOTH admission modes —
// event-v2-bridge.ts only gates the GlobalBus SSE MIRROR, so under admission OFF the mirror
// duplicates rows the journal already persists, and under admission ON the mirror is skipped
// entirely). One source, one reducer — no cross-source dedup needed. The reactive snapshot is
// provided via `useSessionLifecycle()` for consumers (recovery dock / future UX). Renders no
// markup — zero pixel surface.

const SessionLifecycleContext = createContext<{
  readonly lifecycle: Accessor<RecoveryLifecycle>
  readonly snapshot: Accessor<LifecycleSnapshot>
}>()

export const useSessionLifecycle = () => useContext(SessionLifecycleContext)

export function SessionLifecycle(props: { children: JSX.Element }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const params = useParams()
  const [tick, setTick] = createSignal(0)
  const [lifecycle] = createSignal(createRecoveryLifecycle())
  const snapshot = createMemo(() => {
    void tick()
    return lifecycle().snapshot()
  })

  createEffect(() => {
    // Durable journal (SOLE source — W9.6 removed the SSE fallback that double-delivered under
    // admission OFF): poll every known session of the directory plus the active one, anchor each
    // at its watermark on first subscribe, resume from the last seen seq afterwards.
    const journal = createExecutionJournalSubscription({
      client: serverSDK.client,
      lifecycle: lifecycle(),
      sessionIDs: () => {
        const ids = new Set<string>()
        if (params.id) ids.add(params.id)
        for (const session of serverSync.child(sdk.directory, { bootstrap: false })[0].session) ids.add(session.id)
        return [...ids]
      },
      handlers: {
        onEvent: () => setTick((value) => value + 1),
        onConnectionChange: (connected) => {
          // The reducer already owns the disconnect/reconnect vocabulary: the aggregate journal
          // connectivity flips it, and the poll itself resumes from the last cursor (seq-resume).
          lifecycle().onEvent(connected ? { type: "reconnect" } : { type: "disconnect" })
        },
        onResync: ({ sessionID, fromSeq, floor }) => {
          // W9.6 — bounded resync: the journal compacted rows while the drain held its anchor, so
          // the window (fromSeq, floor] is archivally gone and the execution summary for this
          // session resumes from the retained floor. Log-only for now (no UI string burden); the
          // typed notice is the seam a future "history compressed" UI would consume.
          console.warn(`[recovery] execution journal resync (history compacted): session=${sessionID} dropped=(#${fromSeq ?? "?"}, #${floor}]`)
        },
      },
    })
    onCleanup(journal.dispose)

    createEffect(() => {
      // Track reactively (session id, directory, session list CONTENT — not just length, so a
      // same-size set swap still refreshes) and rebuild the drain set only when it changed.
      void params.id
      void serverSync
        .child(sdk.directory, { bootstrap: false })[0]
        .session.map((session) => session.id)
        .join(",")
      journal.refresh()
    })
  })

  return <SessionLifecycleContext.Provider value={{ lifecycle, snapshot }}>{props.children}</SessionLifecycleContext.Provider>
}
