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

test("Bottom Panel, movable views, Problems, and mobile reachability", async ({ page }) => {
  const runtime = await openSession(page)

  const bottomToggle = page.getByRole("button", { name: "Toggle bottom panel" })
  await bottomToggle.click()
  const bottom = page.locator("#bottom-panel")
  await expect(bottom).toBeVisible()
  await expect(bottom.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible()
  await bottom.getByRole("tab", { name: "Terminal", exact: true }).click()
  await expect(bottom.getByLabel("New terminal")).toBeVisible()
  await expect(bottom.getByLabel("Split terminal")).toBeVisible()
  await expectTerminalPaneInHost(page, "bottom")
  await page.screenshot({ path: "e2e/test-results/panel-terminal-actions.png", fullPage: true })

  await bottom.getByRole("tab", { name: "Problems", exact: true }).click()
  await expect.poll(runtime.diagnosticsRequests).toBeGreaterThan(0)
  await expect(bottom.getByText("Type mismatch")).toBeVisible()
  await expect(bottom.getByText("Unused value")).toBeVisible()
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(0)
  await page.screenshot({ path: "e2e/test-results/panel-bottom-problems.png", fullPage: true })

  await bottom.getByRole("button", { name: "Move to Right Sidebar" }).click()
  await expect(bottom.getByText("Type mismatch")).toBeHidden()
  const side = page.locator("#review-panel")
  await expect(side.getByText("Type mismatch")).toBeVisible()
  await side.getByRole("button", { name: "Move to bottom dock" }).click()
  await expect(bottom.getByText("Type mismatch")).toBeVisible()
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(0)

  await bottomToggle.click()
  await expect(bottom).toBeHidden()
  await page.getByRole("button", { name: "Panel Views" }).click()
  const panelViewsMenu = page.locator("[data-panel-views-menu]")
  await expect(panelViewsMenu.getByText("Panel Views", { exact: true })).toBeVisible()
  await expect(panelViewsMenu.getByText("Terminal", { exact: true })).toBeVisible()
  await expect(panelViewsMenu.getByText("Debug Console", { exact: true })).toBeVisible()
  await expect(panelViewsMenu.getByText("Problems", { exact: true })).toBeVisible()
  await expect(panelViewsMenu.getByRole("button", { name: "Problems Bottom Panel" })).toBeVisible()
  await panelViewsMenu.screenshot({ path: "e2e/test-results/panel-views-menu.png" })
  await page.getByRole("button", { name: "Problems Bottom Panel" }).click()
  await expect(bottom.getByText("Type mismatch")).toBeVisible()

  await page.getByRole("button", { name: "Panel Views" }).click()
  await page.getByRole("button", { name: "Move to Right Sidebar: Problems" }).click()
  await expect(side.getByText("Type mismatch")).toBeVisible()
  await page.getByRole("button", { name: "Panel Views" }).click()
  await page.getByRole("button", { name: "Move to Bottom Panel: Problems" }).click()
  await expect(bottom.getByText("Type mismatch")).toBeVisible()

  await bottom.getByText("Type mismatch").click()
  await expect(page.getByText("app.ts").first()).toBeVisible()

  for (const view of ["Debug Console", "Terminal"]) {
    await bottom.getByRole("tab", { name: view, exact: true }).click()
    await bottom.getByRole("button", { name: "Move to Right Sidebar" }).click()
    await expect(side.getByText(view).first()).toBeVisible()
    if (view === "Terminal") {
      await expectTerminalPaneInHost(page, "side")
      const actionBoxes = await Promise.all(
        [
          side.getByLabel("Split terminal"),
          side.getByLabel("New terminal"),
          side.getByLabel("Move to bottom dock"),
          side.getByRole("button", { name: "Close", exact: true }),
        ].map(async (control) => {
          await expect(control).toBeVisible()
          return control.boundingBox()
        }),
      )
      const boxes = actionBoxes.filter((box): box is NonNullable<typeof box> => box !== null)
      expect(boxes).toHaveLength(4)
      expect(boxes.every((box) => Math.abs(box.y - boxes[0].y) <= 1)).toBe(true)
      expect(boxes.every((box, index) => index === 0 || box.x > boxes[index - 1].x)).toBe(true)
      await side.screenshot({ path: "e2e/test-results/panel-side-terminal-toolbar.png" })
    }
    await side.getByRole("button", { name: "Move to bottom dock" }).click()
    await expect(bottom.getByRole("tab", { name: view, exact: true })).toBeVisible()
    if (view === "Terminal") {
      await bottom.getByRole("tab", { name: "Terminal", exact: true }).click()
      await expectTerminalPaneInHost(page, "bottom")
    }
  }

  await bottom.getByRole("tab", { name: "Problems", exact: true }).click()
  for (const view of ["Terminal", "Debug Console", "Problems"]) {
    await page.getByRole("button", { name: "Panel Views" }).click()
    await page.getByRole("button", { name: `Move to Right Sidebar: ${view}` }).click()
  }
  const unavailableBottomToggle = page.getByRole("button", { name: "Move a Panel View to the Bottom Panel first." })
  await expect(unavailableBottomToggle).toBeDisabled()
  await expect(bottom).toHaveCSS("height", "0px")
  await page.getByRole("button", { name: "Panel Views" }).click()
  await page.getByRole("button", { name: "Move to Bottom Panel: Problems" }).click()
  await expect(bottom.getByText("Type mismatch")).toBeVisible()

  await page.setViewportSize({ width: 767, height: 900 })
  await expect(page.locator("#review-panel")).toHaveCount(0)
  await expect(bottom.getByRole("button", { name: "Move to Right Sidebar" })).toHaveCount(0)
  await page.getByRole("button", { name: "Panel Views" }).click()
  await expect(
    page.locator("[data-panel-views-menu]").getByRole("button", { name: /Move to Right Sidebar/ }),
  ).toHaveCount(0)
  await page.screenshot({ path: "e2e/test-results/panel-mobile.png", fullPage: true })
})

test("Terminal keeps one visible host and supports tabs plus atomic splits", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1000 })
  await openSession(page)
  await page.getByRole("button", { name: "Toggle bottom panel" }).click()
  const bottom = page.locator("#bottom-panel")
  await bottom.getByRole("tab", { name: "Terminal", exact: true }).click()
  await expectTerminalPaneInHost(page, "bottom")
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(1)

  const pane = bottom.locator("[data-terminal-pane]")
  await expect(pane.getByRole("tab")).toHaveCount(1)
  await bottom.getByLabel("New terminal").click()
  await expect(pane.getByRole("tab")).toHaveCount(2)

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
  for (const index of [0, 1, 2]) {
    await expect(panes.nth(index)).toBeVisible()
    await expect(panes.nth(index).getByRole("tab").last()).toBeVisible()
    await expect.poll(async () => (await panes.nth(index).boundingBox())?.height ?? 0).toBeGreaterThan(100)
  }

  await bottom.getByRole("tab", { name: "Problems", exact: true }).click()
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(0)
  await bottom.getByRole("tab", { name: "Terminal", exact: true }).click()
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(3)

  await bottom.getByRole("button", { name: "Move to Right Sidebar" }).click()
  await expect(page.locator('[data-terminal-host="bottom"]')).toHaveCount(0)
  await expect(page.locator('[data-terminal-host="side"] [data-terminal-pane]')).toHaveCount(3)
  await expect(page.locator("[data-terminal-pane]")).toHaveCount(3)
})
