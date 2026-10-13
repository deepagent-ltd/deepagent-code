import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("actual managed control creates selects closes four tabs and binds history to the exact document", async () => {
  const root = await fs.mkdtemp("/tmp/dac-managed-browser-electron-")
  await fs.chmod(root, 0o700)
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "main.mjs" })
  const child = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-lifecycle-child.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "child.mjs" })
  expect(main.logs).toEqual([])
  expect(child.logs).toEqual([])
  expect(main.success && child.success).toBe(true)
  const process = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), main.outputs[0]!.path], {
    env: { PATH: globalThis.process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root, DAC_BROWSER_TEST_ROOT: root, DAC_BROWSER_CHILD: child.outputs[0]!.path }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => process.kill(), 55_000)
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  console.log("MANAGED_BROWSER_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(code).toBe(0)
  expect(result.deniedTCP).toBe(0)
  expect(result.inheritedProxyConfigured).toBe(true)
  expect(result.requests).toContain("/new")
  expect(result.requests).toContain("/next")
  expect(result.message.original.url).toBe("about:blank")
  expect(result.message.second.selected).toBe(true)
  expect(result.message.next.canGoBack).toBe(true)
  expect(result.message.prior.url).toEndWith("/new")
  expect(result.message.prior.canGoForward).toBe(true)
  expect(result.message.following.url).toEndWith("/next")
  expect(result.message.reloaded.generation).toBeGreaterThan(result.message.following.generation)
  expect(result.message.selected.tabs.find((tab: { selected: boolean }) => tab.selected).tabID).toBe(result.message.original.tabID)
  expect(result.message.stale).toBe("BROWSER_STALE_TARGET")
  expect(result.message.foreign).toBe("BROWSER_NETWORK_DENIED")
  expect(result.message.full.tabs).toHaveLength(4)
  expect(result.message.capacity).toBe("BROWSER_CAPACITY")
  expect(result.message.closed.tabs).toHaveLength(3)
  expect(result.message.oldClosed).toBe("BROWSER_STALE_TARGET")
  expect(result.message.replacement.tabs).toHaveLength(4)
  expect(result.message.cancel).toBe(true)
  expect(result.message.verify.stopped).toBe(true)
}, 60_000)
