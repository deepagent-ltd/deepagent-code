import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
  type ParentProps,
} from "solid-js"
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
//
// W-02 M-6: a READY store with an orchestrated migration chain active (in_progress
// or failed) renders the maintenance shell in its migration-progress mode instead —
// a large-library migration shows phase progress instead of a frozen-looking boot.

type GateState =
  | { kind: "ready" }
  | { kind: "maintenance"; client: MaintenanceClient }
  | { kind: "migration"; client: MaintenanceClient }
  | { kind: "degraded" }

export function BootstrapGate(props: ParentProps) {
  const server = useServer()
  const language = useLanguage()
  // Dismissal is scoped to the active server key: switching servers re-arms the banner.
  const [dismissed, setDismissed] = createSignal<ServerConnection.Key>()

  const [bootstrap, { refetch }] = createResource(
    () => server.key,
    async (key) => {
      if (!key) return { kind: "degraded" } as GateState
      const conn = untrack(() => server.current)
      const activeClient = conn ? createMaintenanceClientForServer(conn.http) : undefined
      if (!activeClient) return { kind: "degraded" } as GateState
      const outcome = await activeClient.bootstrapStatus()
      // W-02 M-6: a READY store with an orchestrated migration chain running (or stopped with a
      // failure) renders the migration-progress shell instead of the app — a large library no
      // longer looks like a frozen startup. A completed/absent journal stays "ready"; an
      // unreachable migration status NEVER blocks (the app renders, degraded banner applies).
      if (outcome.kind === "ready") {
        const migration = await activeClient.migrationStatus()
        if (
          "data" in migration &&
          (migration.data.journal?.status === "in_progress" || migration.data.journal?.status === "failed")
        )
          return { kind: "migration", client: activeClient } as GateState
      }
      return outcome.kind === "ready"
        ? ({ kind: "ready" } as GateState)
        : outcome.kind === "unreachable"
          ? ({ kind: "degraded" } as GateState)
          : ({ kind: "maintenance", client: activeClient } as GateState)
    },
  )

  // Derive through an ACCESSOR (memo), never through a captured body constant:
  // the compiler emits lazy `get when()` props, so a body-level `const g =
  // gate()` snapshot is frozen forever and the Show never switches (the known
  // startup-splash deadlock). Accessor reads are reactive. The resource already maps
  // every outcome to a GateState (maintenance/migration modes carry their live client).
  const state = createMemo<GateState | undefined>(() => {
    const latest = bootstrap.latest
    return latest?.kind === undefined ? undefined : latest
  })

  // While the migration shell is up, keep re-probing: the shell reports settlement (chain
  // completed / journal gone) through the callback, which flips the gate back to the app.
  const migrationSettled = () => void refetch()
  createEffect(() => {
    if (state()?.kind !== "migration") return
    const timer = setInterval(() => void refetch(), 4000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Switch
      fallback={
        <div class="flex h-dvh w-screen flex-col items-center justify-center bg-background-base">
          <Splash class="h-16 w-20 animate-pulse opacity-50" />
        </div>
      }
    >
      <Match when={state()?.kind === "maintenance"}>
        <MaintenanceShell
          client={(state() as { client: MaintenanceClient }).client}
          onRestoreReady={() => void refetch()}
        />
      </Match>
      <Match when={state()?.kind === "migration"}>
        <MaintenanceShell
          client={(state() as { client: MaintenanceClient }).client}
          mode="migration_in_progress"
          onMigrationSettled={migrationSettled}
        />
      </Match>
      <Match when={state()?.kind === "ready" || state()?.kind === "degraded"}>
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
                <div class="text-11-regular text-text-weak">
                  {language.t("maintenance.degraded.banner.description")}
                </div>
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
      </Match>
    </Switch>
  )
}
