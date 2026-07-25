import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/DeepAgent Code/SubagentPanel"
const projectID = "proj_subagent_panel"
const parentID = "ses_subagent_parent"
const slug = base64Encode(directory)
const sessionKey = `local\u0000${slug}/${parentID}`

const parent = {
  id: parentID,
  slug: "subagent-parent",
  projectID,
  directory,
  title: "Subagent parent",
  version: "dev",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}

const child = (id: string, title: string, updated: number, state: string, reason: string) => ({
  id,
  slug: id,
  projectID,
  directory,
  parentID,
  title,
  version: "dev",
  metadata: {
    deepagent: {
      subagent: { finished: state !== "researching", state, reason, run_id: `run_${id}`, generation: 1 },
    },
  },
  time: { created: updated - 1, updated },
})

async function openPersistedPanel(page: Page, children: ReturnType<typeof child>[], mode = "subagents") {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  await mockDeepAgentCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "subagent-panel",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
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
    sessions: [parent, ...children],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "deepagent.global.dat:layout",
        JSON.stringify({ sessionView: { [key]: { scroll: {}, rightPanelMode: value } } }),
      )
    },
    { key: sessionKey, value: mode },
  )
  await page.goto(`/${slug}/session/${parentID}`)
  await expectAppVisible(page.getByRole("tab", { name: "Subagents" }))
  return { pageErrors, consoleErrors }
}

test("persisted subagent panel renders many terminal states and keeps row actions independent", async ({ page }) => {
  const children = [
    child("ses_child_error", "Failed researcher", 104, "error", "provider_error"),
    child("ses_child_cancelled", "Cancelled reviewer", 103, "cancelled", "human"),
    child("ses_child_interrupted", "Interrupted researcher", 102, "interrupted", "doom_loop"),
    child("ses_child_completed", "Completed reviewer", 101, "completed", "structured_output_valid"),
  ]
  const errors = await openPersistedPanel(page, children)
  await expect(page.getByText("Failed researcher")).toBeVisible()
  await expect(page.getByText("provider_error")).toBeVisible()
  await expect(page.getByRole("button", { name: "Select subagent Cancelled reviewer" })).toContainText("cancelled")
  await expect(page.getByRole("button", { name: "Select subagent Interrupted researcher" })).toContainText(
    "interrupted",
  )
  await expect(page.getByRole("button", { name: "Select subagent Completed reviewer" })).toContainText("finished")

  const completedRow = page.getByRole("button", { name: "Select subagent Completed reviewer" })
  const completedContainer = completedRow.locator("..")
  await completedRow.focus()
  await completedRow.press("Enter")
  await expect(completedContainer).toHaveClass(/ring-border-strong-base/)
  await expect(page).toHaveURL(new RegExp(`/${parentID}$`))
  await completedRow.press("Space")
  await expect(completedContainer).not.toHaveClass(/ring-border-strong-base/)

  await page.getByRole("button", { name: "Open Completed reviewer" }).click()
  await expect(page).toHaveURL(new RegExp("/ses_child_completed$"))
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [] })
})

for (const count of [0, 1]) {
  test(`persisted subagent panel cold-renders ${count} child without browser errors`, async ({ page }) => {
    const errors = await openPersistedPanel(
      page,
      count === 0 ? [] : [child("ses_only_child", "Only researcher", 101, "completed", "text_output_valid")],
    )
    if (count === 0) await expect(page.getByText("No subagents for this session")).toBeVisible()
    if (count === 1) await expect(page.getByText("Only researcher")).toBeVisible()
    expect(errors).toEqual({ pageErrors: [], consoleErrors: [] })
  })
}

test("unknown persisted panel mode fails closed", async ({ page }) => {
  const errors = await openPersistedPanel(page, [], "removed-panel")
  await expect(page.getByRole("tab", { name: "Subagents" })).toHaveAttribute("aria-selected", "false")
  await expect(page.getByText("No subagents for this session")).toHaveCount(0)
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [] })
})

test("production DOM contains no nested interactive controls in the subagent panel", async ({ page }) => {
  await openPersistedPanel(page, [child("ses_dom_child", "DOM researcher", 101, "completed", "text_output_valid")])
  const nested = await page.locator("#review-panel").evaluate((panel) => {
    const selector = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab]"
    return [...panel.querySelectorAll(selector)]
      .filter((element) => element.parentElement?.closest(selector))
      .map((element) => element.outerHTML)
  })
  expect(nested).toEqual([])
})

test("panel render failure stays local and retry recovers without a renderer error", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (name, value) {
      const root = window as typeof window & { __subagentPanelFailureInjected?: boolean }
      if (
        !root.__subagentPanelFailureInjected &&
        name === "aria-label" &&
        String(value).startsWith("Select subagent")
      ) {
        root.__subagentPanelFailureInjected = true
        throw new Error("injected subagent panel render failure")
      }
      return original.call(this, name, value)
    }
  })
  const errors = await openPersistedPanel(page, [
    child("ses_boundary_child", "Boundary researcher", 101, "completed", "text_output_valid"),
  ])
  await expect(page.getByText("The subagent panel could not be displayed.")).toBeVisible()
  await expect(page.getByRole("tab", { name: "Subagents" })).toBeVisible()
  expect(errors.pageErrors).toEqual([])
  expect(errors.consoleErrors.some((message) => message.includes("ui.panel.render_failed"))).toBe(true)

  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByText("Boundary researcher")).toBeVisible()
  await expect(page.getByText("The subagent panel could not be displayed.")).toHaveCount(0)
})

test("panel render failure can be closed without restarting the application", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (name, value) {
      if (name === "aria-label" && String(value).startsWith("Select subagent")) {
        throw new Error("injected persistent subagent panel failure")
      }
      return original.call(this, name, value)
    }
  })
  const errors = await openPersistedPanel(page, [
    child("ses_close_child", "Close researcher", 101, "completed", "text_output_valid"),
  ])
  await expect(page.getByText("The subagent panel could not be displayed.")).toBeVisible()
  await page.getByRole("button", { name: "Close", exact: true }).last().click()
  await expect(page.getByText("The subagent panel could not be displayed.")).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Subagents" })).toHaveAttribute("aria-selected", "false")
  expect(errors.pageErrors).toEqual([])
})
