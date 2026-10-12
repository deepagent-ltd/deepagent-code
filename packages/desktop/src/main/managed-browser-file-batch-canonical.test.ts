import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, generateKeyPairSync } from "node:crypto"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { buildWorkFileHelper } from "../../../deepagent-code/script/build-work-file-helper"
import { buildWorkStorageCleanup } from "../../../deepagent-code/script/build-work-storage-cleanup"
import { nativeNodeDefines } from "../../../deepagent-code/script/build-native-node"
import { signNativeNodeArtifact } from "../../../deepagent-code/script/sign-native-node"

const downloadOnly = process.env.DAC_BROWSER_FILE_BATCH_DOWNLOAD_ACTUAL === "1"
const actual = process.env.DAC_BROWSER_FILE_BATCH_ACTUAL === "1" || downloadOnly ? test : test.skip
actual(downloadOnly
  ? "installed private canonical 50MiB download through original permissions and runner"
  : "installed private canonical file exchange: four 50MiB uploads and a 50MiB download through original permissions and runner", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-file-batch-canonical-"))
  await fs.chmod(root, 0o700)
  await Promise.all(["home", "tmp", "project", "config", "data", "cache", "state", "install"]
    .map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const repository = path.resolve(import.meta.dir, "../../../..")
  // Give this physical UI cohort a distinct application identity so native app
  // selection cannot target another concurrent Electron test or its default app.
  const originalApp = await fs.realpath(path.join(repository, "packages/desktop/node_modules/electron/dist/Electron.app"))
  const privateApp = path.join(root, "File Exchange QA.app")
  const copy = Bun.spawn(["/bin/cp", "-cR", originalApp, privateApp], { stdout: "pipe", stderr: "pipe" })
  expect(await copy.exited, await new Response(copy.stderr).text()).toBe(0)
  for (const [key, value] of [["CFBundleIdentifier", `ai.deepagent-code.qa.file.${path.basename(root).toLowerCase()}`],
    ["CFBundleName", "DAC File Exchange QA"]]) {
    const edit = Bun.spawn(["/usr/libexec/PlistBuddy", "-c", `Set :${key} ${value}`, path.join(privateApp, "Contents/Info.plist")],
      { stdout: "pipe", stderr: "pipe" })
    expect(await edit.exited, await new Response(edit.stderr).text()).toBe(0)
  }
  await fs.symlink(path.join(repository, "packages/desktop/node_modules"), path.join(root, "install/node_modules"), "dir")
  const bin = path.join(root, "home/.deepagent/code/cache/bin")
  await fs.mkdir(bin, { recursive: true, mode: 0o700 })
  const rg = Bun.which("rg"); expect(rg).not.toBeNull()
  await fs.copyFile(rg!, path.join(bin, "rg"))
  const helper = await buildWorkFileHelper({ os: process.platform, arch: process.arch, destination: path.join(root, "install") })
  const cleanup = await buildWorkStorageCleanup({ os: process.platform, arch: process.arch, destination: path.join(root, "install") })
  // This private publisher key is generated in memory; only its public pin enters the real build.
  const pair = generateKeyPairSync("ed25519")
  const prior = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY
  process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const defines = await nativeNodeDefines({ repository, destination: path.join(root, "install"), helper, assets: [cleanup] })
    .finally(() => { if (prior === undefined) delete process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY
      if (prior !== undefined) process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = prior })
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-file-batch-canonical.ts")],
    outdir: path.join(root, "install"), target: "node", external: ["electron"], naming: "main.mjs", sourcemap: "external",
    define: await managedBrowserInputFixtureDefine(path.join(root, "install")) })
  const child = await Bun.build({ entrypoints: [path.join(repository, "packages/deepagent-code/test/browser/fixture/native-file-batch-canonical-child.ts")],
    outdir: path.join(root, "install"), target: "node", external: ["electron", "jsonc-parser", "@lydell/node-pty", "bun"],
    naming: "node.js", sourcemap: "external", define: { DEEPAGENT_CODE_VERSION: '"2.0.3-file-canonical-dev"',
      DEEPAGENT_CODE_CHANNEL: '"dev"', ...defines }, files: { "deepagent-code-web-ui.gen.ts": "" } })
  expect(main.logs).toEqual([]); expect(child.logs).toEqual([]); expect(main.success && child.success).toBe(true)
  const sources = new Map<string, string>()
  for (const build of [main, child]) {
    const map = build.outputs.find((output) => output.path.endsWith(".map"))!
    const parsed = await Bun.file(map.path).json() as { sources: string[]; sourcesContent: Array<string | null> }
    parsed.sources.forEach((source, ordinal) => {
      const filename = path.resolve(path.dirname(map.path), source)
      const bytes = parsed.sourcesContent[ordinal]
      if (filename.startsWith(repository + "/packages/") && !filename.includes("/node_modules/") && bytes !== null && bytes !== undefined)
        sources.set(filename, createHash("sha256").update(bytes).digest("hex"))
    })
  }
  const captured = await Promise.all([...sources].map(async ([filename, sha256]) => ({ path: path.relative(repository, filename),
    sha256, current: createHash("sha256").update(await fs.readFile(filename)).digest("hex") })))
  expect(captured.filter((source) => source.sha256 !== source.current)).toEqual([])
  await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ boundary: "actual sourcesContent at build; not final release",
    checked: captured.length, drift: [], sources: captured }, null, 2), { mode: 0o600 })
  const electron = await fs.realpath(path.join(privateApp, "Contents/MacOS/Electron"))
  const runtime = await fs.realpath(path.join(path.dirname(electron), "../Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"))
  await signNativeNodeArtifact({ module: path.join(root, "install/node.js"), runtime,
    releaseID: "dac-private-file-canonical-module", privateKey: pair.privateKey })
  console.log("FILE_BATCH_CANONICAL_ROOT", root)
  const log = await fs.open(path.join(root, "process-private.log"), "wx", 0o600)
  const childProcess = Bun.spawn([electron, path.join(root, "install/main.mjs")], { cwd: root,
    env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
      XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
      DAC_BROWSER_TEST_ROOT: root, DAC_BROWSER_CHILD: path.join(root, "install/node.js"),
      ...(downloadOnly ? { DAC_BROWSER_FILE_BATCH_DIRECTION: "download" } : {}) }, stdout: log.fd, stderr: log.fd })
  const timer = setTimeout(() => childProcess.kill(), 230_000)
  const code = await childProcess.exited
  clearTimeout(timer); await log.close()
  const mainResult = await Bun.file(path.join(root, "main-result.json")).json()
  const childResult = await Bun.file(path.join(root, "child-result.json")).json()
  expect(code, childResult.error).toBe(0)
  expect(childResult.stage).toBe("complete")
  expect(childResult.permissions.filter((permission: { action: string }) => permission.action === "browser-file")).toHaveLength(downloadOnly ? 1 : 2)
  expect(mainResult.providerCalls).toHaveLength(downloadOnly ? 5 : 10)
  expect(mainResult.requests.filter((request: { method: string }) => request.method === "POST")).toHaveLength(downloadOnly ? 0 : 1)
  expect(mainResult.requests.filter((request: { url: string }) => request.url === "/download")).toHaveLength(1)
  expect(mainResult.pending).toEqual(downloadOnly
    ? [{ direction: "download", uploads: 0, downloads: 0 }]
    : [{ direction: "upload", uploads: 0, downloads: 0 }, { direction: "download", uploads: 1, downloads: 0 }])
  expect(childResult.facts.work).toHaveLength(0); expect(childResult.facts.counts).toHaveLength(0)
  expect(childResult.facts.saved).toHaveLength(0)
  expect(childResult.facts.inputs).toHaveLength(downloadOnly ? 1 : 2); expect(childResult.facts.admissions).toHaveLength(downloadOnly ? 4 : 8)
  expect(childResult.facts.effects).toHaveLength(downloadOnly ? 4 : 8)
  expect(childResult.facts.actions.every((action: { outcome: string }) => action.outcome === "completed")).toBe(true)
  expect(childResult.controls.every((control: { stopConfirmed: boolean }) => control.stopConfirmed)).toBe(true)
  expect(mainResult.cleanup.windows).toBe(0); expect(mainResult.cleanup.sockets).toBe(0)
}, 250_000)
