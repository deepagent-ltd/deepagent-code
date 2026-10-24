import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"

// Each mounted page owns only its explicit observation. It cannot renew a
// credential, start communication, or adopt a response from another realm.
export function createIMEntitlementRead(input: {
  current: () => boolean
  scope: () => unknown
  entitlement: (signal: AbortSignal) => Promise<IMEntitlementSchema.Observation>
  plans?: (signal: AbortSignal) => Promise<IMEntitlementSchema.PlansObservation>
}) {
  const [state, setState] = createStore({
    entitlement: undefined as IMEntitlementSchema.Observation | undefined,
    plans: undefined as IMEntitlementSchema.PlansObservation | undefined,
    loading: false,
    failed: false,
  })
  const lifetime = { generation: 0, abort: new AbortController(), disposed: false, scope: undefined as unknown }
  const current = () => !lifetime.disposed && input.current() && input.scope() === lifetime.scope
  const retire = () => {
    lifetime.generation++
    lifetime.abort.abort()
    lifetime.abort = new AbortController()
    lifetime.scope = undefined
    setState({ entitlement: undefined, plans: undefined, loading: false, failed: false })
  }
  const refresh = async () => {
    if (lifetime.disposed || !input.current() || state.loading) return
    lifetime.scope = input.scope()
    const generation = ++lifetime.generation
    const signal = AbortSignal.any([lifetime.abort.signal, AbortSignal.timeout(10_000)])
    setState({ loading: true, failed: false, entitlement: undefined, plans: undefined })
    const results = await Promise.allSettled([input.entitlement(signal), input.plans?.(signal)] as const)
    if (!current() || generation !== lifetime.generation || signal.aborted) {
      if (current() && generation === lifetime.generation) setState({ loading: false, failed: true })
      return
    }
    setState({
      entitlement: results[0].status === "fulfilled" ? results[0].value : undefined,
      plans: results[1].status === "fulfilled" ? results[1].value : undefined,
      loading: false,
      failed: results.some((result) => result.status === "rejected"),
    })
  }
  createEffect(
    on([input.current, input.scope], ([active]) => {
      retire()
      if (active) void refresh()
    }),
  )
  onCleanup(() => {
    lifetime.disposed = true
    retire()
  })
  return {
    // Subscribe even before the initial effect captures a scope. Otherwise the
    // guard's first false result can leave a mounted page stuck on unknown.
    entitlement: () => {
      const value = state.entitlement
      return current() ? value : undefined
    },
    plans: () => {
      const value = state.plans
      return current() ? value : undefined
    },
    loading: () => state.loading && current(),
    failed: () => state.failed && current(),
    refresh,
  }
}
