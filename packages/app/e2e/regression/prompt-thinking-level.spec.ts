import { expect, test } from "@playwright/test"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/DeepAgent Code/PromptThinkingLevelRegression"
const projectID = "proj_prompt_thinking_level_regression"
const sessionID = "ses_prompt_thinking_level_regression"

test("shows the V2 thinking level control while relevant", async ({ page }) => {
  let submitted: unknown
  await mockDeepAgentCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-thinking-level-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "deepagent-code",
          name: "DeepAgent Code",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["deepagent-code"],
      default: { providerID: "deepagent-code", modelID: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-thinking-level-regression",
        projectID,
        directory,
        title: "Prompt thinking level regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/session/*/prompt", async (route) => {
    const body = route.request().postDataJSON() as { id?: string; prompt: unknown }
    submitted = body
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          admittedSeq: 1,
          id: body.id ?? "msg_prompt_thinking_level_regression",
          sessionID,
          prompt: body.prompt,
          delivery: "steer",
          timeCreated: Date.now(),
        },
      }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-prompt-dock"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const control = composer.locator('[data-component="prompt-variant-control"]')
  await expectAppVisible(composer)

  await expect(control).toBeVisible()

  await control.locator('[data-action="prompt-model-variant"]').click()
  const high = page.getByRole("option", { name: "high" })
  await expect(high).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toBeVisible()
  await expect(high).toBeVisible()
  await high.click()

  await input.focus()
  await expect(control).toBeVisible()

  await input.press("!")
  await expect(control).toHaveCount(0)
  await input.press("Backspace")
  await expect(control).toBeVisible()

  const diagnostics = page.getByRole("button", { name: "Development performance diagnostics" })
  await expect(diagnostics).toHaveAttribute("aria-expanded", "false")
  await diagnostics.click()
  await expect(diagnostics).toHaveAttribute("aria-expanded", "true")
  await diagnostics.click()
  await expect(diagnostics).toHaveAttribute("aria-expanded", "false")

  await page.getByRole("radio", { name: "Send your prompt directly" }).click()
  await input.focus()
  await input.press("ControlOrMeta+A")
  await input.press("Backspace")
  await page.keyboard.type("GUI V2 parity smoke")
  await expect(input).toContainText("GUI V2 parity smoke")
  await composer.locator('[data-action="prompt-submit"]').click()
  await expect.poll(() => submitted).not.toBeUndefined()
  expect(submitted).toMatchObject({
    prompt: {
      text: "GUI V2 parity smoke",
      model: { providerID: "deepagent-code", id: "thinking-model", variant: "high" },
      intent: { source: "composer" },
    },
  })
})
