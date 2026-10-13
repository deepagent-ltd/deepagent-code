import { createEffect, createMemo, Match, onCleanup, onMount, Show, Switch, untrack } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useTuiI18n } from "../../context/i18n"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const i18n = useTuiI18n()
  const sdk = useSDK()
  const project = useProject()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  // W2-1 — live goal status for THIS session (goal.updated SSE projection). Rendered as a compact
  // phase + budget chip so a long-running autonomous goal is observable from the terminal.
  const goal = createMemo(() => {
    if (route.data.type !== "session") return undefined
    return sync.data.session_goal?.[route.data.sessionID]
  })
  const goalPhaseColor = (phase: string) =>
    phase === "running"
      ? theme.success
      : phase === "paused"
        ? theme.warning
        : phase === "needs_human"
          ? theme.error
          : theme.text
  const goalLabel = () => {
    const value = goal()?.control
    if (!value) return i18n.t("tui.goal.control.checking")
    if (value.recoveryRequired || value.preparation === "recovery_required") return i18n.t("tui.goal.control.recovery")
    if (value.preparation === "preparing") return i18n.t("tui.goal.control.preparing")
    if (value.inFlight && value.requestedPhase === "paused") return i18n.t("tui.goal.control.pauseRequested")
    if (value.inFlight && value.requestedPhase === "stopped") return i18n.t("tui.goal.control.stopRequested")
    if (value.wakeState === "pending") return i18n.t("tui.goal.control.pending")
    const keys = {
      running: "running",
      paused: "paused",
      stopped: "stopped",
      done: "done",
      needs_human: "needsHuman",
      rolled_back: "rolledBack",
    } as const
    const phase = keys[value.phase as keyof typeof keys]
    return phase ? i18n.t(`tui.goal.control.phase.${phase}`) : value.phase
  }
  createEffect(() => {
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    if (!sessionID) return
    const client = sdk.client
    const directory = project.instance.path().directory
    let observed = false
    const read = () =>
      sync.goal
        .sync(sessionID)
        .then(() => {
          observed = true
        })
        .catch(() => undefined)
    void untrack(read)
    const timer = setInterval(() => {
      if (sdk.client !== client || project.instance.path().directory !== directory) return
      const control = goal()?.control
      if ((!goal() && observed) || (control && GoalClient.confirmedTerminal(control))) return
      void read()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })
  const directory = useDirectory()
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={goal()}>
              {(g) => (
                <text fg={goalPhaseColor(g().phase)}>
                  <span style={{ fg: goalPhaseColor(g().phase) }}>◉</span> goal {goalLabel()} · t{g().ticks} ·{" "}
                  {(g().tokens / 1000).toFixed(1)}k tok
                  {g().cost > 0 ? ` · $${g().cost.toFixed(2)}` : ""}
                </text>
              )}
            </Show>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
