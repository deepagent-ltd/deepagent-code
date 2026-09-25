import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
  type ParentProps,
} from "solid-js"
import { Splash } from "@deepagent-code/ui/logo"
import { ServerConnection, useServer, serverName } from "@/context/server"
import { useLanguage } from "@/context/language"
import type { MaintenanceClient } from "./maintenance-client"
import { createMaintenanceClientForServer } from "./maintenance-client-server"
import { MaintenanceShell } from "./MaintenanceShell"

// C6-05 bootstrap gate (design §11.3): the shell first reads the pre-open
// `/bootstrap/status` (Database.bootstrap) and ONLY renders the business app when
// the store is writable (`mode === "ready"`). A read-only or schema-blocked store
// renders the maintenance shell.
//
// An unreachable bootstrap endpoint is NOT a maintenance mode: it means the server
// itself is offline (dead sidecar, wrong port, network cut). Rendering the app in
// that state hangs every downstream fetch on a dead connection (infinite "Loading",
// silent dialog failures) while the old "maintenance status unknown" banner misnamed
// the incident. The gate now renders a dedicated offline screen for that case:
// named server, automatic re-probing, and one-click switching to another configured
// server. Recovery is automatic — the moment the probe succeeds the gate re-runs.

type GateState =
  | { kind: "ready" }
  | { kind: "maintenance"; client: MaintenanceClient }
  | { kind: "migration"; client: MaintenanceClient }
  // Offline-before-ready: nothing has loaded against this server yet, so a full offline
  // screen (auto re-probe + server switcher) is strictly better than an app whose every
  // fetch hangs.
  | { kind: "offline" }
  // Offline-after-ready: the app already booted against this server and holds live content
  // (drafts, scroll); tearing it down on a transient connection drop would discard user
  // context. Keep the app mounted and show a reconnect banner until the probe succeeds.
  | { kind: "offline_after_ready" }

/**
 * The gate decision for an unreachable bootstrap endpoint: a cold boot (this server never
 * reached ready) takes the offline screen, a server that already served the app keeps it
 * mounted behind a reconnect banner. Extracted pure so the branching is unit-testable.
 */
export function offlineGateState(everReady: ServerConnection.Key | undefined, key: ServerConnection.Key) {
  return everReady === key ? "offline_after_ready" : "offline"
}

export function BootstrapGate(props: ParentProps) {
  const server = useServer()
  const language = useLanguage()

  // The server key that reached ready at least once this session. Read inside the resource
  // fetch body via untrack: the fetch must not re-run on this signal's updates.
  const [everReady, setEverReady] = createSignal<ServerConnection.Key>()

  const [bootstrap, { refetch }] = createResource(
    () => server.key,
    async (key) => {
      if (!key) return { kind: "offline" } as GateState
      const conn = untrack(() => server.current)
      const activeClient = conn ? createMaintenanceClientForServer(conn.http) : undefined
      if (!activeClient) return { kind: "offline" } as GateState
      const outcome = await activeClient.bootstrapStatus()
      // W-02 M-6: a READY store with an orchestrated migration chain running (or stopped with a
      // failure) renders the migration-progress shell instead of the app — a large library no
      // longer looks like a frozen startup. A completed/absent journal stays "ready".
      if (outcome.kind === "ready") {
        untrack(() => setEverReady(key))
        const migration = await activeClient.migrationStatus()
        if (
          "data" in migration &&
          (migration.data.journal?.status === "in_progress" || migration.data.journal?.status === "failed")
        )
          return { kind: "migration", client: activeClient } as GateState
        return { kind: "ready" } as GateState
      }
      if (outcome.kind !== "unreachable") return { kind: "maintenance", client: activeClient } as GateState
      // The server is offline. Which offline state applies depends on whether this server
      // EVER reached ready in this session: a user with loaded content keeps it (banner),
      // a cold boot gets the offline screen.
      return { kind: offlineGateState(untrack(everReady), key) } as GateState
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

  // While offline (either variant), re-probe on a short cadence: a sidecar coming up or
  // the network recovering flips the gate back to the app without any user action. The
  // probe IS the bootstrap fetch, so a successful probe directly re-runs the gate decision.
  createEffect(() => {
    const kind = state()?.kind
    if (kind !== "offline" && kind !== "offline_after_ready") return
    const timer = setInterval(() => void refetch(), 3000)
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
      <Match when={state()?.kind === "offline"}>
        <OfflineScreen />
      </Match>
      <Match when={state()?.kind === "offline_after_ready"}>
        {/* The app keeps its loaded content; the banner states the actual incident (server
          connection lost, reconnecting) instead of the old maintenance-protection wording. */}
        <div class="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3">
          <div
            role="alert"
            class="pointer-events-auto flex items-center gap-4 rounded-md border border-border-warning-base bg-surface-raised-base px-4 py-2 shadow-[var(--shadow-lg-border-base)]"
          >
            <div>
              <div class="text-12-medium text-text-warning">{language.t("app.offline.banner.title")}</div>
              <div class="text-11-regular text-text-weak">{language.t("app.offline.banner.description")}</div>
            </div>
          </div>
        </div>
        {props.children}
      </Match>
      <Match when={state()?.kind === "ready"}>{props.children}</Match>
    </Switch>
  )
}

function OfflineScreen() {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => server.setActive(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
