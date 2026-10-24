import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { SettingsMetadata } from "@/components/settings-v2/metadata"
import { SettingsAboutV2 } from "@/components/settings-v2/about"
import { SettingsPluginsV2 } from "@/components/settings-v2/plugins"
import { CapabilitiesView } from "@/components/settings-v2/capabilities"
import type { CapabilityCatalog } from "@deepagent-code/sdk/client"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ openLink: vi.fn(), plugins: [] as string[] }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ version: "2.0.5", openLink: wiring.openLink }) }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => ({ data: { config: { plugin: wiring.plugins } } }) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({}) }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it("keeps complete metadata collapsed and copies the exact original value", async () => {
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  const value = "C:\\workspace\\a-very-long-path\nsha256:" + "a".repeat(64)
  render(() => <SettingsMetadata title="Metadata" value={value} />)
  const details = screen.getByText("Metadata").closest("details")!
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByText("Metadata"))
  expect(details.open).toBe(true)
  expect(details.querySelector("pre")?.textContent).toBe(value)
  fireEvent.click(screen.getByRole("button", { name: dict["settings.metadata.copy"] }))
  await screen.findByText(dict["settings.metadata.copied"])
  expect(writeText).toHaveBeenCalledExactlyOnceWith(value)
})

it("reports clipboard failure while retaining selectable complete metadata", async () => {
  vi.stubGlobal("navigator", {})
  render(() => <SettingsMetadata title="Metadata" value="complete original identifier" />)
  fireEvent.click(screen.getByText("Metadata"))
  fireEvent.click(screen.getByRole("button", { name: dict["settings.metadata.copy"] }))
  await screen.findByRole("alert")
  expect(screen.getByText("complete original identifier").getAttribute("tabindex")).toBe("0")
})

it("uses authoritative license bytes and distinguishes product links from OpenCode attribution", async () => {
  render(() => <SettingsAboutV2 />)
  const licenses = document.querySelectorAll<HTMLDetailsElement>('[data-component="settings-product-licenses"] details')
  expect(licenses).toHaveLength(2)
  expect([...licenses].every((details) => !details.open)).toBe(true)
  expect(licenses[0].querySelector("pre")?.textContent).toBe(
    await readFile(path.resolve(process.cwd(), "../../LICENSE"), "utf8"),
  )
  expect(licenses[1].querySelector("pre")?.textContent).toBe(
    await readFile(path.resolve(process.cwd(), "../../NOTICE"), "utf8"),
  )
  fireEvent.click(screen.getByRole("link", { name: "OpenCode" }))
  expect(wiring.openLink).toHaveBeenLastCalledWith("https://github.com/anomalyco/opencode")
  fireEvent.click(screen.getByRole("link", { name: dict["settings.about.source"] }))
  expect(wiring.openLink).toHaveBeenLastCalledWith("https://github.com/deepagent-ltd/deepagent-code")
  expect(screen.getByRole("heading", { name: dict["settings.tab.about"] })).toBeTruthy()
})

it("shows configured plugins without inventing loading health and preserves complete IDs", () => {
  wiring.plugins = ["file:///workspace/" + "plugin".repeat(40) + ".ts"]
  render(() => <SettingsPluginsV2 />)
  expect(screen.getByText(dict["settings.plugins.configured"])).toBeTruthy()
  expect(document.querySelector(".bg-icon-success-base")).toBeNull()
  const details = screen.getByText(dict["settings.plugins.identifier"]).closest("details")!
  expect(details.open).toBe(false)
  expect(details.querySelector("pre")?.textContent).toBe(wiring.plugins[0])
})

it("shows a human capability overview while preserving every diagnostic field behind one disclosure", async () => {
  const catalog = {
    schemaVersion: "capability-catalog.v1",
    id: "catalog-original",
    digest: "digest-original",
    capabilities: [
      {
        id: "deepagent.code-read",
        version: "1.0.0-beta.0",
        summary: "Read and search source files",
        use_when: ["search"],
        availability: "stable",
        required_permissions: ["read"],
        required_runtime_features: [],
        entry_tools: ["read", "grep"],
        body_ref: "capability://original",
        max_body_tokens: 2000,
      },
    ],
  } satisfies CapabilityCatalog
  const receipts = { count: 0, receipts: [] }
  render(() => (
    <CapabilitiesView
      catalog={catalog}
      receipts={receipts}
      onRetry={vi.fn()}
      t={(key) => dict[key as keyof typeof dict] ?? key}
    />
  ))
  expect(screen.getByText(dict["settings.capabilities.name.deepagent.code-read"])).toBeTruthy()
  expect(screen.getByText(dict["settings.capabilities.integrated"])).toBeTruthy()
  const details = screen.getByText(dict["settings.capabilities.diagnostics"]).closest("details")!
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByText(dict["settings.capabilities.diagnostics"]))
  expect(JSON.parse(details.querySelector("pre")!.textContent!)).toMatchObject({ catalog, receipts, snapshot: null })
  await waitFor(() => expect(details.open).toBe(true))
})
