import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const actual = process.env.DAC_SHARED_BROWSER_FILE_TRANSPORT_ACTUAL === "1" ? test : test.skip

async function runFixture(mode: "full" | "download-diagnostic" | "download-only") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-shared-file-transport-")))
  await fs.chmod(root, 0o700)
  await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
  const sources = ["managed-browser-files.ts", "managed-browser-actions.ts", "shared-browser-network.ts", "shared-browser-driver.ts",
    "shared-browser-proxy.ts", "shared-browser-transport.ts", "shared-browser-file-transport.test.ts", "fixture/shared-browser-file-transport.ts"]
  await fs.writeFile(path.join(root, "source-hashes.json"), JSON.stringify(Object.fromEntries(await Promise.all(sources.map(async (file) =>
    [file, new Bun.CryptoHasher("sha256").update(await fs.readFile(path.join(import.meta.dir, file))).digest("hex")]))), null, 2), { mode: 0o600 })
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/shared-browser-file-transport.ts")], target: "node",
    splitting: true, conditions: ["node"], external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"], outdir: root, naming: "main.mjs" })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
    cwd: root, env: { PATH: process.env.PATH, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      DAC_SHARED_BROWSER_FILE_TRANSPORT_ROOT: root, DAC_SHARED_BROWSER_FILE_TRANSPORT_MODE: mode },
    stdout: "pipe", stderr: "pipe", timeout: 35_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  console.log("SHARED_FILE_TRANSPORT_EVIDENCE", root)
  const failure = await Bun.file(path.join(root, "failure.json")).exists()
    ? await Bun.file(path.join(root, "failure.json")).json()
    : await Bun.file(path.join(root, "stage.json")).exists() ? await Bun.file(path.join(root, "stage.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  expect(await Bun.file(path.join(root, "result.json")).exists(), failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(true)
  return Bun.file(path.join(root, "result.json")).json()
}

actual("actual Electron shared file transport preserves standard multipart bytes and partition cookies", async () => {
  const result = await runFixture("full")
  expect(result.mode).toBe("shared-file-transport-component")
  expect(result.facts.receivedMultipartHash).toBe(result.facts.checkedMultipartHash)
  expect(result.facts.receivedMultipartBytes).toBe(result.facts.checkedMultipartBytes)
  expect(result.facts.fileBodyHash).toBe(result.sourceHash)
  expect(result.facts.fileBodyBytes).toBe(result.sourceBytes)
  expect(result.facts.submitCalls).toBe(1)
  expect(result.facts.clearCalls).toBe(1)
  expect(result.facts.clearAcks).toBe(1)
  expect(result.facts.cleanupClearCalls).toBe(0)
  expect(result.facts.cleanupClearAcks).toBe(0)
  expect(result.facts.gateClearAcks).toBe(1)
  expect(result.facts.uploadReadCalls).toBe(1)
  expect(result.facts.uploadSeals).toBe(1)
  expect(result.facts.uploadObservations).toBe(1)
  expect(result.facts.downloadWrites).toBeGreaterThan(0)
  expect(result.facts.downloadPublishes).toBe(1)
  expect(result.requests.filter((value: { method: string }) => value.method === "POST")).toHaveLength(1)
  expect(result.requests.filter((value: { path: string }) => value.path === "/download?owned=bytes")).toHaveLength(1)
  expect(result.requests.filter((value: { path: string }) => value.path !== "/").every((value: { cookie: string }) => value.cookie === "shared_file=fixture-owned")).toBe(true)
  expect(result.requests.some((value: { privateHeader: boolean }) => value.privateHeader)).toBe(false)
  expect(result.originalPreserved).toBe(true)
  expect(result.cookieHttpOnly).toBe(true)
  expect(result.uploadStopped).toBe(true)
  expect(result.finalTransportStopped).toBe(true)
  expect(result.windows).toBe(0)
  expect(result.providerCalls).toBe(0)
  expect(result.productionPermissionAcceptance).toBe(false)
  expect(result.nativeFileProofAcceptance).toBe(false)
  expect(result.nativeOsConfirmationAcceptance).toBe(false)
  expect(result.mainManagerImported).toBe(false)
  expect(result.controlledV2Records).toBe(true)
}, 45_000)

actual("actual Electron shared file transport download-only gate diagnostic", async () => {
  const result = await runFixture("download-diagnostic")
  expect(result.diagnosticOnly).toBe(true)
  expect(result.facts.uploadReadCalls).toBe(0)
  expect(result.facts.submitCalls).toBe(0)
  expect(result.requests.filter((value: { method: string }) => value.method === "POST")).toHaveLength(0)
  expect(result.requests.filter((value: { path: string }) => value.path === "/download?owned=bytes")).toHaveLength(1)
  expect(result.requests.find((value: { path: string }) => value.path === "/download?owned=bytes")?.cookie).toBe("shared_file=fixture-owned")
  expect(result.requests.some((value: { privateHeader: boolean }) => value.privateHeader)).toBe(false)
  expect(result.facts.downloadWrites).toBeGreaterThan(0)
  expect(result.facts.downloadPublishes).toBe(1)
  expect(result.originalPreserved).toBe(true)
  expect(result.finalTransportStopped).toBe(true)
  expect(result.windows).toBe(0)
  expect(result.providerCalls).toBe(0)
  expect(result.productionPermissionAcceptance).toBe(false)
  expect(result.nativeFileProofAcceptance).toBe(false)
  expect(result.nativeOsConfirmationAcceptance).toBe(false)
  expect(result.mainManagerImported).toBe(false)
}, 45_000)

actual("actual Electron shared file transport download-only success and held cancellation", async () => {
  const result = await runFixture("download-only")
  expect(result.diagnosticOnly).toBe(false)
  expect(result.downloadOnly).toBe(true)
  expect(result.gates).toHaveLength(0)
  expect(result.facts.uploadReadCalls).toBe(0)
  expect(result.facts.submitCalls).toBe(0)
  expect(result.requests.filter((value: { method: string }) => value.method === "POST")).toHaveLength(0)
  expect(result.requests.filter((value: { path: string }) => value.path === "/download?owned=bytes")).toHaveLength(1)
  expect(result.requests.filter((value: { path: string }) => value.path === "/download?owned=held")).toHaveLength(1)
  expect(result.requests.filter((value: { path: string }) => value.path.startsWith("/download?"))
    .every((value: { cookie: string }) => value.cookie === "shared_file=fixture-owned")).toBe(true)
  expect(result.requests.some((value: { privateHeader: boolean }) => value.privateHeader)).toBe(false)
  expect(result.facts.downloadWrites).toBeGreaterThan(0)
  expect(result.facts.downloadPublishes).toBe(1)
  expect(result.facts.heldWrites).toBeGreaterThan(0)
  expect(result.facts.heldPublishes).toBe(0)
  expect(result.facts.heldRejected).toBe(true)
  expect(result.facts.heldSucceeded).toBe(false)
  expect(result.facts.heldTransportStopped).toBe(true)
  expect(result.facts.heldServerClosed).toBe(true)
  expect(result.facts.heldServerEnded).toBe(false)
  expect(result.facts.heldOriginalPreserved).toBe(true)
  expect(result.originalPreserved).toBe(true)
  expect(result.finalTransportStopped).toBe(true)
  expect(result.windows).toBe(0)
  expect(result.providerCalls).toBe(0)
  expect(result.productionPermissionAcceptance).toBe(false)
  expect(result.nativeFileProofAcceptance).toBe(false)
  expect(result.nativeOsConfirmationAcceptance).toBe(false)
  expect(result.mainManagerImported).toBe(false)
}, 45_000)
