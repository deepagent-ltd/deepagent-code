import { createMemo, createResource, createSignal, Show, untrack, type ParentProps } from "solid-js"
import { Splash } from "@deepagent-code/ui/logo"
import { ServerConnection, useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import type { MaintenanceClient } from "./maintenance-client"
import { createMaintenanceClientForServer } from "./maintenance-client-server"
import { MaintenanceShell } from "./MaintenanceShell"

// C6-05 bootstrap gate (design §11.3): the shell first reads the pre-open
// `/bootstrap/status` (Database.bootstrap) and ONLY renders the business app when
// the store is writable (`mode === "ready"`). A read-only or schema-blocked store
// renders the maintenance shell. When the bootstrap endpoint cannot even be read
// (network/decode) the gate degrades to the normal app rather than dead-locking the
// user on an unreachable maintenance page — and shows a dismissible banner so the
// incident state (maintenance protections inactive) is visible.

type GateState =
  | { kind: "ready" }
  | { kind: "maintenance"; client: MaintenanceClient }
  | { kind: "degraded" }

export function BootstrapGate(props: ParentProps) {
  const server = useServer()
  const language = useLanguage()
  // Dismissal is scoped to the active server key: switching servers re-arms the banner.
  const [dismissed, setDismissed] = createSignal<ServerConnection.Key>()

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
      {/* Degraded still renders the normal app (never blocks); the banner only warns that the
          maintenance endpoint is unreachable, so its protections are not in effect. */}
      <Show when={state()?.kind === "degraded" && dismissed() !== server.key}>
        <div class="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3">
          <div
            role="alert"
            class="pointer-events-auto flex items-center gap-4 rounded-md border border-border-warning-base bg-surface-raised-base px-4 py-2 shadow-[var(--shadow-lg-border-base)]"
          >
            <div>
              <div class="text-12-medium text-text-warning">{language.t("maintenance.degraded.banner.title")}</div>
              <div class="text-11-regular text-text-weak">{language.t("maintenance.degraded.banner.description")}</div>
            </div>
            <button
              type="button"
              class="shrink-0 text-12-regular text-text-weak underline"
              onClick={() => setDismissed(server.key)}
            >
              {language.t("maintenance.degraded.banner.dismiss")}
            </button>
          </div>
        </div>
      </Show>
      {props.children}
    </Show>
  )
}
