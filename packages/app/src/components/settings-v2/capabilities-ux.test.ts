import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

// Keep route and endpoint wiring separate from the actual component disclosure/copy tests.
// Complete catalog, load-receipt and snapshot payloads must remain reachable in diagnostics.

const here = import.meta.dir

describe("C6-09 capabilities panel wiring", () => {
  test("the settings dialog retains the Capabilities navigation and existing panel", async () => {
    const dialog = await readFile(path.join(here, "dialog-settings-v2.tsx"), "utf8")

    expect(dialog).toContain('value="capabilities"')
    expect(dialog).toContain('icon: "package"')
    expect(dialog).toContain('label: "settings.capabilities.title"')
    expect(dialog).toContain("<SettingsCapabilitiesV2 />")
    expect(dialog).toContain('import { SettingsCapabilitiesV2 } from "./capabilities"')
  })

  test("the panel consumes the catalog, load receipts, and snapshot endpoints", async () => {
    const panel = await readFile(path.join(here, "capabilities.tsx"), "utf8")

    expect(panel).toContain("client.capability.catalog")
    expect(panel).toContain("client.capability.loadReceipts")
    expect(panel).toContain("client.systemContext.snapshot")
    // Every capability row label resolves through the i18n model (never a raw enum leak).
    expect(panel).toContain("catalogRows(props.catalog)")
    expect(panel).toContain("catalog: props.catalog")
    expect(panel).toContain("receipts: props.receipts")
    expect(panel).toContain("snapshot: props.snapshot")
  })

  test("the settings-v2 css carries the capability panel surface classes", async () => {
    const css = await readFile(path.join(here, "settings-v2.css"), "utf8")

    expect(css).toContain(".settings-v2-tab-body.settings-v2-capabilities")
    expect(css).toContain(".settings-v2-capabilities-status")
    expect(css).toContain(".settings-v2-capabilities-empty")
    expect(css).toContain(".settings-v2-capabilities-retry")
  })

  test("capability labels render via the panel view model (no duplicate mapping in JSX)", async () => {
    const model = await readFile(path.join(here, "capability-panel-model.ts"), "utf8")
    const panel = await readFile(path.join(here, "capabilities.tsx"), "utf8")

    // Availability → i18n key mapping lives in ONE place (the model).
    for (const key of [
      "integrated",
      "availability.maintenance_only",
      "availability.disabled",
      "availability.unavailable",
    ]) {
      expect(model).toContain(`settings.capabilities.${key}"`)
      expect(panel).not.toContain(`settings.capabilities.${key}"`)
    }
  })
})
