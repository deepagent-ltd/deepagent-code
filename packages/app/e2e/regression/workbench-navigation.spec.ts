import { expect, test } from "@playwright/test"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/DeepAgent Code/WorkbenchNavigation"
const sessionID = "ses_workbench_navigation"

test("left rail opens settings and Library knowledge, history, and archived sessions", async ({ page }) => {
  await mockDeepAgentCodeServer(page, {
    directory,
    project: {
      id: "proj_workbench_navigation",
      worktree: directory,
      vcs: "git",
      name: "workbench-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "workbench-navigation",
        projectID: "proj_workbench_navigation",
        directory,
        title: "Workbench navigation",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() =>
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } })),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("button", { name: "Settings", exact: true }))

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.locator(".settings-v2-dialog")).toBeVisible()
  await page.getByRole("tab", { name: "Providers" }).click()
  await expect(page.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Library", exact: true }).click()
  const library = page.getByRole("dialog", { name: "Library", exact: true })
  await expect(library).toBeVisible()
  await expect(library.getByRole("tab", { name: "Knowledge", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(library.getByRole("tab", { name: "Review", exact: true })).toBeVisible()
  await library.getByRole("tab", { name: "Domain Packs", exact: true }).click()
  await expect(library.getByRole("tab", { name: "Domain Packs", exact: true })).toHaveAttribute("aria-selected", "true")

  await library.getByRole("tab", { name: "History projects", exact: true }).click()
  await expect(library.getByRole("tab", { name: "History projects", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.locator('[data-component="history-projects-dialog"]')).toBeVisible()

  await library.getByRole("tab", { name: "Archived sessions", exact: true }).click()
  await expect(library.getByRole("tab", { name: "Archived sessions", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.locator('[data-component="archived-sessions-dialog"]')).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(library).toBeHidden()
})
