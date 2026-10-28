import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test.skipIf(process.platform !== "darwin")("actual private browser host grants exact readonly scripts and blocks side effects, network and stale targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-managed-browser-script-"))
  await fs.chmod(root, 0o700)
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "main.mjs", define: await managedBrowserInputFixtureDefine(root) })
  const child = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-script-child.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "child.mjs" })
  expect(main.logs).toEqual([])
  expect(child.logs).toEqual([])
  expect(main.success && child.success).toBe(true)
  const process = Bun.spawn([managedBrowserInputFixtureExecutable, main.outputs[0]!.path], {
    env: { ...managedBrowserInputFixtureEnvironment, PATH: globalThis.process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root, DAC_BROWSER_TEST_ROOT: root, DAC_BROWSER_CHILD: child.outputs[0]!.path,
      DAC_MANAGED_BROWSER_INPUT_DIAGNOSTICS: "1" }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => process.kill(), 55_000)
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  console.log("MANAGED_BROWSER_SCRIPT_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect({ code, error: code ? result : null }).toEqual({ code: 0, error: null })
  expect(result.deniedTCP).toBe(0)
  expect(result.requests).not.toContain("/script-network")
  expect(JSON.parse(result.message.normal.scriptResultJSON)).toEqual({ heading: "原生浏览器 fixture",
    label: "验证参数", host: ["undefined", "undefined", "undefined"] })
  expect(result.message.wrongSource).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.wrongArgs).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.copiedDescriptor).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.revoked).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.stale).toBe("BROWSER_STALE_TARGET")
  expect(result.message.failures).toHaveLength(6)
  expect(result.message.failures.every((value: { code: string }) => value.code === "BROWSER_UNKNOWN")).toBe(true)
  expect(result.message.cannotAddGrant).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.capacity).toBe("BROWSER_CAPACITY")
  expect(result.message.repeat).toBe("BROWSER_UNKNOWN")
  expect(JSON.parse(result.message.untouched)).toBeNull()
  expect(result.message.extraSuccess).toBe(24)
  expect(result.message.stopped).toBe(true)
  expect(result.message.verify.stopped).toBe(true)
}, 60_000)
