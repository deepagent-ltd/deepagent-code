import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { McpAppInvokeResponse } from "@deepagent-code/sdk"
import { observeMcpAppInvocations } from "@deepagent-code/sdk/mcp-app-observer"
import { useSDK } from "../../context/sdk"
import { useEvent } from "../../context/event"
import { useProject } from "../../context/project"
import { useTheme } from "../../context/theme"
import { useTuiI18n } from "../../context/i18n"

export function SessionMcpAppInvocations(props: { sessionID: string }) {
  const sdk = useSDK()
  const event = useEvent()
  const project = useProject()
  const theme = useTheme()
  const i18n = useTuiI18n()
  const [state, setState] = createStore({ statuses: [] as readonly McpAppInvokeResponse[], error: false })
  createEffect(() => {
    const owner = {
      client: sdk.client,
      url: sdk.url,
      directory: project.instance.path().directory,
      sessionID: props.sessionID,
    }
    setState({ statuses: [], error: false })
    const observer = observeMcpAppInvocations({
      ...owner,
      current: () =>
        sdk.client === owner.client &&
        sdk.url === owner.url &&
        project.instance.path().directory === owner.directory &&
        props.sessionID === owner.sessionID,
      subscribe: (changed) => event.on("session.mcp-app.changed", (hint) => changed(hint.properties.status)),
      changed: (statuses) => setState({ statuses, error: false }),
      unavailable: () => setState("error", true),
    })
    void observer.refresh()
    onCleanup(() => observer.close())
  })
  return (
    <Show when={state.statuses.length || state.error}>
      <box flexDirection="column" paddingLeft={2} paddingRight={2} flexShrink={0}>
        <text fg={theme.theme.textMuted}>
          {i18n.t("tui.mcp.apps.history")} · {state.statuses.length}
        </text>
        <Show when={state.error}>
          <text fg={theme.theme.error}>{i18n.t("tui.mcp.apps.unavailable")}</text>
        </Show>
        <For
          each={state.statuses
            .toSorted((a, b) => Number(b.state === "unknown") - Number(a.state === "unknown"))
            .slice(0, 4)}
        >
          {(status) => (
            <box flexDirection="column">
              <text fg={status.state === "unknown" ? theme.theme.warning : theme.theme.text}>
                {i18n.t(`tui.mcp.apps.state.${status.state}`)} · {status.invocationID}
              </text>
              <Show when={status.state === "unknown"}>
                <text fg={theme.theme.warning}>{i18n.t("tui.mcp.apps.unknownHint")}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
