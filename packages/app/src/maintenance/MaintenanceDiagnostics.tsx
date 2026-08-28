import { For, Show } from "solid-js"
import type { DiagnosticEntry } from "./maintenance-diagnostics"

// C6-05: renders the ALREADY-safe diagnostics entries (see maintenance-diagnostics.ts).
// The shell never stores a raw diagnostics object (which may carry a path/credential
// in `message`); only the whitelisted stable-code entries reach this component, so a
// sensitive value cannot leak into the DOM.

export function MaintenanceDiagnostics(props: { entries: readonly DiagnosticEntry[] }) {
  return (
    <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-12-regular text-text-weak">
      <Show
        when={props.entries.length > 0}
        fallback={<div class="text-12-regular text-text-weak">{/* no safe diagnostics */}</div>}
      >
        <For each={props.entries}>
          {(entry) => (
            <>
              <dt class="font-medium text-text-strong">{entry.key}</dt>
              <dd class="min-w-0 break-all">{entry.value}</dd>
            </>
          )}
        </For>
      </Show>
    </dl>
  )
}
