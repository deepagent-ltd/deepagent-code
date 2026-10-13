import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:net"
import { Schema } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { chromium } from "@playwright/test"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { BrowserCanonicalViewport } from "../../../tui/test/fixture/browser-canonical-viewport"

const actual = process.env.DAC_BROWSER_CLIENT_ACTUAL
test.skipIf(!["startup", "full", "tui", "tui-startup"].includes(actual ?? ""))("original Native client hold window adopts Root and accepts GUI/TUI prompts only from their real composer", async () => {
  if (actual !== "startup") await (await BrowserCanonicalViewport.create()).dispose()
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-client-window-"))
  await fs.chmod(root, 0o700)
  await Promise.all(["home", "tmp", "project", "config", "data", "cache", "state"].map((name) =>
    fs.mkdir(path.join(root, name), { mode: 0o700 })))
  await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const bin = path.join(root, "home/.deepagent/code/cache/bin")
  await fs.mkdir(bin, { recursive: true, mode: 0o700 })
  const rg = Bun.which("rg")
  if (!rg) throw new Error("Original dependency rg is unavailable")
  await fs.copyFile(rg, path.join(bin, "rg"))
  const allocator = createServer()
  await new Promise<void>((resolve) => allocator.listen(0, "127.0.0.1", resolve))
  const address = allocator.address()
  if (!address || typeof address === "string") throw new Error("Own App port was not allocated")
  await new Promise<void>((resolve) => allocator.close(() => resolve()))
  const appOrigin = `http://127.0.0.1:${address.port}`
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-client-window.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "main.mjs", sourcemap: "external",
    define: await managedBrowserInputFixtureDefine(root) })
  const child = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-client-window-child.ts")],
    outdir: root, target: "node", external: ["electron", "jsonc-parser", "@lydell/node-pty", "bun"], naming: "child.mjs",
    sourcemap: "external", define: { DEEPAGENT_CODE_VERSION: '"0.0.0-browser-client-dev"', DEEPAGENT_CODE_CHANNEL: '"dev"' },
    files: { "deepagent-code-web-ui.gen.ts": "" } })
  expect(main.success && child.success).toBe(true)
  const repository = path.resolve(import.meta.dir, "../../../..")
  const compiled = new Map<string, string>()
  const sourcemap = Schema.Struct({ sources: Schema.Array(Schema.String), sourcesContent: Schema.Array(Schema.NullOr(Schema.String)) })
  for (const result of [main, child]) {
    const map = result.outputs.find((output) => output.path.endsWith(".map"))!
    const input = Schema.decodeUnknownSync(sourcemap)(await Bun.file(map.path).json())
    input.sources.forEach((source, index) => {
      const filename = path.resolve(path.dirname(map.path), source)
      const bytes = input.sourcesContent[index]
      if (!filename.startsWith(repository + "/packages/") || filename.includes("/node_modules/") || bytes == null) return
      compiled.set(filename, Hash.sha256(bytes))
    })
  }
  const sources = await Promise.all(Array.from(compiled, async ([filename, sha256]) => ({ path: path.relative(repository, filename),
    sha256, current: Hash.sha256(await fs.readFile(filename)) })))
  const drift = sources.filter((row) => row.sha256 !== row.current)
  expect(drift).toEqual([])
  await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ checked: sources.length, drift, sources }, null, 2), { mode: 0o600 })
  console.log("CLIENT_WINDOW_SOURCE_CAPTURED", root)
  const log = await fs.open(path.join(root, "native-private.log"), "wx", 0o600)
  const process = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"),
    main.outputs.find((output) => output.path.endsWith("main.mjs"))!.path], {
    env: { PATH: globalThis.process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
      XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DAC_BROWSER_CLIENT_ROOT: root, DAC_BROWSER_CLIENT_APP_ORIGIN: appOrigin,
      DAC_BROWSER_CLIENT_EXPECTED_CLIENTS: ["startup", "tui-startup"].includes(actual ?? "") ? "0" : actual === "tui" ? "1" : "2",
      DAC_BROWSER_CLIENT_CHILD: child.outputs.find((output) => output.path.endsWith("child.mjs"))!.path,
      NO_PROXY: "127.0.0.1,localhost,::1", NO_COLOR: "1" }, stdout: log.fd, stderr: log.fd,
  })
  const deadline = Date.now() + 250_000
  const consumers: ReturnType<typeof Bun.spawn>[] = []
  try {
    while (!(await Bun.file(path.join(root, "client-window-private.json")).exists())) {
      if (process.exitCode !== null || Date.now() >= deadline) throw new Error("Original native Root did not reach hold-ready")
      await Bun.sleep(30)
    }
    if (actual !== "startup") {
      const clients = actual === "tui" || actual === "tui-startup" ? [["tui", "browser-canonical-pty.ts"]]
        : [["app", "browser-canonical-product.ts"], ["tui", "browser-canonical-pty.ts"]]
      for (const [packageName, file] of clients) {
        const out = await fs.open(path.join(root, `${packageName}-driver-private.log`), "wx", 0o600)
        const consumer = Bun.spawn([globalThis.process.execPath, path.join(repository, `packages/${packageName}/test/fixture/${file}`), path.join(root, "client-window-private.json"),
          ...(actual === "tui-startup" ? ["--startup-only"] : [])], {
          cwd: path.join(repository, `packages/${packageName}`), env: { PATH: globalThis.process.env.PATH, HOME: path.join(root, "home"),
            DAC_BROWSER_CLIENT_CHROMIUM: chromium.executablePath(),
            DAC_BROWSER_TUI_XTERM_QA_ROOT: globalThis.process.env.DAC_BROWSER_TUI_XTERM_QA_ROOT,
            ...(actual === "tui-startup" ? { DAC_BROWSER_TUI_STARTUP_TRACE: "1" } : {}) }, stdout: out.fd, stderr: out.fd,
        })
        consumers.push(consumer)
        const code = await Promise.race([consumer.exited, Bun.sleep(110_000).then(() => undefined)])
        await out.close()
        if (code === undefined) throw new Error("Original client driver exceeded its bounded window")
        expect(code).toBe(0)
      }
    }
    await fs.writeFile(path.join(root, "client-window-stop"), "Original client window finished", { mode: 0o600, flag: "wx" })
    const code = await Promise.race([process.exited, Bun.sleep(15_000).then(() => undefined)])
    expect(code).toBe(0)
    const result = await Bun.file(path.join(root, "main-window-result-safe.json")).json()
    expect(result.childExit).toBe(0)
    expect(result.windows).toBe(0)
    expect(result.listenersClosed).toBe(true)
    expect(result.providerCalls).toHaveLength(["startup", "tui-startup"].includes(actual ?? "") ? 0 : actual === "tui" ? 5 : 10)
    expect(result.requests.filter((request: { method: string }) => request.method === "POST")).toHaveLength(["startup", "tui-startup"].includes(actual ?? "") ? 0 : actual === "tui" ? 1 : 2)
  } finally {
    await fs.writeFile(path.join(root, "client-window-stop"), "Own bounded cleanup", { mode: 0o600 }).catch(() => undefined)
    for (const consumer of consumers) {
      if (consumer.exitCode === null) consumer.kill("SIGTERM")
      await Promise.race([consumer.exited, Bun.sleep(3000)])
      if (consumer.exitCode === null) { consumer.kill("SIGKILL"); await consumer.exited }
    }
    if (process.exitCode === null) await Promise.race([process.exited, Bun.sleep(10_000)])
    if (process.exitCode === null) { process.kill("SIGTERM"); await Promise.race([process.exited, Bun.sleep(2000)]) }
    if (process.exitCode === null) { process.kill("SIGKILL"); await process.exited }
    await log.close()
  }
}, 300_000)
