import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"
import { createEffect, createSignal, onCleanup, useContext } from "solid-js"
import type { IMDacSessionReturn } from "../util/im-dac-session-return"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

const routeContext = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )
    const [returnToIM, setReturnToIM] = createSignal<IMDacSessionReturn>()
    onCleanup(() => setReturnToIM(undefined))
    createEffect(() => {
      const record = returnToIM()
      if (record && (store.type !== "session" || !record.available(store.sessionID))) setReturnToIM(undefined)
    })

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setReturnToIM(undefined)
        setStore(reconcile(route))
      },
      openIMDacSession(sessionID: string, record: IMDacSessionReturn) {
        setStore(reconcile({ type: "session", sessionID }))
        setReturnToIM(record)
      },
      canReturnToIM() {
        return store.type === "session" && !!returnToIM()?.available(store.sessionID)
      },
      returnToIM() {
        const record = returnToIM()
        setReturnToIM(undefined)
        return store.type === "session" && !!record?.restore(store.sessionID)
      },
    }
  },
})

export const useRoute = routeContext.use
export const RouteProvider = routeContext.provider
export const useOptionalRoute = () => useContext(routeContext.context)

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
