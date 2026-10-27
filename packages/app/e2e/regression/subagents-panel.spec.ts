import { expect, test, type Page } from "@playwright/test"
import type { TaskSummarySchema } from "@deepagent-code/core/session/task-summary.schema"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/DeepAgent Code/SubagentPanel"
const projectID = "proj_subagent_panel"
const parentID = "ses_subagent_parent"
const otherParentID = "ses_other_subagent_parent"
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

const child = (
  id: string,
  title: string,
  updated: number,
  state: TaskSummarySchema.Item["state"],
  reason: string,
): TaskSummarySchema.Item => ({
  childSessionID: id,
  title,
  agent: "researcher",
  state,
  runID: `run_${id}`,
  generation: 1,
  controlState: "closed",
  createdAt: updated - 1,
  updatedAt: updated,
  settledAt: updated,
  progress: { messageID: `msg_progress_${id}`, text: reason, tool: null },
  result: {
    state: state === "completed" ? "available" : "not_available",
    text: state === "completed" ? `Result for ${title}` : null,
    messageID: state === "completed" ? `msg_result_${id}` : null,
    truncated: false,
  },
  notification: { state: "not_established", updatedAt: null, deliveredAt: null },
})

async function openPersistedPanel(
  page: Page,
  children: TaskSummarySchema.Item[],
  mode = "subagents",
  response?: (sessionID: string) => TaskSummarySchema.Summary | undefined,
) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const mutations: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    // Context estimates use POST for read options; they do not admit or mutate a task.
    if (request.method() === "POST" && path.endsWith("/context-usage")) return
    if (request.method() !== "GET" && path.startsWith("/session/")) mutations.push(request.url())
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
    sessions: [parent, { ...parent, id: otherParentID, title: "Other parent" }],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/session/*/task-summary**", async (route) => {
    const sessionID = new URL(route.request().url()).pathname.split("/").at(-2)!
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(
        response?.(sessionID) ?? {
          parentSessionID: sessionID,
          observedAt: 1_700_000_000_000,
          items:
            sessionID === parentID
              ? children
              : [child("ses_other_child", "Other session researcher", 105, "completed", "Other session progress")],
          hasMore: false,
          nextCursor: null,
        },
      ),
    })
  })
  await page.addInitScript(
    ({ key, otherKey, value }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "deepagent.global.dat:layout",
        JSON.stringify({
          sessionView: {
            [key]: { scroll: {}, rightPanelMode: value },
            [otherKey]: { scroll: {}, rightPanelMode: "subagents" },
          },
        }),
      )
    },
    { key: sessionKey, otherKey: `local\u0000${slug}/${otherParentID}`, value: mode },
  )
  await page.goto(`/${slug}/session/${parentID}`)
  await expectAppVisible(page.getByRole("heading", { name: parent.title, exact: true }))
  if (mode === "subagents") await expectAppVisible(page.getByRole("tab", { name: "Task progress", exact: true }))
  return { pageErrors, consoleErrors, mutations }
}

test("persisted task progress keeps terminal states, readonly selection, and parent Session scopes independent", async ({
  page,
}) => {
  const children = [
    child("ses_child_error", "Failed researcher", 104, "error", "provider_error"),
    child("ses_child_cancelled", "Cancelled reviewer", 103, "cancelled", "human"),
    child("ses_child_interrupted", "Interrupted researcher", 102, "interrupted", "doom_loop"),
    child("ses_child_completed", "Completed reviewer", 101, "completed", "structured_output_valid"),
  ]
  const errors = await openPersistedPanel(page, children)
  const details = page.locator('[data-slot="task-progress-details"]')
  await expect(details.getByRole("button", { name: /Failed researcher/ })).toContainText("Error")
  await expect(details.getByText("provider_error", { exact: true })).toBeVisible()
  await expect(details.getByRole("button", { name: /Cancelled reviewer/ })).toContainText("Cancelled")
  await expect(details.getByRole("button", { name: /Interrupted researcher/ })).toContainText("Interrupted")
  await expect(details.getByRole("button", { name: /Completed reviewer/ })).toContainText("Completed")

  const completedRow = details.getByRole("button", { name: /Completed reviewer/ })
  await completedRow.focus()
  await completedRow.press("Enter")
  await expect(completedRow).toHaveClass(/(?:^|\s)bg-surface-raised-base(?:\s|$)/)
  await expect(details.getByText("Result for Completed reviewer", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/${parentID}$`))
  await details.getByRole("button", { name: /Cancelled reviewer/ }).press("Space")
  await expect(completedRow).not.toHaveClass(/(?:^|\s)bg-surface-raised-base(?:\s|$)/)
  await expect(details.getByText("human", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/${parentID}$`))
  await expect(
    details.getByRole("button", { name: /stop|cancel task|rollback|resume|takeover|open child/i }),
  ).toHaveCount(0)

  await page.goto(`/${slug}/session/${otherParentID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Other parent", exact: true }))
  await expect(details.getByRole("button", { name: /Other session researcher/ })).toBeVisible()
  for (const item of children)
    await expect(details.getByRole("button", { name: new RegExp(item.title) })).toHaveCount(0)
  await expect(details.getByText("Result for Other session researcher", { exact: true })).toBeVisible()
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [], mutations: [] })
})

for (const count of [0, 1]) {
  test(`persisted task progress cold-renders ${count} child without browser errors`, async ({ page }) => {
    const errors = await openPersistedPanel(
      page,
      count === 0 ? [] : [child("ses_only_child", "Only researcher", 101, "completed", "text_output_valid")],
    )
    const details = page.locator('[data-slot="task-progress-details"]')
    if (count === 0) await expect(details.getByText("No subtasks", { exact: true })).toBeVisible()
    if (count === 1) {
      await expect(details.getByRole("button", { name: /Only researcher/ })).toBeVisible()
      await expect(details.getByText("Result for Only researcher", { exact: true })).toBeVisible()
    }
    expect(errors).toEqual({ pageErrors: [], consoleErrors: [], mutations: [] })
  })
}

test("unknown persisted panel mode fails closed", async ({ page }) => {
  const errors = await openPersistedPanel(page, [], "removed-panel")
  await expect(page.getByRole("tab", { name: "Task progress", exact: true })).toHaveCount(0)
  await expect(page.locator('[data-slot="task-progress-details"]')).toHaveCount(0)
  await page.getByRole("banner").getByRole("button", { name: "Toggle right sidebar" }).click()
  await expect(page.getByRole("tab", { name: "New tab", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-slot="task-progress-details"]')).toHaveCount(0)
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [], mutations: [] })
})

test("task labels remain text and production DOM contains no nested interactive controls", async ({ page }) => {
  const title = '<img src="/unexpected-task-label" alt="injected"> DOM researcher'
  const errors = await openPersistedPanel(page, [child("ses_dom_child", title, 101, "completed", "text_output_valid")])
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible()
  await expect(page.locator('img[alt="injected"]')).toHaveCount(0)
  const nested = await page.locator("#review-panel").evaluate((panel) => {
    const selector = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab]"
    return [...panel.querySelectorAll(selector)]
      .filter((element) => element.parentElement?.closest(selector))
      .map((element) => element.outerHTML)
  })
  expect(nested).toEqual([])
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [], mutations: [] })
})

test("injected cross-Session task data stays local and a current response recovers without a renderer error", async ({
  page,
}) => {
  let injected = true
  const errors = await openPersistedPanel(
    page,
    [child("ses_boundary_child", "Boundary researcher", 101, "completed", "text_output_valid")],
    "subagents",
    () =>
      injected
        ? {
            parentSessionID: otherParentID,
            observedAt: 1_700_000_000_000,
            items: [child("ses_foreign", "Foreign researcher", 101, "completed", "Foreign result")],
            hasMore: false,
            nextCursor: null,
          }
        : undefined,
  )
  const details = page.locator('[data-slot="task-progress-details"]')
  await expect(details.getByRole("status")).toHaveText("Request failed")
  await expect(details.getByText("Foreign researcher", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: parent.title, exact: true })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Task progress", exact: true })).toBeVisible()

  injected = false
  await expect(details.getByRole("button", { name: /Boundary researcher/ })).toBeVisible()
  await expect(details.getByText("Result for Boundary researcher", { exact: true })).toBeVisible()
  await expect(details.getByRole("status")).toHaveCount(0)
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [], mutations: [] })
})

test("a failed task snapshot can be closed and reopened without restarting the application", async ({ page }) => {
  let injected = true
  const errors = await openPersistedPanel(
    page,
    [child("ses_close_child", "Close researcher", 101, "completed", "text_output_valid")],
    "subagents",
    () =>
      injected
        ? { parentSessionID: otherParentID, observedAt: 1_700_000_000_000, items: [], hasMore: false, nextCursor: null }
        : undefined,
  )
  const details = page.locator('[data-slot="task-progress-details"]')
  await expect(details.getByRole("status")).toHaveText("Request failed")
  await details.getByRole("button", { name: "Add instructions to main Agent", exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(page.getByRole("heading", { name: parent.title, exact: true })).toBeVisible()
  injected = false
  await page.getByRole("banner").getByRole("button", { name: "Toggle right sidebar" }).click()
  await expect(details.getByRole("button", { name: /Close researcher/ })).toBeVisible()
  await expect(details.getByText("Result for Close researcher", { exact: true })).toBeVisible()
  expect(errors).toEqual({ pageErrors: [], consoleErrors: [], mutations: [] })
})
