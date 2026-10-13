import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { DialogSettings } from "@/components/settings-v2/dialog-settings-v2"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ connected: (): boolean => false, show: vi.fn() }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web", version: "2.0.3" }) }))
vi.mock("@deepagent-code/ui/v2/dialog-v2", () => ({ Dialog: (props: { children: unknown }) => props.children }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: wiring.show, close() {} }) }))
vi.mock("@/context/sync", () => ({ useSync: () => ({ data: { get mcp() {
  return { "original-resource": { status: wiring.connected() ? "connected" : "disabled" } }
} } }) }))
vi.mock("@/context/sdk", () => ({ SDKProvider: (props: { children: unknown }) => props.children, useSDK: () => ({ directory: "/original", scope: "original", client: {} }) }))
vi.mock("@/context/mcp", () => ({
  useMcpRemove: () => ({ isPending: false, mutate() {} }),
  useMcpToggle: () => ({ isPending: false, mutate() {} }),
  useMcpRefresh: () => ({ isPending: false, mutate() {} }),
}))
vi.mock("@/components/settings-v2/general", () => ({ SettingsGeneralV2: () => <p>General panel</p> }))
vi.mock("@/components/settings-keybinds", () => ({ SettingsKeybinds: () => null }))
vi.mock("@/components/settings-v2/providers", () => ({ SettingsProvidersV2: () => null }))
vi.mock("@/components/settings-v2/models", () => ({ SettingsModelsV2: () => null }))
vi.mock("@/components/settings-v2/servers", () => ({ SettingsServersV2: () => null }))
vi.mock("@/components/settings-v2/about", () => ({ SettingsAboutV2: () => null }))
vi.mock("@/components/settings-v2/capabilities", () => ({ SettingsCapabilitiesV2: () => null }))
vi.mock("@/components/settings-v2/plugins", () => ({ SettingsPluginsV2: () => null }))
afterEach(() => { cleanup(); wiring.show.mockClear() })

it("Settings navigation opens the original MCP management and preserves its connected-only Apps gate", () => {
  const [state, setState] = createStore({ connected: false })
  wiring.connected = () => state.connected
  render(() => <DialogSettings mcp={{ directory: "/original", current: () => true }} />)
  fireEvent.click(screen.getByRole("tab", { name: dict["status.popover.tab.mcp"] }))
  expect(screen.getByRole("button", { name: dict["dialog.mcp.add"] })).toBeDefined()
  const apps = screen.getByRole("button", { name: dict["mcp.apps.title"] })
  expect(apps.hasAttribute("disabled")).toBe(true)
  fireEvent.click(apps)
  expect(wiring.show).not.toHaveBeenCalled()
  setState("connected", true)
  expect(apps.hasAttribute("disabled")).toBe(false)
  fireEvent.click(apps)
  expect(wiring.show).toHaveBeenCalledOnce()
})

it("global or retired project Settings cannot mount a guessed MCP scope", () => {
  const [state, setState] = createStore({ current: true })
  render(() => <DialogSettings mcp={{ directory: "/original", current: () => state.current }} />)
  fireEvent.click(screen.getByRole("tab", { name: dict["status.popover.tab.mcp"] }))
  expect(screen.getByRole("button", { name: dict["dialog.mcp.add"] })).toBeDefined()
  setState("current", false)
  expect(screen.queryByRole("button", { name: dict["dialog.mcp.add"] })).toBeNull()
  expect(screen.getByText(dict["settings.mcp.selectProject"])).toBeDefined()
  cleanup()
  render(() => <DialogSettings />)
  fireEvent.click(screen.getByRole("tab", { name: dict["status.popover.tab.mcp"] }))
  expect(screen.getByText(dict["settings.mcp.selectProject"])).toBeDefined()
  expect(screen.queryByRole("button", { name: dict["dialog.mcp.add"] })).toBeNull()
})
