import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const actual = process.env.DAC_SHARED_BROWSER_ACTUAL === "1" ? test : test.skip

async function runFixture(mode: "ipc" | "initialization" | "public-tls" | "tui" | "projection" | "file-owner" = "ipc") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-shared-browser-ipc-")))
  await fs.chmod(root, 0o700)
  await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
  const sources = ["shared-browser.ts", "shared-browser-ipc.ts", "shared-browser-network.ts", "shared-browser-driver.ts",
    "shared-browser-transport.ts", "shared-browser-proxy.ts", "managed-browser-actions.ts", "fixture/shared-browser-ipc.ts",
    "shared-browser-tui.ts", "shared-browser-ipc.test.ts", "../preload/index.ts", "../preload/types.ts", "../../../core/src/browser/shared-platform.ts"]
  await fs.writeFile(path.join(root, "source-hashes.json"), JSON.stringify(Object.fromEntries(await Promise.all(sources.map(async (file) =>
    [file, new Bun.CryptoHasher("sha256").update(await fs.readFile(path.join(import.meta.dir, file))).digest("hex")]))), null, 2), { mode: 0o600 })
  const builds = await Promise.all([
    Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/shared-browser-ipc.ts")], target: "node", splitting: true,
      conditions: ["node"], external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"], outdir: root, naming: "main.mjs" }),
    Bun.build({ entrypoints: [path.join(import.meta.dir, "../preload/index.ts")], target: "node", format: "cjs",
      external: ["electron"], outdir: root, naming: "preload.cjs" }),
  ])
  for (const build of builds) expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root, XDG_CACHE_HOME: root, DAC_SHARED_BROWSER_IPC_ROOT: root,
      DAC_SHARED_BROWSER_INITIALIZATION_ONLY: mode === "initialization" ? "1" : "0",
      DAC_SHARED_BROWSER_PUBLIC_TLS_ONLY: mode === "public-tls" ? "1" : "0",
      DAC_SHARED_BROWSER_TUI_ONLY: mode === "tui" ? "1" : "0",
      DAC_SHARED_BROWSER_PROJECTION_ONLY: mode === "projection" ? "1" : "0",
      DAC_SHARED_BROWSER_FILE_OWNER_ONLY: mode === "file-owner" ? "1" : "0",
      DAC_SHARED_BROWSER_PUBLIC_RESOLVER: process.env.DAC_SHARED_BROWSER_PUBLIC_RESOLVER === "alidns_doh_v1" ? "alidns_doh_v1" : "system" },
    stdout: "pipe", stderr: "pipe", timeout: 35_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  console.log("SHARED_BROWSER_IPC_EVIDENCE", root)
  const failure = await Bun.file(path.join(root, "failure.json")).exists() ? await Bun.file(path.join(root, "failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  return Bun.file(path.join(root, "result.json")).json()
}

actual("actual Electron file confirmation uses only the subscribed DAC root window and preserves cancellation", async () => {
  const result = await runFixture("file-owner")
  expect(result.mode).toBe("file-confirm-owner")
  expect(result.productionPreload).toBe(true)
  expect(result.productionIpc).toBe(true)
  expect(result.unsubscribedDenied).toBe(true)
  expect(result.foreignVisibleWindowDenied).toBe(true)
  expect(result.wrongSessionDenied).toBe(true)
  expect(result.retiredOwnerDenied).toBe(true)
  expect(result.nativeDialogCalls).toBe(1)
  expect(result.nativeDialogParent).toBe(result.registeredRootWindow)
  expect(result.nativeDialogParent).not.toBe(result.agentPageWindow)
  expect(result.rootSheetEvents).toBe(process.platform === "darwin" ? 1 : 0)
  expect(result.agentShowEvents).toBe(0)
  expect(result.agentPageWasHidden).toBe(true)
  expect(result.confirmationCancelled).toBe(true)
  expect(result.grantsIssued).toBe(0)
  expect(result.transfers).toBe(0)
  expect(result.closed.resourceAlive).toBe(false)
  expect(result.closed.transportStopped).toBe(true)
  expect(result.providerCalls).toBe(0)
}, 45_000)

actual("actual Electron shared IPC preserves durable closed resources across Main incarnations without hiding lost resources", async () => {
  const result = await runFixture("projection")
  expect(result.mode).toBe("durable-projection")
  expect(result.productionPreload).toBe(true)
  expect(result.productionIpc).toBe(true)
  expect(result.closedPreserved).toBe(true)
  expect(result.states).toEqual(["closed", "closed", "resource_lost", "resource_lost"])
  expect(result.oldBlockedFenced).toBe(true)
  expect(result.authenticatedLists).toBe(1)
  expect(result.managedPagesCreated).toBe(0)
  expect(result.providerCalls).toBe(0)
}, 45_000)

actual("actual Electron TUI pairing requires the registered window and preserves only sealed exact retries after retirement", async () => {
  const result = await runFixture("tui")
  expect(result.mode).toBe("tui-pairing")
  expect(result.productionPreload).toBe(true)
  expect(result.productionIpc).toBe(true)
  expect(result.approvedByRegisteredWindow).toBe(true)
  expect(result.unapprovedRejected).toBe(true)
  expect(result.foreignWindowRejected).toBe(true)
  expect(result.wrongApprovalFieldsRejected).toBe(4)
  expect(result.wrongSecretRejected).toBe(true)
  expect(result.changedStreamRejected).toBe(true)
  expect(result.staleDisconnectIgnored).toBe(true)
  expect(result.sourceKind).toBe("tui_owner")
  expect(result.sealedValidated).toBe(true)
  expect(result.barrierOrder).toBeGreaterThan(result.originalOrder)
  expect(result.oldBarrierRejected).toBe(true)
  expect(result.rootGenerationRetired).toBe(true)
  expect(result.lateUnsealedRejected).toBe(true)
  expect(result.sealedExactRetryPreserved).toBe(true)
  expect(result.pendingCapacity).toBe(16)
  expect(result.closed.resourceAlive).toBe(false)
  expect(result.closed.transportStopped).toBe(true)
  expect(result.providerCalls).toBe(0)
  expect(result.actualTtyAcceptance).toBe(false)
  expect(result.productionSqlAdmissionAcceptance).toBe(false)
  expect(result.physicalUserClickAcceptance).toBe(false)
}, 45_000)

actual("actual Electron production preload fences foreign windows and old bridge generations without losing the shared page", async () => {
  const result = await runFixture()
  expect(result.electron).toBe("41.10.6")
  expect(result.productionPreload).toBe(true)
  expect(result.productionIpc).toBe(true)
  expect(result.sameOriginUnregisteredWindowRejected).toBe(true)
  expect(result.lateResponseRejected).toBe(true)
  expect(result.oldDetachPreservedNewGeneration).toBe(true)
  expect(result.oldUnsealedRetired).toBe(true)
  expect(result.sealedRetained).toBe(true)
  expect(result.navigationRetiredOldGeneration).toBe(true)
  expect(result.resourceAndLeasePreserved).toBe(true)
  expect(result.elapsedBefore).toBeGreaterThanOrEqual(0)
  expect(result.elapsedAfter).toBeGreaterThanOrEqual(result.elapsedBefore)
  expect(result.requests.authenticatedLists).toBe(4)
  expect(result.requests.rejectedAuthentication).toBe(0)
  expect(result.closed.resourceAlive).toBe(false)
  expect(result.closed.transportStopped).toBe(true)
  expect(result.providerCalls).toBe(0)
  expect(result.nativeUserInteractionAcceptance).toBe(false)
  expect(result.productionProviderSelectionAcceptance).toBe(false)
}, 45_000)

actual("actual Electron shared network initialization retains cleanup custody and reservation until the proxy closes", async () => {
  const result = await runFixture("initialization")
  expect(result.mode).toBe("initialization-only")
  expect(result.electron).toBe("41.10.6")
  expect(result.rows).toHaveLength(2)
  expect(result.rows[0].stage).toBe("set-proxy")
  expect(result.rows[0].closed).toBe(true)
  expect(result.rows[0].proxyListenerClosed).toBe(true)
  expect(result.rows[0].cleanupCalls).toBe(1)
  expect(result.rows[1].stage).toBe("close-connections")
  expect(result.rows[1].cleanupRetainedReservation).toBe(true)
  expect(result.rows[1].closed).toBe(true)
  expect(result.rows[1].proxyListenerClosed).toBe(true)
  expect(result.rows[1].cleanupCalls).toBe(3)
  expect(result.rows.every((row: { windows: number }) => row.windows === 0)).toBe(true)
  expect(result.providerCalls).toBe(0)
  expect(result.networkInitializationFaultInjection).toBe(true)
  expect(result.originalDatabaseRead).toBe(false)
  expect(result.physicalInputAcceptance).toBe(false)
}, 45_000)

actual("actual Electron shared browser makes one bounded public HTTPS navigation with normal TLS verification", async () => {
  const result = await runFixture("public-tls")
  expect(result.mode).toBe("public-tls-only")
  expect(result.electron).toBe("41.10.6")
  expect(result.url).toBe("https://example.com/")
  expect(result.text).toContain("Example Domain")
  expect(result.resolverPolicy).toBe(process.env.DAC_SHARED_BROWSER_PUBLIC_RESOLVER === "alidns_doh_v1" ? "alidns_doh_v1" : "system")
  expect(result.nativeTlsVerification).toBe(true)
  expect(result.authentication).toBe("none")
  expect(result.navigationActions).toBe(1)
  expect(result.closed.resourceAlive).toBe(false)
  expect(result.closed.transportStopped).toBe(true)
  expect(result.modelCalls).toBe(0)
  expect(result.physicalInputAcceptance).toBe(false)
  expect(result.dohAdapterAcceptance).toBe(process.env.DAC_SHARED_BROWSER_PUBLIC_RESOLVER === "alidns_doh_v1" ? "alidns_doh_v1-only" : "not-exercised")
  expect(result.productionProviderSelectionAcceptance).toBe(false)
}, 45_000)
