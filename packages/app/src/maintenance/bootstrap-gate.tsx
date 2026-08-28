import { createEffect, createMemo, createSignal, Show, type ParentProps } from "solid-js"
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
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "maintenance"; client: MaintenanceClient }
  | { kind: "degraded" }

export function BootstrapGate(props: ParentProps) {
  const server = useServer()
  const [gate, setGate] = createSignal<GateState>({ kind: "loading" })

  const client = createMemo(() => {
    const conn = server.current
    return conn ? createMaintenanceClientForServer(conn.http) : undefined
  })

  createEffect(() => {
    // Re-run when the active server changes so a server switch re-reads bootstrap.
    server.key
    setGate({ kind: "loading" })
    const active = client()
    if (!active) {
      setGate({ kind: "degraded" })
      return
    }
    let cancelled = false
    void active.bootstrapStatus().then((outcome) => {
      if (cancelled) return
      if (outcome.kind === "ready") setGate({ kind: "ready" })
      else if (outcome.kind === "read_only_recovery" || outcome.kind === "blocked_schema")
        setGate({ kind: "maintenance", client: active })
      else setGate({ kind: "degraded" })
    })
    return () => {
      cancelled = true
    }
  })

  // Solid re-runs this body on every reactive read, so `g` is the current gate value.
  const g = gate()

  if (g.kind === "maintenance") return <MaintenanceShell client={g.client} />

  return (
    <Show when={g.kind === "ready" || g.kind === "degraded"} fallback={<SplashLoading />}>
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
