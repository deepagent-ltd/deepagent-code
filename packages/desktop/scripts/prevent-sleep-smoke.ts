#!/usr/bin/env bun
// Dynamic smoke test for the "Prevent system sleep" settings toggle (macOS only).
//
// Drives the real packaged main bundle through Playwright and asserts against the OS:
//   1. default launch registers a NoIdleSleepAssertion (historical always-on default)
//   2. toggling the switch off in Settings removes the assertion while the app keeps running
//   3. the disabled state persists across a relaunch (no assertion after restart)
//   4. toggling back on re-registers the assertion
//
// Requires a prior `bun run build` (uses out/main/index.js), same as subagents-smoke.
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"

if (process.platform !== "darwin") {
  console.log("prevent-sleep smoke is macOS-only (pmset assertions), skipping")
  process.exit(0)
}

const root = await realpath(await mkdtemp(join(tmpdir(), "deepagent-code-prevent-sleep-smoke-")))
const main = resolve("out/main/index.js")

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
)
env.DEEPAGENT_CODE_TEST_ONBOARDING = "1"
env.DEEPAGENT_CODE_TEST_ROOT = root
env.DEEPAGENT_CODE_DB = join(root, "deepagent.sqlite")
env.DEEPAGENT_CODE_DISABLE_CHANNEL_DB = "1"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function idleSleepAssertionPids(): number[] {
  const output = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" })
  return [...output.matchAll(/pid (\d+)\([^)]*\): \[[^\]]*\] [\d:]+ NoIdleSleepAssertion/g)].map((match) =>
    Number(match[1]),
  )
}

async function waitForAssertion(pid: number, expected: boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (idleSleepAssertionPids().includes(pid) === expected) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for NoIdleSleepAssertion of pid ${pid} to become ${expected}`)
}

async function launch() {
  const app = await electron.launch({ args: [main], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean((window as { api?: unknown }).api))
  await page.evaluate(() =>
    (window as unknown as { api: { awaitInitialization(): Promise<unknown> } }).api.awaitInitialization(),
  )
  const pid = app.process().pid
  assert.ok(pid, "main process pid")
  return { app, page, pid }
}

const switchSelector = '[data-action="settings-prevent-sleep"] [data-component="switch"]'
const switchInputSelector = `${switchSelector} input[data-slot="switch-input"]`

async function setPreventSleepViaSettings(page: Page, enabled: boolean) {
  await page.keyboard.press("Meta+,")
  const control = page.locator(`${switchSelector} [data-slot="switch-control"]`)
  await control.waitFor({ state: "visible", timeout: 15_000 })
  // Wait until the switch reflects the opposite state before clicking, so the
  // click deterministically lands on the desired state even if the resource is slow.
  const before = enabled ? "false" : "true"
  await page.waitForFunction(
    ({ selector, before }) => document.querySelector(selector)?.getAttribute("aria-checked") === before,
    { selector: switchInputSelector, before },
    { timeout: 15_000 },
  )
  await control.click()
  await page.keyboard.press("Escape")
}

// 1. Fresh launch: prevention defaults on.
const first = await launch()
await waitForAssertion(first.pid, true)
console.log("ok 1 - default launch registers NoIdleSleepAssertion")

// 2. Turning the Settings toggle off releases the assertion without quitting.
await setPreventSleepViaSettings(first.page, false)
await waitForAssertion(first.pid, false)
console.log("ok 2 - disabling the toggle releases the assertion while running")
await first.app.close()

// 3. Relaunch: the persisted disabled state keeps the assertion off.
const second = await launch()
await sleep(3_000)
assert.ok(!idleSleepAssertionPids().includes(second.pid), "assertion must stay off after relaunch with setting disabled")
console.log("ok 3 - disabled state persists across relaunch")

// 4. Re-enabling registers the assertion again.
await setPreventSleepViaSettings(second.page, true)
await waitForAssertion(second.pid, true)
console.log("ok 4 - re-enabling the toggle registers the assertion again")
await second.app.close()

console.log("prevent-sleep smoke passed")
