import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const here = import.meta.dir

describe("DeepAgent settings UX", () => {
  test("keeps agent mode, scenario mode, and wish model in the unified General settings", async () => {
    const v2 = await readFile(path.join(here, "settings-v2/general.tsx"), "utf8")

    expect(v2).toContain('data-action="settings-language"')
    expect(v2).toContain('data-action="settings-deepagent-mode"')
    expect(v2).toContain('data-action="settings-deepagent-prompt-mode"')
    expect(v2).toContain('data-action="settings-deepagent-wish-model"')
    expect(v2).toContain('settings.general.deepagent.prompt.direct')
    expect(v2).toContain('settings.general.deepagent.prompt.wish')
    expect(v2.indexOf('data-action="settings-language"')).toBeLessThan(
      v2.indexOf('data-action="settings-deepagent-mode"'),
    )
    expect(v2.indexOf('data-action="settings-deepagent-mode"')).toBeLessThan(
      v2.indexOf('data-action="settings-deepagent-prompt-mode"'),
    )
    expect(v2.indexOf('data-action="settings-deepagent-prompt-mode"')).toBeLessThan(
      v2.indexOf('data-action="settings-deepagent-wish-model"'),
    )
    expect(v2.indexOf('data-action="settings-deepagent-wish-model"')).toBeLessThan(
      v2.indexOf('data-action="settings-auto-accept-permissions"'),
    )
  })

  test("routes the legacy settings dialog import to the unified settings page", async () => {
    const source = await readFile(path.join(here, "dialog-settings.tsx"), "utf8")

    expect(source).toContain('export { DialogSettings } from "./settings-v2/dialog-settings-v2"')
  })

  test("does not keep a separate DeepAgent provider dialog", async () => {
    await expect(readFile(path.join(here, "dialog-deepagent-provider.tsx"), "utf8")).rejects.toThrow()
  })
})
