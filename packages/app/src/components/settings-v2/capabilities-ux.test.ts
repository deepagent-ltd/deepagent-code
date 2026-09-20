import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

// C6-09 route-contract check (repo pattern: source-level wiring assertions — the repo has no
// component-render unit harness, so the panel's DOM behavior is covered by the model fixture
// tests + this wiring contract). Asserts: the settings dialog registers the capabilities tab,
// the panel consumes exactly the three endpoints, and every label resolves through i18n.
// The row/receipt/empty derivations themselves are fixture-tested in
// capability-panel-model.test.ts.

const here = import.meta.dir

describe("C6-09 capabilities panel wiring", () => {
  test("the settings dialog registers the Capabilities tab under Server", async () => {
    const dialog = await readFile(path.join(here, "dialog-settings-v2.tsx"), "utf8")

    expect(dialog).toContain('value="capabilities"')
    expect(dialog).toContain('Icon name="package"')
    expect(dialog).toContain('language.t("settings.capabilities.title")')
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
    expect(panel).toContain("receiptRows(props.receipts)")
    expect(panel).toContain("snapshotRow(props.snapshot)")
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
    for (const key of ["availability.stable", "availability.maintenance_only", "availability.disabled", "availability.unavailable"]) {
      expect(model).toContain(`settings.capabilities.${key}"`)
      expect(panel).not.toContain(`settings.capabilities.${key}"`)
    }
  })

  test("the snapshot row templates resolve their params (no literal {{digest}}/{{count}})", async () => {
    const panel = await readFile(path.join(here, "capabilities.tsx"), "utf8")

    // W9.5 — the local `t` wrapper passes params through to `language.t` (resolveTemplate);
    // otherwise the snapshot row renders the raw `{{digest}}`/`{{count}}` placeholders.
    const t = panel.match(/const t = \([^)]*\) =>[^\n]*/)
    expect(t).not.toBeNull()
    expect(t![0]).toContain("params")
    expect(panel).toContain('settings.capabilities.digest", { digest: row().catalogDigest }')
    expect(panel).toContain('settings.capabilities.l0lineCount", { count: row().l0LineCount }')
  })
})
