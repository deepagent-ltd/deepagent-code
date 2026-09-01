import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { createRecoveryLifecycle, type LifecycleSnapshot, type RecoveryLifecycle } from "./recovery-lifecycle-state"
import { subscribeExecutionEvents } from "./lifecycle-execution-pump"

// C6-11 — live wiring of the lifecycle state machine. The dir SDK event stream carries the
// session's real `session.execution.*` events; this pump subscribes once per directory and
// feeds them into ONE lifecycle reducer (the reducer is per-session keyed, so all sessions of
// the directory share the instance without cross-session bleed). The reactive snapshot is
// provided via `useSessionLifecycle()` for consumers (recovery dock / future UX). Renders no
// markup — zero pixel surface.

const SessionLifecycleContext = createContext<{
  readonly lifecycle: Accessor<RecoveryLifecycle>
  readonly snapshot: Accessor<LifecycleSnapshot>
}>()

export const useSessionLifecycle = () => useContext(SessionLifecycleContext)

export function SessionLifecycle(props: { children: JSX.Element }) {
  const sdk = useSDK()
  const [tick, setTick] = createSignal(0)
  const [lifecycle] = createSignal(createRecoveryLifecycle())
  const snapshot = createMemo(() => {
    void tick()
    return lifecycle().snapshot()
  })

  createEffect(() => {
    // Trigger a re-render of consumers (tick) + refresh the snapshot memo after each event.
    const stop = subscribeExecutionEvents(sdk.event, lifecycle(), () => {
      setTick((value) => value + 1)
    })
    onCleanup(stop)
  })

  return <SessionLifecycleContext.Provider value={{ lifecycle, snapshot }}>{props.children}</SessionLifecycleContext.Provider>
}
