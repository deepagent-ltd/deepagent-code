import { createResource, Show, untrack, type ParentProps } from "solid-js"
import { Splash } from "@deepagent-code/ui/logo"
import { useServer } from "@/context/server"
import type { MaintenanceClient } from "./maintenance-client"
import { createMaintenanceClientForServer } from "./maintenance-client-server"
import { MaintenanceShell } from "./MaintenanceShell"

// C6-05 bootstrap gate (design §11.3): the shell first reads the pre-open
// `/bootstrap/status` (Database.bootstrap) and ONLY renders the business app when
// the store is writable (`mode === "ready"`). A read-only or schema-blocked store
// renders the maintenance shell. When the bootstrap endpoint cannot even be read
// (network/decode) the gate degrades to the normal app rather than dead-locking the
// user on an unreachable maintenance page.

type GateState =
  | { kind: "ready" }
  | { kind: "maintenance"; client: MaintenanceClient }
  | { kind: "degraded" }

export function BootstrapGate(props: ParentProps) {
  const server = useServer()

  // Keyed on the active-server key so a server switch re-reads bootstrap; the
  // resource's state transitions drive the render (the previous createSignal +
  // createEffect version would not re-render on the promise callback in the
  // desktop renderer, leaving the app on the splash forever).
  const [bootstrap] = createResource(() => server.key, async (key) => {
    if (!key) return { kind: "degraded" } as GateState
    const conn = untrack(() => server.current)
    const activeClient = conn ? createMaintenanceClientForServer(conn.http) : undefined
    if (!activeClient) return { kind: "degraded" } as GateState
    return activeClient.bootstrapStatus()
  })

  const g = bootstrap.latest

  if (g?.kind === "maintenance") return <MaintenanceShell client={g.client} />

  return (
    <Show when={g?.kind === "ready" || g?.kind === "degraded"} fallback={<SplashLoading />}>
      {props.children}
    </Show>
  )
}

function SplashLoading() {
  return (
    <div class="flex h-dvh w-screen flex-col items-center justify-center bg-background-base">
      <Splash class="h-16 w-20 animate-pulse opacity-50" />
    </div>
  )
}
