import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { createRecoveryLifecycle, type LifecycleSnapshot, type RecoveryLifecycle } from "./recovery-lifecycle-state"
import { createExecutionJournalSubscription, subscribeExecutionEvents } from "./lifecycle-execution-pump"

// C6-11 + W9.5 — live wiring of the lifecycle state machine. PRIMARY source: the durable per-session
// journal drain (context.eventsCursor/events, snapshot-at-watermark, seq-resumed poll) — the only
// execution surface when V2 admission is ON, because event-v2-bridge.ts skips the GlobalBus SSE
// mirror in that mode (`session.execution.*` never reaches `sdk.event`). The SSE dir-SDK emitter is
// kept as a fallback/compat subscription for the admission-OFF mirror. Both feed ONE per-session
// keyed lifecycle reducer, so all sessions of the directory share the instance without cross-session
// bleed. The reactive snapshot is provided via `useSessionLifecycle()` for consumers (recovery dock /
// future UX). Renders no markup — zero pixel surface.

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
    // SSE fallback/compat (admission-OFF mirror); inert under admission ON (mirror skipped).
    const stop = subscribeExecutionEvents(sdk.event, lifecycle(), () => {
      setTick((value) => value + 1)
    })
    onCleanup(stop)
  })

  createEffect(() => {
    // Durable journal (PRIMARY): poll every known session of the directory plus the active one,
    // anchor each at its watermark on first subscribe, resume from the last seen seq afterwards.
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
