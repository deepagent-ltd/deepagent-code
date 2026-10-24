import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { SettingsPage } from "@/components/settings-v2/parts/page"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"

afterEach(cleanup)

it("keeps one shared header/search separate from the single scroll body without intercepting actions", () => {
  const action = vi.fn()
  const [state, setState] = createStore({ query: "" })
  const fixture = render(() => (
    <SettingsPage
      title="Models"
      description="Choose the models available to this client."
      action={<button onClick={action}>Refresh</button>}
      search={
        <input
          aria-label="Search models"
          value={state.query}
          onInput={(event) => setState("query", event.currentTarget.value)}
        />
      }
      class="models-fixture"
    >
      <SettingsListV2>
        <SettingsRowV2 title="Model visibility" description="Preserve the existing setting control.">
          <input aria-label="Visible" type="checkbox" />
        </SettingsRowV2>
      </SettingsListV2>
    </SettingsPage>
  ))
  const header = fixture.container.querySelector("header")!
  const body = fixture.container.querySelector<HTMLElement>(".settings-v2-tab-body")!
  expect(within(header).getAllByRole("heading", { level: 2 })).toHaveLength(1)
  expect(body.contains(header)).toBe(false)
  expect(body.classList.contains("models-fixture")).toBe(true)
  expect(fixture.container.querySelectorAll(".settings-v2-tab-body")).toHaveLength(1)
  fireEvent.click(within(header).getByRole("button", { name: "Refresh" }))
  expect(action).toHaveBeenCalledOnce()
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "flash" } })
  expect(state.query).toBe("flash")
  fireEvent.click(within(body).getByRole("checkbox"))
  expect(within(body).getByRole<HTMLInputElement>("checkbox").checked).toBe(true)
})

it("exposes explicit short-row versus full-width-field layout while preserving complete long values", () => {
  const value = `C:\\Workspace\\${"long-name-".repeat(40)}\\cache.json`
  const [state] = createStore({ path: value })
  const fixture = render(() => (
    <SettingsPage title="Settings">
      <SettingsRowV2 title="Notifications">
        <input type="checkbox" aria-label="Notify" />
      </SettingsRowV2>
      <SettingsRowV2 layout="field" title="Import source" description={value}>
        <input aria-label="Path" value={state.path} />
      </SettingsRowV2>
    </SettingsPage>
  ))
  const rows = fixture.container.querySelectorAll('[data-component="settings-v2-row"]')
  expect(rows[0].getAttribute("data-layout")).toBe("row")
  expect(rows[1].getAttribute("data-layout")).toBe("field")
  expect(within(rows[1] as HTMLElement).getByRole<HTMLInputElement>("textbox").value).toBe(value)
  expect(rows[1].textContent).toContain(value)
  expect(rows[0].querySelector('[data-slot="settings-v2-row-title"]')?.textContent).toBe("Notifications")
})
