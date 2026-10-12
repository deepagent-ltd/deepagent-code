import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { DialogSettings } from "@/components/settings-v2/dialog-settings-v2"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web", version: "2.0.3" }) }))
vi.mock("@deepagent-code/ui/v2/dialog-v2", () => ({ Dialog: (props: { children: unknown }) => props.children }))
vi.mock("@/components/settings-v2/general", () => ({ SettingsGeneralV2: () => <p>General panel</p> }))
vi.mock("@/components/settings-keybinds", () => ({ SettingsKeybinds: () => null }))
vi.mock("@/components/settings-v2/providers", () => ({ SettingsProvidersV2: () => null }))
vi.mock("@/components/settings-v2/models", () => ({ SettingsModelsV2: () => null }))
vi.mock("@/components/settings-v2/servers", () => ({ SettingsServersV2: () => null }))
vi.mock("@/components/settings-v2/about", () => ({ SettingsAboutV2: () => null }))
vi.mock("@/components/settings-v2/capabilities", () => ({ SettingsCapabilitiesV2: () => null }))
vi.mock("@/components/settings-v2/plugins", () => ({ SettingsPluginsV2: () => null }))
vi.mock("@/components/settings-v2/im", () => ({ SettingsIMV2: () => <p>Explicit IM settings panel</p> }))
afterEach(cleanup)

it("the server settings navigation has one separate IM settings entry", () => {
  render(() => <DialogSettings />)
  expect(screen.getByText("General panel")).toBeTruthy()
  fireEvent.click(screen.getByRole("tab", { name: dict["settings.im.title"] }))
  expect(screen.getByText("Explicit IM settings panel")).toBeTruthy()
})

it("an activation entry can open the existing settings dialog directly to its IM tab", () => {
  render(() => <DialogSettings initialTab="im" />)
  expect(screen.getByText("Explicit IM settings panel")).toBeTruthy()
  expect(screen.queryByText("General panel")).toBeNull()
})
