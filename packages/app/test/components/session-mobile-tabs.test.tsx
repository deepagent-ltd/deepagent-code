import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionMobileTabs } from "@/pages/session/session-mobile-tabs"
import { WorkPanelTabs } from "@/pages/session/work-panel-tabs"
import { dict } from "@/i18n/en"

const rightPanel = vi.hoisted(() => ({
  mode: (): string | undefined => undefined,
  open: (_mode: string) => {},
  close: () => {},
}))
vi.mock("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ view: () => ({ rightPanel }) }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))

beforeEach(() => {
  const [state, setState] = createStore({ mode: undefined as string | undefined })
  rightPanel.mode = () => state.mode
  rightPanel.open = (mode) => setState("mode", mode)
  rightPanel.close = () => setState("mode", undefined)
})
afterEach(cleanup)

it("opens the shared IM panel from keyboard navigation and returns to the main conversation", async () => {
  const user = userEvent.setup()
  const [state, setState] = createStore({ tab: "session" as "session" | "changes" })
  render(() => (
    <SessionMobileTabs tab={state.tab} onChange={(tab) => setState("tab", tab)} hasSession reviewCount={2} />
  ))
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: dict["session.tab.session"] }))
  await user.keyboard("{End}")
  await waitFor(() => expect(rightPanel.mode()).toBe("im"))
  expect(screen.getByRole("tab", { name: dict["session.tab.im"] }).getAttribute("aria-selected")).toBe("true")
  await user.keyboard("{Home}")
  await waitFor(() => expect(rightPanel.mode()).toBeUndefined())
  expect(state.tab).toBe("session")
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: dict["session.tab.session"] }))
})

it("keeps messages reachable before a session exists and restores focus after panel close", async () => {
  const [state, setState] = createStore({ tab: "changes" as "session" | "changes" })
  render(() => (
    <>
      <SessionMobileTabs tab={state.tab} onChange={(tab) => setState("tab", tab)} hasSession={false} reviewCount={0} />
      <Show when={rightPanel.mode() === "im"}>
        <button onClick={rightPanel.close}>Close panel</button>
      </Show>
    </>
  ))
  expect(screen.getAllByRole("tab")).toHaveLength(2)
  expect(screen.getByRole("tab", { name: dict["session.tab.session"] }).getAttribute("aria-selected")).toBe("true")
  fireEvent.click(screen.getByRole("tab", { name: dict["session.tab.im"] }))
  expect(rightPanel.mode()).toBe("im")
  screen.getByRole("button", { name: "Close panel" }).focus()
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: dict["session.tab.session"] })),
  )
})

it("leaves the changes tab through the same panel state and keeps changes keyboard selectable", async () => {
  const user = userEvent.setup()
  const [state, setState] = createStore({ tab: "changes" as "session" | "changes" })
  render(() => (
    <SessionMobileTabs tab={state.tab} onChange={(tab) => setState("tab", tab)} hasSession reviewCount={0} />
  ))
  await user.tab()
  await user.keyboard("{ArrowRight}")
  await waitFor(() => expect(rightPanel.mode()).toBe("im"))
  expect(state.tab).toBe("session")
  await user.keyboard("{ArrowLeft}")
  await waitFor(() => expect(state.tab).toBe("changes"))
  expect(rightPanel.mode()).toBeUndefined()
})

it("respects compact IM return composer focus and other usable controls while recovering lost panel focus", async () => {
  const [state, setState] = createStore({ tab: "session" as "session" | "changes" })
  render(() => (
    <>
      <SessionMobileTabs tab={state.tab} onChange={(tab) => setState("tab", tab)} hasSession reviewCount={0} />
      <div data-component="prompt-input" contenteditable="true" tabIndex={0} aria-label="Main request" />
      <button>Approval</button>
      <Show when={rightPanel.mode() === "im"}>
        <WorkPanelTabs
          compact
          tabs={[{ id: "im", kind: "im" }]}
          active="im"
          expanded={false}
          title={(view) => view.id}
          focus={vi.fn()}
          close={vi.fn()}
          home={vi.fn()}
          expand={vi.fn()}
          hide={rightPanel.close}
        />
      </Show>
    </>
  ))
  rightPanel.open("im")
  const returnMain = screen.getByRole("button", { name: dict["workPanel.returnMain"] })
  returnMain.focus()
  fireEvent.click(returnMain)
  await Promise.resolve()
  expect(rightPanel.mode()).toBeUndefined()
  expect(document.activeElement).toBe(screen.getByLabelText("Main request"))

  rightPanel.open("im")
  rightPanel.close()
  const approval = screen.getByRole("button", { name: "Approval" })
  approval.focus()
  await Promise.resolve()
  expect(document.activeElement).toBe(approval)

  rightPanel.open("im")
  screen.getByRole("button", { name: dict["workPanel.returnMain"] }).focus()
  rightPanel.close()
  await Promise.resolve()
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: dict["session.tab.session"] }))
})
