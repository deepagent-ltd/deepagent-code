import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { prepareSharedBrowserComputationAsset } from "../../scripts/shared-browser-compute-assets"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { createSharedBrowserWitnessBudget } from "./shared-browser-driver"

test("shared witness budget is one bounded resource across tabs and retired observations", () => {
  const budget = createSharedBrowserWitnessBudget()
  const first = budget.open()
  const second = budget.open()
  const frame = budget.open()
  const encoded = "x".repeat(SharedBrowserSchema.MAX_WITNESS_BYTES)
  expect(Array.from({ length: SharedBrowserSchema.MAX_SNAPSHOT_TARGETS }, (_, i) =>
    (i < 250 ? first : second).set(String(i), encoded)).every(Boolean)).toBe(true)
  expect(budget.bytes).toBe(SharedBrowserSchema.MAX_RESOURCE_WITNESS_BYTES)
  expect(frame.set("new-frame-ref", "x")).toBe(false)
  expect(frame.get("new-frame-ref")).toBeUndefined()
  expect(first.set("0", encoded + "x")).toBe(false)
  expect(first.get("0")).toBe(encoded)
  first.clear()
  first.clear()
  expect(budget.bytes).toBe(256_000)
  expect(frame.set("utf8-ref", "中".repeat(341) + "x")).toBe(true)
  expect(frame.set("too-large", "中".repeat(342))).toBe(false)
  expect(budget.bytes).toBe(257_024)
  expect(second.set("250", "x")).toBe(true)
  expect(budget.bytes).toBe(256_001)
  const independent = createSharedBrowserWitnessBudget().open()
  expect(independent.set("different-resource", encoded)).toBe(true)
  second.clear()
  frame.clear()
  expect(budget.bytes).toBe(0)
  expect(first.set("fresh-observation", encoded)).toBe(true)
  first.clear()
  expect(budget.bytes).toBe(0)
})

const actual = process.env.DAC_SHARED_BROWSER_ACTUAL === "1" ? test : test.skip

actual(
  "actual Main manager file upload traces the original multipart and current gates",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-shared-manager-file-")))
    await fs.chmod(root, 0o700)
    await fs.symlink(
      path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"),
      path.join(root, "node_modules"),
      "dir",
    )
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/shared-browser-file-manager.ts")],
      target: "node",
      conditions: ["node"],
      external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"],
      outdir: root,
      naming: "main.mjs",
      plugins: [
        {
          name: "transparent-file-stage-observation",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/managed-browser-files$/ }, (args) =>
              args.importer.endsWith("/shared-browser.ts")
                ? { path: path.join(import.meta.dir, "fixture/shared-browser-file-observer.ts") }
                : undefined,
            )
          },
        },
      ],
    })
    expect(build.success, build.logs.map(String).join("\n")).toBe(true)
    const child = Bun.spawn(
      [path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          DEEPAGENT_CODE_TEST_HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          XDG_CACHE_HOME: root,
          DAC_SHARED_FILE_MANAGER_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 25_000,
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
    console.log("SHARED_MANAGER_FILE_EVIDENCE", root)
    expect(code, stderr.slice(-2000)).toBe(0)
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(
      result.facts.outcome,
      JSON.stringify({ facts: result.facts, fileStages: result.fileStages, trace: result.trace.slice(-20) }),
    ).toBe("completed")
    expect(result.facts.post).toBe(1)
    expect(result.facts.read).toBe(1)
    expect(result.facts.seal).toBe(1)
    expect(result.facts.observe).toBe(1)
    expect(result.closed.resourceAlive).toBe(false)
  },
  30_000,
)

async function runFixture(
  postOnly = false,
  capacityOnly = false,
  framesOnly = false,
  downloadsOnly = false,
  scriptOnly = false,
  fileConfirmOnly = false,
  programOnly = false,
  fileCancelOnly = false,
  policyOnly = false,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-shared-browser-")))
  await fs.chmod(root, 0o700)
  await fs.symlink(
    path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"),
    path.join(root, "node_modules"),
    "dir",
  )
  const sources = [
    "shared-browser.ts",
    "shared-browser-network.ts",
    "shared-browser-driver.ts",
    "shared-browser-transport.ts",
    "shared-browser-proxy.ts",
    "shared-browser-manual-download.ts",
    "shared-browser-compute.ts",
    "shared-browser-compute-worker.ts",
    "shared-browser-compute-asset.ts",
    "managed-browser-actions.ts",
    "fixture/shared-browser.ts",
    "shared-browser.test.ts",
  ]
  await fs.writeFile(
    path.join(root, "source-hashes.json"),
    JSON.stringify(
      Object.fromEntries(
        await Promise.all(
          sources.map(async (file) => [
            file,
            new Bun.CryptoHasher("sha256").update(await fs.readFile(path.join(import.meta.dir, file))).digest("hex"),
          ]),
        ),
      ),
      null,
      2,
    ),
    { mode: 0o600 },
  )
  const computation =
    scriptOnly || programOnly
      ? await prepareSharedBrowserComputationAsset(path.join(root, "shared-browser-compute"))
      : undefined
  const build = await Bun.build({
    define: { __DAC_SHARED_BROWSER_COMPUTE_ASSET__: computation ? JSON.stringify(computation) : "undefined" },
    entrypoints: [path.join(import.meta.dir, "fixture/shared-browser.ts")],
    target: "node",
    splitting: true,
    conditions: ["node"],
    external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"],
    outdir: root,
    naming: "main.mjs",
  })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const child = Bun.spawn(
    [path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        XDG_CACHE_HOME: root,
        DAC_SHARED_BROWSER_ROOT: root,
        DAC_SHARED_BROWSER_POST_ONLY: postOnly ? "1" : "0",
        DAC_SHARED_BROWSER_POLICY_ONLY: policyOnly ? "1" : "0",
        DAC_SHARED_BROWSER_CAPACITY_ONLY: capacityOnly ? "1" : "0",
        DAC_SHARED_BROWSER_FRAMES_ONLY: framesOnly ? "1" : "0",
        DAC_SHARED_BROWSER_DOWNLOADS_ONLY: downloadsOnly ? "1" : "0",
        DAC_SHARED_BROWSER_FILE_CONFIRM_ONLY: fileConfirmOnly ? "1" : "0",
        DAC_SHARED_BROWSER_FILE_CANCEL_ONLY: fileCancelOnly ? "1" : "0",
        DAC_SHARED_BROWSER_PROGRAM_ONLY: programOnly ? "1" : "0",
        DAC_SHARED_BROWSER_SCRIPT_ONLY: scriptOnly ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 35_000,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  console.log("SHARED_BROWSER_MAIN_EVIDENCE", root)
  const failure = (await Bun.file(path.join(root, "failure.json")).exists())
    ? await Bun.file(path.join(root, "failure.json")).json()
    : (await Bun.file(path.join(root, "stage.json")).exists())
      ? await Bun.file(path.join(root, "stage.json")).json()
      : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  return Bun.file(path.join(root, "result.json")).json()
}

actual(
  "actual Electron file Cancel response establishes only an exact settled negative decision",
  async () => {
    const result = await runFixture(false, false, false, false, false, false, false, true)
    expect(result.mode).toBe("file-cancel-decision")
    expect(result.cancelled.kind).toBe("cancelled")
    expect(result.exactSingleDialog).toBe(true)
    expect(result.pendingUnknown).toBe(true)
    expect(result.missingUnknown).toBe(true)
    expect(result.positiveUnchanged).toBe(true)
    expect(result.ownerLossUnknown).toBe(true)
    expect(result.responseLossUnknown).toBe(true)
    expect(result.abortUnknown).toBe(true)
    expect(result.retiredLeaseNegativeReadable).toBe(true)
    expect(result.physicalCancelAcceptance).toBe(false)
    expect(result.grantsIssued).toBe(0)
    expect(result.transfers).toBe(0)
    expect(result.providerCalls).toBe(0)
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
  },
  45_000,
)

actual(
  "actual Electron shared program validates complete plans and retains only exact private cursor changes",
  async () => {
    const result = await runFixture(false, false, false, false, false, false, true)
    expect(result.mode).toBe("shared-program")
    expect(result.preflightCode).toBe("BROWSER_STALE_TARGET")
    expect(result.preflightValue).toBe("initial")
    expect(result.driftCode).toBe("BROWSER_UNKNOWN")
    expect(result.driftValues).toEqual(["program value", "unexpected"])
    expect(result.interruptedCode).toBe("BROWSER_UNKNOWN")
    expect(result.interruptedValues).toEqual(["stop-after-first", "untouched"])
    expect(result.program).toMatchObject({
      version: 1,
      totalSteps: 4,
      completedSteps: 4,
      steps: [
        { ordinal: 0, operation: "fill" },
        { ordinal: 1, operation: "select" },
        { ordinal: 2, operation: "fill" },
        { ordinal: 3, operation: "click" },
      ],
    })
    expect(result.program.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.submissions).toEqual([
      {
        path: "/program-submit",
        method: "POST",
        cookie: "shared=program-owned",
        contentType: "application/x-www-form-urlencoded",
        body: "name=program+value&choice=b",
      },
    ])
    expect(result.samePartition).toBe(true)
    expect(result.context).toBe("snapshot-json-v1")
    expect(result.closeStates).toEqual(["closing", "closed"])
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
    expect(result.providerCalls).toBe(0)
  },
  45_000,
)

actual(
  "actual Electron snapshot-json evaluation cannot reach the shared page and is cancelled by takeover",
  async () => {
    const result = await runFixture(false, false, false, false, true)
    expect(result.mode).toBe("snapshot-json")
    expect(result.exactSourceDenied).toBe(true)
    expect(result.exactArgsDenied).toBe(true)
    expect(result.snapshotProtected).toBe(true)
    expect(result.result.node).toBe("undefined/undefined")
    expect(result.result.cookie === "" || result.result.cookie === "denied").toBe(true)
    expect(result.result.storage === null || result.result.storage === "denied").toBe(true)
    expect(result.result.originalDom).toBe(false)
    expect(result.result.opener).toBe(null)
    expect(result.result.echo).toBe("fixture")
    expect(result.rejectedNonJson).toEqual([
      "BROWSER_INVALID_RECORD",
      "BROWSER_INVALID_RECORD",
      "BROWSER_INVALID_RECORD",
      "BROWSER_INVALID_RECORD",
    ])
    expect(result.blockedNetworkRequests).toBe(0)
    expect(result.networkGlobals).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ])
    expect(result.memoryRejected).toBe(true)
    expect(result.deadlineCode).toBe("BROWSER_CANCELLED")
    expect(result.workerExitedBeforeTakeoverCompleted).toBe(true)
    expect(result.workerExitedBeforeCloseCompleted).toBe(true)
    expect(result.evidence).toMatchObject({
      version: 1,
      context: "snapshot-json-v1",
      generation: result.commandGeneration,
    })
    expect(result.evidence.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.cancelledCode).toBe("BROWSER_CANCELLED")
    expect(result.samePageAfterTakeover).toBe(true)
    expect(result.originalSecretsPreserved).toBe(true)
    expect(result.sandboxWindowsAfter).toBe(0)
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
    expect(result.providerCalls).toBe(0)
  },
  45_000,
)

actual(
  "actual Electron manual downloads keep their original item and block acquire until its terminal acknowledgement",
  async () => {
    const result = await runFixture(false, false, false, true)
    expect(result.mode).toBe("manual-downloads")
    expect(result.acceptedOriginalItems).toBe(2)
    expect(result.productionPresetPaths).toBe(0)
    expect(result.productionPausedItems).toBe(0)
    expect(result.busyCode).toBe("BROWSER_CONFLICT")
    expect(result.busyPreservedManual).toBe(true)
    expect(result.userCancelledState).toBe("cancelled")
    expect(result.resumedAfterOriginalDone).toBe(true)
    expect(result.agentDownloadDenied).toBe(true)
    expect(result.closeCancelledOriginalState).toBe("cancelled")
    expect(result.downloadRequests).toBe(3)
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
    expect(result.nativeSaveDialogAcceptance).toBe(false)
    expect(result.productionUserWitnessAcceptance).toBe(false)
    expect(result.providerCalls).toBe(0)
  },
  45_000,
)

actual(
  "actual Electron Main shared resource preserves DOM and cookies through fenced takeover and fresh-lease CDP",
  async () => {
    const result = await runFixture()
    expect(result.electron).toBeTruthy()
    expect(result.preservedWindow).toBe(true)
    expect(result.preservedWebContents).toBe(true)
    expect(result.preservedPartition).toBe(true)
    expect(result.waitingActionCode).toBe("BROWSER_CANCELLED")
    expect(result.privateActionRegistryRejectedUnregistered).toBe(true)
    expect(result.manual.agentAccessFenced).toBe(true)
    expect(result.manual.leaseRevoked).toBe(true)
    expect(result.manual.inputIsolated).toBe(true)
    expect(result.manual.heldReleased).toBe(true)
    expect(result.manual.transportStopped).toBe(true)
    expect(result.manual.manualEnabled).toBe(true)
    expect(result.manualPage.before).toBe("agent-filled")
    expect(result.manualPage.reply.cookie).toBe("shared=fixture-owned")
    expect(result.manualPage.reply.nonce).toBe(result.manualPage.nonce)
    expect(result.freshSnapshotText).toContain("manual-kept")
    expect(result.screenshot.mime).toBe("image/png")
    expect(result.screenshot.bytes).toBeGreaterThan(0)
    expect(result.screenshot.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.stampOrder).toBeGreaterThan(result.barrierOrder)
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
    expect(result.requests.filter((value: { path: string }) => value.path === "/")).toHaveLength(1)
    expect(result.requests.filter((value: { path: string }) => value.path.startsWith("/manual?"))).toHaveLength(1)
    expect(result.requests.every((value: { method: string }) => value.method === "GET")).toBe(true)
    expect(result.providerCalls).toBe(0)
    expect(result.nativeInputAcceptance).toBe(false)
    expect(result.productionWitnessAcceptance).toBe(false)
    expect(result.unsealedInputRejected).toBe(true)
    expect(result.sealedInputValidated).toBe(true)
    expect(result.trace.length).toBeLessThanOrEqual(128)
    expect(result.windows).toBe(0)
  },
  45_000,
)

actual(
  "actual Electron Main POST grants reject readonly borrowing and dispatch one exact form request without 307 reuse",
  async () => {
    const result = await runFixture(true)
    expect(result.mode).toBe("post-only")
    expect(result.borrowed.accepted).toBe(false)
    expect(result.readOnlyBorrowServerPosts).toBe(0)
    expect(result.unregisteredClickServerPosts).toBe(0)
    expect(result.acceptedSnapshot).toContain("POST accepted")
    expect(result.requests.filter((value: { path: string }) => value.path === "/submit")).toEqual([
      {
        path: "/submit",
        cookie: "shared=fixture-owned",
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: "owned=post",
      },
    ])
    expect(result.requests.filter((value: { method: string }) => value.method === "POST")).toHaveLength(2)
    expect(result.requests.filter((value: { path: string }) => value.path === "/redirect307")).toHaveLength(1)
    expect(result.requests.filter((value: { path: string }) => value.path === "/redirect-target")).toHaveLength(0)
    expect(result.redirectCode).toBe("BROWSER_UNKNOWN")
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
    expect(result.providerCalls).toBe(0)
    expect(result.nativeInputAcceptance).toBe(false)
    expect(result.productionWitnessAcceptance).toBe(false)
    expect(result.sameActionDoubleSubmit).toBe("pending-not-exercised")
    expect(result.manualPost).toBe("pending-not-exercised")
    expect(result.windows).toBe(0)
  },
  45_000,
)

actual(
  "actual Electron Main mixed physical capacity retains lost windows and retries held-input cleanup",
  async () => {
    const result = await runFixture(false, true)
    expect(result.mode).toBe("mixed-capacity-held-release")
    expect(result.counts.map((value: { count: number }) => value.count)).toEqual([1, 4, 4, 4, 1, 2, 1, 0])
    expect(result.failedCleanup).toMatchObject({ heldReleased: false, transportStopped: false, manualEnabled: false })
    expect(result.retriedCleanup).toMatchObject({ heldReleased: true, transportStopped: true, manualEnabled: true })
    expect(result.keyEvents).toEqual({ failedKeyUps: 2, keyDownAcks: 1, keyUpAcks: 1, remainingFaults: 0 })
    expect(result.legacyActualCloseAcks).toBe(3)
    expect(result.retiredUnsealedRejected).toBe(true)
    expect(result.priorSealedPreserved).toBe(true)
    expect(result.freshSourceAccepted).toBe(true)
    expect(result.resourceSurvivedSourceRetirement).toBe(true)
    expect(result.elapsedStart).toBeGreaterThanOrEqual(0)
    expect(result.elapsedEnd).toBeGreaterThanOrEqual(result.elapsedStart)
    expect(result.elapsedEnd).toBe(result.elapsedFrozen)
    expect(result.takeoverSameTicket).toBe(true)
    expect(result.failedCleanup.manualEpoch).toBe(result.retriedCleanup.manualEpoch)
    expect(result.failedCleanup.barrierOrder).toBe(result.retriedCleanup.barrierOrder)
    expect(result.firstClosed.resourceAlive).toBe(false)
    expect(result.firstClosed.transportStopped).toBe(true)
    expect(result.secondClosed.resourceAlive).toBe(false)
    expect(result.secondClosed.transportStopped).toBe(true)
    expect(result.providerCalls).toBe(0)
    expect(result.nativeInputAcceptance).toBe(false)
    expect(result.productionWitnessAcceptance).toBe(false)
    expect(result.legacyUtilityAcceptance).toBe(false)
    expect(result.windows).toBe(0)
  },
  45_000,
)

actual(
  "actual Electron Main cross-site OOPIF frames route Unicode fill and offset clicks then revoke old refs",
  async () => {
    const result = await runFixture(false, false, true)
    expect(result.mode).toBe("frames-unicode")
    expect(result.oopif).toBe(true)
    expect(result.frameEvidence.targets.length).toBeGreaterThan(0)
    expect(result.frameEvidence.frames).toHaveLength(2)
    expect(
      result.frameEvidence.commands.some(
        (value: { method: string; sessionID: string | null }) =>
          value.method === "Accessibility.getFullAXTree" && value.sessionID !== null,
      ),
    ).toBe(true)
    expect(result.filledText).toContain("中文输入🙂 — DAC")
    expect(result.childClickedText).toContain("child-click-ok")
    expect(result.rootClickedText).toContain("root-click-ok")
    expect(result.oldChildRefRejected).toBe(true)
    expect(result.manual.manualEnabled).toBe(true)
    expect(result.manual.transportStopped).toBe(true)
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.closed.transportStopped).toBe(true)
    expect(result.sitePerProcessFixture).toBe(true)
    expect(result.physicalIMEAcceptance).toBe(false)
    expect(result.threeOSAcceptance).toBe(false)
    expect(result.productionWitnessAcceptance).toBe(false)
    expect(result.providerCalls).toBe(0)
    expect(result.windows).toBe(0)
  },
  45_000,
)

actual(
  "actual Main shared file confirmation rejects identity drift and joins revoked pending approval without opening a dialog",
  async () => {
    const result = await runFixture(false, false, false, false, false, true)
    expect(result.mode).toBe("file-confirm-current")
    expect(result.exactRetrySamePromise).toBe(true)
    expect(result.identityDriftDenied).toBe(true)
    expect(result.concurrentActionDenied).toBe(true)
    expect(result.latePermitRejected).toBe(true)
    expect(result.manualOnlyAfterConfirmationSettled).toBe(true)
    expect(result.nativePositiveApprovalAcceptance).toBe(false)
    expect(result.closed.resourceAlive).toBe(false)
    expect(result.providerCalls).toBe(0)
  },
  45_000,
)

actual("actual Main manual origin approval commits only its exact trusted request and fresh acquire policy", async () => {
  const result = await runFixture(false, false, false, false, false, false, false, false, true)
  expect(result.mode).toBe("policy-origins")
  expect(result.beforeCommitRequests).toBe(0)
  expect(result.afterCommitRequests).toBe(1)
  expect(result.samePage).toBe(true)
  expect(result.manualOnlyBeforeAcquire).toBe(true)
  expect(result.originalPolicyProjectionDenied).toBe(true)
  expect(result.staleInputDenied).toBe(true)
  expect(result.closed.resourceAlive).toBe(false)
  expect(result.windows).toBe(0)
  expect(result.providerCalls).toBe(0)
}, 45_000)
