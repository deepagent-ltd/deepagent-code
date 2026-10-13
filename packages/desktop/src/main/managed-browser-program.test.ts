import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"

test("actual approved readonly planner mutates only native current leaves, submits once and keeps partial cancellation unknown", async () => {
  const root = await fs.mkdtemp("/tmp/dac-managed-browser-program-")
  await fs.chmod(root, 0o700)
  const main = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-program.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
    naming: "main.mjs",
    define: await managedBrowserInputFixtureDefine(root),
  })
  const child = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-program-child.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
    naming: "child.mjs",
  })
  expect(main.logs).toEqual([])
  expect(child.logs).toEqual([])
  expect(main.success && child.success).toBe(true)
  const process = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), main.outputs[0]!.path], {
    env: {
      PATH: globalThis.process.env.PATH,
      HOME: root,
      TMPDIR: root,
      XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
      DAC_BROWSER_TEST_ROOT: root,
      DAC_BROWSER_CHILD: child.outputs[0]!.path,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => process.kill(), 50_000)
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  console.log("MANAGED_BROWSER_PROGRAM_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect({ code, error: code ? result : null }).toEqual({ code: 0, error: null })
  expect(result.message.normal.program.totalSteps).toBe(3)
  expect(result.message.normal.program.completedSteps).toBe(3)
  expect(result.message.normal.program.steps).toEqual([
    { ordinal: 0, operation: "fill" },
    { ordinal: 1, operation: "select" },
    { ordinal: 2, operation: "click" },
  ])
  expect(result.message.normal.program.planHash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.requests.filter((value: { url: string }) => value.url === "/program-submit")).toEqual([
    { method: "POST", url: "/program-submit", body: "name=program+value&choice=b" },
  ])
  expect(
    result.requests.some((value: { url: string }) =>
      ["/program-nonterminal", "/program-planner-network"].includes(value.url),
    ),
  ).toBe(false)
  expect(result.deniedTCP).toBe(0)
  expect(result.message.wrongSource).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.wrongArgs).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.clone).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.revoked).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.staleObservation).toBe("BROWSER_STALE_TARGET")
  expect(result.message.preflight).toEqual(
    ["option", "target"].map((kind) => ({
      kind,
      code: "BROWSER_UNKNOWN",
      observed: { name: "", choice: "a", tail: "untouched", write: null },
    })),
  )
  expect(result.message.failures).toHaveLength(6)
  expect(result.message.failures.every((value: { code: string }) => value.code === "BROWSER_UNKNOWN")).toBe(true)
  expect(result.message.untouched).toEqual({ name: "", choice: "a", tail: "untouched", write: null })
  expect(result.message.stale).toBe("BROWSER_UNKNOWN")
  expect(result.message.prefix).toEqual({ name: "program value", choice: "a", tail: "untouched", write: null })
  expect(result.message.cancelled).toBe("BROWSER_UNKNOWN")
  expect(result.message.repeat).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.stopped).toBe(true)
  expect(result.message.verify.stopped).toBe(true)
  expect(result.requests.filter((value: { url: string }) => value.url === "/program-hold-submit")).toHaveLength(1)
  expect(result.lateRequestsCompleted).toBe(1)
  expect(
    result.requests.filter((value: { url: string }) => ["/program-late-get", "/program-late-post"].includes(value.url)),
  ).toEqual([])
}, 55_000)
