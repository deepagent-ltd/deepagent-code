import { chromium, expect, test } from "@playwright/test"
import { createHash } from "node:crypto"
import { mkdir, open, writeFile } from "node:fs/promises"
import path from "node:path"

test.skip(!process.env.DAC_GUI_IM_CDP_URL, "Requires the explicitly prepared private Desktop; no automatic environment is created")

test("real incoming IM proposal → explicit accept → original streaming Session → result card", async () => {
  const endpoint = process.env.DAC_GUI_IM_CDP_URL
  const source = process.env.DAC_GUI_IM_SOURCE_TEXT
  const output = process.env.DAC_GUI_IM_OUTPUT_DIR
  if (!endpoint || !source || !output) throw new Error("Explicit private Desktop CDP URL, original incoming text and output directory are required")
  const { dict } = await (process.env.DAC_GUI_IM_LANGUAGE === "zh" ? import("../../src/i18n/zh") : import("../../src/i18n/en"))
  const labels = dict
  await mkdir(output, { recursive: true, mode: 0o700 })
  const guard = await open(path.join(output, "ui-driver-once.guard"), "wx", 0o600)
  await guard.close()
  const browser = await chromium.connectOverCDP(endpoint)
  const observation = { version: 1, originalActionsOnly: true, connectedExistingDesktop: true,
    directProviderHTTPCalls: 0, sqlWrites: 0, accepted: false, opened: false, returned: false, finalCard: false,
    distinctVisibleAssistantFrames: 0, lastVisibleAssistantBytes: 0, lastVisibleAssistantSHA256: "", passed: false }
  try {
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.url().startsWith("devtools:"))
    const page = pages.find((page) => page.url().includes("/session/"))
    if (!page) throw new Error("Original Desktop Session page is required; the driver does not create a Session")
    const before = page.url()
    const message = page.locator("[data-im-message-item]").filter({ hasText: source })
    await expect(message).toHaveCount(1)
    await message.locator(".im-task-proposal-action").click()
    const proposal = page.getByRole("dialog")
    const audited = proposal.getByRole("textbox", { name: labels["im.taskProposal.auditedText"] })
    await expect(audited).toBeVisible()
    if (process.env.DAC_GUI_IM_AUDITED_TEXT) await audited.fill(process.env.DAC_GUI_IM_AUDITED_TEXT)
    await proposal.getByRole("button", { name: labels["im.taskProposal.propose"], exact: true }).click()
    await proposal.getByRole("checkbox", { name: labels["im.taskProposal.confirm"], exact: true }).check()
    await proposal.getByRole("button", { name: labels["im.taskProposal.accept"], exact: true }).click()
    await expect(proposal.getByText(labels["im.taskProposal.accepted"], { exact: true })).toBeVisible()
    observation.accepted = true
    await proposal.getByRole("button", { name: labels["im.taskResult.open"], exact: true }).click()
    await expect(page).not.toHaveURL(before)
    observation.opened = true
    const assistant = page.locator('[data-slot="session-turn-assistant-content"] [data-slot="text-part-body"]')
    const frames = new Set<string>()
    await expect.poll(async () => {
      const text = (await assistant.allTextContents()).join("\n").trim()
      if (text) {
        frames.add(createHash("sha256").update(text).digest("hex"))
        observation.distinctVisibleAssistantFrames = frames.size
        observation.lastVisibleAssistantBytes = Buffer.byteLength(text)
        observation.lastVisibleAssistantSHA256 = createHash("sha256").update(text).digest("hex")
      }
      return frames.size
    }, { timeout: 90_000, intervals: [100, 150, 250] }).toBeGreaterThanOrEqual(2)
    await page.screenshot({ path: path.join(output, "actual-original-session-stream.png") })
    await page.getByRole("button", { name: labels["im.taskResult.return"], exact: true }).click()
    await expect(page).toHaveURL(before)
    observation.returned = true
    const cards = page.locator("[data-im-task-result-card]")
    await expect(cards.last()).toBeVisible({ timeout: 60_000 })
    observation.finalCard = true
    await cards.last().getByRole("button", { name: labels["im.taskResult.view"], exact: true }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("button", { name: labels["im.taskResult.open"], exact: true })).toBeEnabled()
    await page.screenshot({ path: path.join(output, "actual-im-result-card.png") })
    observation.passed = true
  } finally {
    await writeFile(path.join(output, "ui-driver-safe.json"), JSON.stringify(observation, null, 2) + "\n", { mode: 0o600 })
    await browser.close()
  }
})
