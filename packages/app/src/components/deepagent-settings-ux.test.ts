import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const here = import.meta.dir

describe("DeepAgent settings UX", () => {
  test("keeps agent mode, scenario mode, and intelligence model in the unified General settings", async () => {
    const v2 = await readFile(path.join(here, "settings-v2/general.tsx"), "utf8")

    expect(v2).toContain('data-action="settings-language"')
    expect(v2).toContain('data-action="settings-deepagent-mode"')
    expect(v2).toContain('data-action="settings-deepagent-prompt-mode"')
    expect(v2).toContain('data-action="settings-deepagent-intelligence-model"')
    expect(v2).toContain("settings.general.deepagent.prompt.direct")
    expect(v2).toContain("settings.general.deepagent.prompt.intelligence")
    expect(v2.indexOf('data-action="settings-language"')).toBeLessThan(
      v2.indexOf('data-action="settings-deepagent-mode"'),
    )
    expect(v2.indexOf('data-action="settings-deepagent-mode"')).toBeLessThan(
      v2.indexOf('data-action="settings-deepagent-prompt-mode"'),
    )
    expect(v2.indexOf('data-action="settings-deepagent-prompt-mode"')).toBeLessThan(
      v2.indexOf('data-action="settings-deepagent-intelligence-model"'),
    )
  })

  test("moves the permission approval control out of settings into the composer toolbar", async () => {
    const v2 = await readFile(path.join(here, "settings-v2/general.tsx"), "utf8")
    const composer = await readFile(path.join(here, "prompt-input.tsx"), "utf8")
    const control = await readFile(path.join(here, "deepagent/approval-control.tsx"), "utf8")

    // The auto-accept toggle no longer lives in settings…
    expect(v2).not.toContain('data-action="settings-auto-accept-permissions"')
    // …it is a composer control next to the agent selector, backed by directory-level auto-accept.
    expect(composer).toContain("ApprovalControl")
    expect(control).toContain('"data-action": "prompt-approval"')
    expect(control).toContain("toggleAutoAcceptDirectory")
    expect(control).toContain("composer.approval.request")
    expect(control).toContain("composer.approval.auto")
  })

  test("routes the legacy settings dialog import to the unified settings page", async () => {
    const source = await readFile(path.join(here, "dialog-settings.tsx"), "utf8")

    expect(source).toContain('export { DialogSettings } from "./settings-v2/dialog-settings-v2"')
  })

  test("keeps DeepAgent review, packs, and provider connect dialogs scroll-safe", async () => {
    const review = await readFile(path.join(here, "review/dialog-review.tsx"), "utf8")
    const packs = await readFile(path.join(here, "packs/dialog-packs.tsx"), "utf8")
    const connectProvider = await readFile(path.join(here, "dialog-connect-provider.tsx"), "utf8")
    const css = await readFile(path.join(here, "settings-v2/settings-v2.css"), "utf8")

    expect(review).toContain("settings-v2-tab-body deepagent-dialog-body")
    expect(review).toContain("deepagent-dialog-scroll")
    expect(packs).toContain("settings-v2-tab-body deepagent-dialog-body")
    expect(packs).toContain("deepagent-dialog-scroll")
    expect(connectProvider).toContain("overflow-y-auto")
    expect(css).toContain(".settings-v2-tab-body.deepagent-dialog-body")
    expect(css).toContain(".deepagent-dialog-scroll")
  })

  test("does not keep a separate DeepAgent provider dialog", async () => {
    await expect(readFile(path.join(here, "dialog-deepagent-provider.tsx"), "utf8")).rejects.toThrow()
  })
})
