import { expect, test } from "@playwright/test"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { mockDeepAgentCodeServer } from "../utils/mock-server"

const directory = "/private/prompt-keyboard-component"
const sessionID = "ses_prompt_keyboard_component"
const projectID = "proj_prompt_keyboard_component"
const marker = "qa-web-no-submit"

test("selects the entire real PromptInput and clears it with native keyboard events", async ({ page }, testInfo) => {
  const session = {
    id: sessionID,
    slug: "prompt-keyboard-component",
    projectID,
    directory,
    title: "Prompt keyboard component",
    version: "2.0.3",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
  await mockDeepAgentCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "Prompt keyboard component",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  const mutations: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() !== "GET") {
      mutations.push(pathname)
      await route.abort("blockedbyclient")
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: pathname.endsWith(`/session/${sessionID}`) ? session : [] }),
    })
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.focus()
  await page.keyboard.type(marker)
  await expect(editor).toHaveText(marker)
  await page.keyboard.press("ControlOrMeta+A")
  const selected = await editor.evaluate((element) => {
    const selection = window.getSelection()
    return {
      text: selection?.toString(),
      anchorInside: !!selection?.anchorNode && element.contains(selection.anchorNode),
      focusInside: !!selection?.focusNode && element.contains(selection.focusNode),
    }
  })
  expect(selected).toEqual({ text: marker, anchorInside: true, focusInside: true })
  await page.keyboard.press("Backspace")
  await expect(editor).toHaveText("")
  expect(await editor.evaluate((element) => element.textContent)).toBe("")
  // Chromium keeps a caret <br> in an empty contenteditable. It has no text,
  // although innerText represents that caret placeholder as a newline.
  expect((await editor.innerText()).trim()).toBe("")
  await page.keyboard.type(marker)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"],
  })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4,
  })
  expect(await editor.evaluate(() => window.getSelection()?.toString())).toBe(marker)
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
  await expect(editor).toHaveText("")
  expect(await editor.evaluate((element) => element.textContent)).toBe("")
  expect((await editor.innerText()).trim()).toBe("")
  expect(mutations).toEqual([])
  await testInfo.attach("keyboard-observation", {
    contentType: "application/json",
    body: JSON.stringify({
      actualComponent: "PromptInput", renderer: "Chromium", markerBytes: marker.length,
      nativeShortcutSelection: selected, explicitCDPSelectAllSelection: marker,
      finalTextContent: await editor.evaluate((element) => element.textContent),
      finalVisibleText: (await editor.innerText()).trim(), mutations: mutations.length,
      actualBackend: false, provider: false,
    }),
  })
  await testInfo.attach("cleared-editor", { contentType: "image/png", body: await page.screenshot() })
})
