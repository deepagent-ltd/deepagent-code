import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"

test("actual Electron private utility channel isolates network, observes AX/PNG, fences generations and destroys exact resource", async () => {
  const root = await fs.mkdtemp("/tmp/dac-managed-browser-electron-")
  await fs.chmod(root, 0o700)
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "main.mjs", define: await managedBrowserInputFixtureDefine(root) })
  const child = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-child.ts")],
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
  expect(result.requests).toContain("/")
  expect(result.requests).not.toContain("/revoked")
  expect(result.message.snapshot.result.text).toContain("原生浏览器 fixture")
  expect(result.message.image.mime).toBe("image/png")
  expect(result.message.image.bytes).toBeGreaterThan(100)
  expect(result.message.checks).toBeGreaterThan(10)
  expect(result.message.external).toBe("BROWSER_NETWORK_DENIED")
  expect(result.message.stale).toBe("BROWSER_STALE_TARGET")
  expect(result.message.revoked).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.rotated).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.stopped).toBe(true)
  expect(result.message.cancellationCount).toBe(24)
  expect(result.message.verify.stopped).toBe(true)
  expect(result.message.authOld).toBe(false)
}, 60_000)

test("actual native host permits sixteen total waiters across resources and cancel bypasses the full queue", async () => {
  const root = await fs.mkdtemp("/tmp/dac-managed-browser-capacity-")
  await fs.chmod(root, 0o700)
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "main.mjs", define: await managedBrowserInputFixtureDefine(root) })
  const child = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-capacity-child.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "child.mjs" })
  expect(main.success && child.success).toBe(true)
  const process = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), main.outputs[0]!.path], {
    env: { PATH: globalThis.process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root, DAC_BROWSER_TEST_ROOT: root, DAC_BROWSER_CHILD: child.outputs[0]!.path, DAC_BROWSER_CAPACITY: "1" }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => process.kill(), 55_000)
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  console.log("MANAGED_BROWSER_CAPACITY_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect({ code, result }).toMatchObject({ code: 0, result: { message: { type: "result", beforeCancel: 2, cancelled: [true, true] }, deniedTCP: 0 } })
  expect(result.message.elapsed).toBeLessThan(2_500)
  expect(result.message.outcomes).toHaveLength(20)
  expect(result.message.outcomes.filter((value: string) => value === "BROWSER_CAPACITY")).toHaveLength(2)
  expect(result.message.outcomes.filter((value: string) => value === "BROWSER_UNKNOWN")).toHaveLength(2)
  expect(result.message.outcomes.filter((value: string) => value === "BROWSER_CANCELLED")).toHaveLength(16)
  expect(result.message.failedCreate).toBe("BROWSER_CAPACITY")
  expect(result.message.failedCreateVerified).toBe(false)
}, 60_000)
