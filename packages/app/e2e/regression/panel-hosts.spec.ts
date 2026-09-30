import { expect, test } from "@playwright/test"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/DeepAgent Code/PanelRegression"
const projectID = "proj_panel_regression"
const sessionID = "ses_panel_regression"

async function openSession(page: import("@playwright/test").Page) {
  let diagnosticsRequests = 0
  await mockDeepAgentCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "panel-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "deepagent-code",
          name: "DeepAgent Code",
          models: { model: { id: "model", name: "Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["deepagent-code"],
      default: { providerID: "deepagent-code", modelID: "model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "panel-regression",
        projectID,
        directory,
        title: "Panel regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/lsp/diagnostics**", async (route) => {
    diagnosticsRequests++
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        "C:/DeepAgent Code/PanelRegression/src/app.ts": [
          {
            message: "Type mismatch",
            severity: 1,
            source: "ts",
            code: 2322,
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
          },
        ],
        "C:/DeepAgent Code/PanelRegression/src/index.ts": [
          {
            message: "Unused value",
            severity: 2,
            source: "eslint",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
          },
        ],
      }),
    })
  })
  await page.addInitScript(() =>
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } })),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("button", { name: "Toggle bottom panel" }))
  return { diagnosticsRequests: () => diagnosticsRequests }
}

async function expectTerminalPaneInHost(page: import("@playwright/test").Page, host: "bottom" | "side") {
  const target = page.locator(`[data-terminal-host="${host}"]`)
  await expect(target).toBeVisible()
  await expect(target.locator("[data-terminal-pane]")).toHaveCount(1)
}

test("Bottom terminal and right-rail views respond to clicks on desktop and mobile", async ({ page }) => {
  const runtime = await openSession(page)
  const bottomToggle = page.getByRole("button", { name: "Toggle bottom panel" })
  const rightToggle = page.getByRole("button", { name: "Toggle right sidebar" })
  const bottom = page.locator("#bottom-panel")
  const side = page.locator("#review-panel")

  await bottomToggle.click()
  await expect(bottom).toBeVisible()
  await expectTerminalPaneInHost(page, "bottom")
  await expect(bottom.getByLabel("New terminal")).toBeVisible()
  await expect(bottom.getByLabel("Split terminal")).toBeVisible()

  const problems = side.getByRole("tab", { name: "Problems", exact: true })
  await problems.click()
  await expect(problems).toHaveAttribute("aria-selected", "true")
  await expect.poll(runtime.diagnosticsRequests).toBeGreaterThan(0)
  await expect(side.getByText("Type mismatch")).toBeVisible()
  await expect(side.getByText("Unused value")).toBeVisible()
  await expectTerminalPaneInHost(page, "bottom")

  await side.getByText("Type mismatch").click()
  await expect(page.getByText("app.ts").first()).toBeVisible()

  const debugConsole = side.getByRole("tab", { name: "Debug Console", exact: true })
  await debugConsole.click()
  await expect(debugConsole).toHaveAttribute("aria-selected", "true")
  await problems.click()
  await expect(problems).toHaveAttribute("aria-selected", "true")

  await rightToggle.click()
  await expect(problems).toHaveAttribute("aria-selected", "false")
  await expect(side.getByText("Type mismatch")).toBeHidden()
  await bottomToggle.click()
  await expect(bottom).toBeHidden()

  await page.setViewportSize({ width: 767, height: 900 })
  await expect(side).toHaveCount(0)
  await expect(bottomToggle).toBeVisible()
  await bottomToggle.click()
  await expect(bottom).toBeVisible()
  await expectTerminalPaneInHost(page, "bottom")
})

test("Terminal keeps one visible host and supports tabs plus atomic splits", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1000 })
  await openSession(page)
  const bottomToggle = page.getByRole("button", { name: "Toggle bottom panel" })
  await bottomToggle.click()
  const bottom = page.locator("#bottom-panel")
  await expectTerminalPaneInHost(page, "bottom")
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(1)

  const pane = bottom.locator("[data-terminal-pane]")
  await expect(pane.getByRole("tab")).toHaveCount(1)
  await bottom.getByLabel("New terminal").click()
  await expect(pane.getByRole("tab")).toHaveCount(2)
  await expect(bottom.locator('[data-terminal-pty-id="pty_test_2"]')).toBeVisible()
  await pane.getByRole("tab", { name: "Terminal 1" }).click()
  await expect(bottom.locator('[data-terminal-pty-id="pty_test_1"]')).toBeVisible()
  await pane.getByRole("tab", { name: "Terminal 2" }).click()
  await expect(bottom.locator('[data-terminal-pty-id="pty_test_2"]')).toBeVisible()

  const split = bottom.getByLabel("Split terminal")
  await expect(split).toBeEnabled()
  await split.click()
  const panes = bottom.locator("[data-terminal-pane]")
  await expect(panes).toHaveCount(2)
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(2)
  await expect(panes.nth(0).getByRole("tab")).toHaveCount(2)
  await expect(panes.nth(1).getByRole("tab")).toHaveCount(1)
  await expect(bottom.locator("[data-terminal-pane] [role=tab]")).toHaveCount(3)

  await expect(split).toBeEnabled()
  await split.click()
  await expect(panes).toHaveCount(3)
  await expect(panes.nth(0).getByRole("tab")).toHaveCount(2)
  await expect(panes.nth(1).getByRole("tab")).toHaveCount(1)
  await expect(panes.nth(2).getByRole("tab")).toHaveCount(1)
  await expect(bottom.locator("[data-terminal-pane] [role=tab]")).toHaveCount(4)

  await expect(split).toBeEnabled()
  await split.click()
  await expect(panes).toHaveCount(4)
  await expect(bottom.locator("[data-terminal-pane] [role=tab]")).toHaveCount(5)
  for (const index of [0, 1, 2, 3]) {
    await expect(panes.nth(index)).toBeVisible()
    await expect(panes.nth(index).getByRole("tab").last()).toBeVisible()
    await expect.poll(async () => (await panes.nth(index).boundingBox())?.height ?? 0).toBeGreaterThan(100)
  }
  const widths = await panes.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width))
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(8)

  await bottomToggle.click()
  await expect(bottom).toBeHidden()
  await bottomToggle.click()
  await expect(bottom).toBeVisible()
  await expect(page.locator('[data-terminal-host="bottom"] [data-terminal-pane]')).toHaveCount(4)
  await expect(page.locator('[data-terminal-host="side"]')).toHaveCount(0)
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(4)
})
