import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { McpAppInvokeResponse } from "@deepagent-code/sdk"
import { observeMcpAppInvocations } from "@deepagent-code/sdk/mcp-app-observer"
import { Button } from "@deepagent-code/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

export function SessionMcpAppInvocations(props: { sessionID: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ statuses: [] as readonly McpAppInvokeResponse[], error: false })
  let refresh: (() => Promise<void>) | undefined
  createEffect(() => {
    const owner = { client: sdk.client, scope: sdk.scope, directory: sdk.directory, sessionID: props.sessionID }
    setState({ statuses: [], error: false })
    const observer = observeMcpAppInvocations({
      ...owner,
      current: () =>
        sdk.client === owner.client &&
        sdk.scope === owner.scope &&
        sdk.directory === owner.directory &&
        props.sessionID === owner.sessionID,
      subscribe: (changed) => sdk.event.on("session.mcp-app.changed", (event) => changed(event.properties.status)),
      changed: (statuses) => setState({ statuses, error: false }),
      unavailable: () => setState("error", true),
    })
    refresh = observer.refresh
    void observer.refresh()
    onCleanup(() => {
      refresh = undefined
      observer.close()
    })
  })
  return (
    <Show when={state.statuses.length || state.error}>
      <details
        class="shrink-0 max-h-48 overflow-y-auto border-b border-border-base px-4 py-2 text-12-regular"
        data-mcp-app-history
      >
        <summary class="cursor-pointer text-text-base">
          {language.t("mcp.apps.history")} · {state.statuses.length}
        </summary>
        <Button size="small" variant="ghost" onClick={() => void refresh?.()}>
          {language.t("mcp.apps.refresh")}
        </Button>
        <Show when={state.error}>
          <p role="alert">{language.t("common.requestFailed")}</p>
        </Show>
        <For
          each={state.statuses
            .toSorted((a, b) => Number(b.state === "unknown") - Number(a.state === "unknown"))
            .slice(0, 8)}
        >
          {(status) => (
            <div
              data-mcp-app-invocation={status.invocationID}
              data-state={status.state}
              class="border-t border-border-base py-1"
            >
              <p>{language.t(`mcp.apps.state.${status.state}`)}</p>
              <p class="break-all text-text-weak">{status.invocationID}</p>
              <Show when={status.errorCode}>
                <p>{status.errorCode}</p>
              </Show>
              <Show when={status.state === "unknown"}>
                <p>{language.t("mcp.apps.unknownHint")}</p>
              </Show>
            </div>
          )}
        </For>
      </details>
    </Show>
  )
}
