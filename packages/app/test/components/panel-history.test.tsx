import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { PanelButton } from "@/components/deepagent/panel-button"
import { dict } from "@/i18n/en"
const wiring = vi.hoisted(() => ({ client: {} as object }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ client: wiring.client, scope: "local", url: "http://local", directory: "/project" }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)
it("an armed historical panel offers only disarming and keeps its history explanation", async () => {
  const request = vi.fn(async (input: { method: string; body?: { sessionID: string; armed: boolean } }) => ({
    data:
      input.method === "GET"
        ? { armed: true, explicit: true, rounds: "single" }
        : { sessionID: "session-history", armed: false, rounds: "single" },
  }))
  wiring.client = { client: { request } }
  render(() => <PanelButton sessionID="session-history" />)
  fireEvent.click(await screen.findByRole("button", { name: dict["composer.panel.disarmHistory"] }))
  await waitFor(() => expect(screen.queryByRole("button", { name: dict["composer.panel.disarmHistory"] })).toBeNull())
  expect(screen.getByText(dict["composer.panel.history"])).toBeTruthy()
  const writes = request.mock.calls.map(([input]) => input).filter((input) => input.method === "POST")
  expect(writes).toHaveLength(1)
  expect(writes[0].body).toEqual({ sessionID: "session-history", armed: false })
})
it("a fresh unarmed conversation exposes no expert-panel selector", async () => {
  const request = vi.fn(async () => ({ data: { armed: false, explicit: false, rounds: "single" } }))
  wiring.client = { client: { request } }
  render(() => <PanelButton sessionID="session-new" />)
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole("button")).toBeNull()
  expect(screen.queryByText(dict["composer.panel.history"])).toBeNull()
})
