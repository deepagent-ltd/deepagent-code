import { createMemo, createResource, Show, untrack, type ParentProps } from "solid-js"
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

  const [bootstrap] = createResource(() => server.key, async (key) => {
    if (!key) return { kind: "degraded" } as GateState
    const conn = untrack(() => server.current)
    const activeClient = conn ? createMaintenanceClientForServer(conn.http) : undefined
    if (!activeClient) return { kind: "degraded" } as GateState
    return activeClient.bootstrapStatus()
  })

  // Derive through an ACCESSOR (memo), never through a captured body constant:
  // the compiler emits lazy `get when()` props, so a body-level `const g =
  // gate()` snapshot is frozen forever and the Show never switches (the known
  // startup-splash deadlock). Accessor reads are reactive.
  const maintenanceClient = createMemo(() => {
    const conn = untrack(() => server.current)
    return conn ? createMaintenanceClientForServer(conn.http) : undefined
  })
  const state = createMemo<GateState | undefined>(() => {
    const latest = bootstrap.latest
    if (!latest) return undefined
    if (latest.kind === "ready") return { kind: "ready" }
    if (latest.kind === "read_only_recovery" || latest.kind === "blocked_schema") {
      const client = maintenanceClient()
      return client ? { kind: "maintenance", client } : { kind: "degraded" }
    }
    return { kind: "degraded" }
  })

  if (state()?.kind === "maintenance") return <MaintenanceShell client={(state() as { client: MaintenanceClient }).client} />

  return (
    <Show
      when={state()?.kind === "ready" || state()?.kind === "degraded"}
      fallback={
        <div class="flex h-dvh w-screen flex-col items-center justify-center bg-background-base">
          <Splash class="h-16 w-20 animate-pulse opacity-50" />
        </div>
      }
    >
      {props.children}
    </Show>
  )
}
