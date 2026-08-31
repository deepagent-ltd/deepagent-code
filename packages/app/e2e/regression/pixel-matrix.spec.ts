import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"
import {
  cnID,
  enID,
  errorID,
  pixelDirectory,
  pixelMockConfig,
  pixelRecoveryDescriptors,
  recoveryID,
} from "./pixel-matrix.fixture"

// C6-10 真像素矩阵 — real-browser pixel pass (the state-level invariant matrix is
// packages/app/src/recovery/ux-matrix-invariants.test.ts; this file is the
// BROWSER residue with screenshot evidence). Matrix: small/large windows ×
// 中文/英文/长错误/多恢复项. Invariants per state: no horizontal overflow,
// composer visible inside the viewport, session title + composer never overlap,
// keyboard focus reaches the composer, and a screenshot is saved to
// e2e/pixel-matrix/.

const viewports = [
  { name: "small-390x844", width: 390, height: 844 },
  { name: "laptop-1280x720", width: 1280, height: 720 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 },
] as const

test.beforeEach(async ({ page }) => {
  await mockDeepAgentCodeServer(page, pixelMockConfig)
  // DEV-only performance diagnostics overlay (layout.tsx: `import.meta.env.DEV && <DebugBar />`)
  // never ships in the packaged build; exclude it from the product pixel surface.
  await page.addInitScript(() => {
    const hide = () => {
      document.querySelectorAll('[aria-label="Development performance diagnostics"]').forEach((el) => {
        ;(el as HTMLElement).style.display = "none"
      })
    }
    document.addEventListener("DOMContentLoaded", hide, { once: true })
    new MutationObserver(hide).observe(document, { childList: true, subtree: true })
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
          showSessionProgressBar: true,
        },
      }),
    )
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "deepagent-code.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, pixelDirectory)
})

async function openSession(page: Page, sessionID: string, title: string) {
  const errors = trackPageErrors(page)
  // The session route only resolves after the home project is selected in-app
  // (same flow as the smoke spec); a direct deep link on a cold app state 404s.
  await page.goto("/")
  const row = page.locator('[data-home-project-row]').filter({ hasText: /PixelProject/i }).first()
  await expectAppVisible(row)
  await row.click()
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/)
  await page.goto(`/${base64Encode(pixelDirectory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const composer = page.getByRole("textbox", { name: /Ask anything/i })
  await expectAppVisible(composer)
  const titleBox = await page.getByRole("heading", { name: title }).boundingBox()
  const composerBox = await composer.boundingBox()
  expect(titleBox).toBeTruthy()
  expect(composerBox).toBeTruthy()
  // No overlap between the session title and the composer (both visible on load).
  expect(composerBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1)
  // Composer fully inside the viewport.
  expect(composerBox!.x).toBeGreaterThanOrEqual(0)
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
  // No horizontal overflow at the document level nor inside the timeline scroller.
  const overflow = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
      el.querySelector("[data-timeline-row], [data-session-title]"),
    )
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scroller: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
    }
  })
  expect(overflow.document).toBeLessThanOrEqual(1)
  expect(overflow.scroller).not.toBeNull()
  expect(overflow.scroller!).toBeLessThanOrEqual(1)
  // Keyboard + mouse smoke: the composer accepts focus and text (contenteditable).
  // Focus is set programmatically so a dev-only overlay never intercepts the click.
  await composer.focus()
  await page.keyboard.type("pixel matrix check")
  await expect(composer).toContainText("pixel matrix check")
  await page.keyboard.press("Escape")
  return { errors, composer }
}

for (const viewport of viewports) {
  test.describe(`pixel matrix @ ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test(`中文 session renders without overflow or overlap`, async ({ page }) => {
      const { errors, composer } = await openSession(page, cnID, "中文长标题：跨代码库检索重构方案与依赖分析")
      await expect(page.getByText("方案：将公共依赖抽取到")).toBeVisible()
      await expect(composer).toBeVisible()
      expect(errors).toEqual([])
      await page.screenshot({ path: `e2e/pixel-matrix/cn-${viewport.name}.png` })
    })

    test(`英文 session renders without overflow or overlap`, async ({ page }) => {
      const { errors } = await openSession(page, enID, "Refactor dependency graph across 3 repositories")
      await expect(page.getByText("Extract the shared kernel")).toBeVisible()
      expect(errors).toEqual([])
      await page.screenshot({ path: `e2e/pixel-matrix/en-${viewport.name}.png` })
    })

    test(`long error renders without overflow and keeps the stable code visible`, async ({ page }) => {
      const { errors } = await openSession(page, errorID, "Long error handler")
      await expect(page.getByText(/STABLE_CODE_7F3A9C/)).toBeVisible()
      const codeVisible = await page
        .getByText(/STABLE_CODE_7F3A9C/)
        .evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return rect.left >= 0 && rect.right <= window.innerWidth + 1
        })
      expect(codeVisible).toBe(true)
      expect(errors).toEqual([])
      await page.screenshot({ path: `e2e/pixel-matrix/error-${viewport.name}.png` })
    })
  })
}

test.describe("pixel matrix @ recovery dock", () => {
  test.use({ viewport: { width: 1920, height: 1080 } })

  test("multi recovery items render with exits and a visible serial queue, no overlap", async ({ page }) => {
    // Register AFTER the beforeEach mock handler: playwright invokes the LAST
    // registered route first, so this route wins for /recovery/list and the dock
    // sees five real pending descriptors instead of a failed/empty list.
    await page.route("**/recovery/list**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ descriptors: pixelRecoveryDescriptors }) })
    })

    await page.goto("/")
    const row = page.locator('[data-home-project-row]').filter({ hasText: /PixelProject/i }).first()
    await expectAppVisible(row)
    await row.click()
    await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/)
    await page.goto(`/${base64Encode(pixelDirectory)}/session/${recoveryID}`)
    await expectSessionTitle(page, "Recovery dock pixel state")
    const composer = page.getByRole("textbox", { name: /Ask anything/i })
    await expectAppVisible(composer)

    // All five pending items render (three exact + two coordination).
    for (const id of ["req-exact-0", "req-exact-1", "req-exact-2", "req-coord-3", "req-coord-4"]) {
      await expect(page.getByText(id)).toBeVisible()
    }

    // Coordination items pass through the query-first path — an enabled
    // "Query command" exit plus the typed reason, never a dead-end.
    await expect(page.getByRole("button", { name: "Query command" })).toHaveCount(2)
    await expect(page.getByText("No executable exit (query first).")).toHaveCount(2)

    // Exact items expose executable exits immediately (never a dead button).
    await expect(page.getByRole("button", { name: /abandon\.exact/ })).toHaveCount(3)
    await expect(page.getByRole("button", { name: /recover\.resolve/ })).toHaveCount(3)
    await expect(page.getByRole("button", { name: /abandon\.exact/ }).first()).toBeEnabled()
    await expect(page.getByRole("button", { name: /recover\.resolve/ }).first()).toBeEnabled()

    // Cards never overlap.
    const boxes = await Promise.all(
      ["req-exact-0", "req-exact-1", "req-exact-2", "req-coord-3", "req-coord-4"].map(async (id) => {
        const card = page.locator(`div.mb-2.rounded-md`, { hasText: id }).first()
        return await card.boundingBox()
      }),
    )
    const items = boxes.filter((box): box is { x: number; y: number; width: number; height: number } => box !== null)
    expect(items).toHaveLength(5)
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const intersect =
          items[a].x < items[b].x + items[b].width &&
          items[a].x + items[a].width > items[b].x &&
          items[a].y < items[b].y + items[b].height &&
          items[a].y + items[a].height > items[b].y
        expect(intersect).toBe(false)
      }
    }

    await page.screenshot({ path: "e2e/pixel-matrix/recovery-desktop-1920x1080.png" })
  })
})
