import { Show, type JSX, type ParentProps } from "solid-js"
import "../settings-v2.css"

export function SettingsPage(
  props: ParentProps<{
    title: JSX.Element
    description?: JSX.Element
    action?: JSX.Element
    search?: JSX.Element
    class?: string
  }>,
) {
  return (
    <div data-component="settings-v2-page">
      <header class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <div class="settings-v2-page-heading">
            <h2 class="settings-v2-tab-title">{props.title}</h2>
            <Show when={props.description}>
              <p class="settings-v2-page-description">{props.description}</p>
            </Show>
          </div>
          <Show when={props.action}>
            <div class="settings-v2-actions">{props.action}</div>
          </Show>
        </div>
        <Show when={props.search}>{props.search}</Show>
      </header>
      <div class="settings-v2-tab-body" classList={{ [props.class ?? ""]: !!props.class }}>
        {props.children}
      </div>
    </div>
  )
}
