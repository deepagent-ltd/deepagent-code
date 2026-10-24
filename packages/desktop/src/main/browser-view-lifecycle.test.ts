import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("real Electron browser views have independent window ownership and close their contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-lifecycle-"))
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/browser-view-lifecycle.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
    naming: "fixture.mjs",
  })
  expect(built.success).toBe(true)
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, built.outputs[0].path], {
    env: { ...process.env, DAC_BROWSER_TEST_ROOT: root, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), `${stdout}\n${stderr}`)
  const result = await Bun.file(path.join(root, "result.json")).json()
  console.log("BROWSER_LIFECYCLE_EVIDENCE", root, result)
  expect(exitCode).toBe(0)
  expect(result.initial.separateContents).toBe(true)
  expect(result.firstNavigation).toMatchObject({ initiallyHidden: true, loadingAtFirstShow: true,
    firstRequests: 1, sameContentsAfterHideShow: true })
  expect(result.firstNavigation.firstURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/first-open$/)
  expect(result.afterFirstDestroy.firstDestroyed).toBe(true)
  expect(result.afterFirstDestroy.secondAlive).toBe(true)
  expect(result.afterHostClose.replacementDestroyed).toBe(true)
  expect(result.final.secondDestroyed).toBe(true)
  expect(result.navigation.firstHidden).toBe(true)
  expect(result.navigation.secondVisible).toBe(true)
  expect(result.unknownClose).toEqual({ timeoutRetained: true, replacementRefused: true, repeatCloseCalls: 1, lateConfirmationReleased: true, capacityIncludesUnknown: true })
}, 20_000)
