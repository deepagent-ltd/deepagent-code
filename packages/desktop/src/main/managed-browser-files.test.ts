import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import type { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { createManagedBrowserActions } from "./managed-browser-actions"
import { createManagedBrowserFiles } from "./managed-browser-files"

test(process.platform === "win32"
  ? "Main file leaf: missing native stage refuses selection and concurrent close joins delayed cleanup"
  : "Main file leaf: concurrent close joins delayed cleanup of the actual private stage", async () => {
  const bytes = Buffer.from("private stage")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const now = Date.now()
  const scope: BrowserSchema.Scope = {
    principal: "test",
    securityNamespaceID: "test",
    namespaceBindingHash: digest,
    locationKey: "test",
    projectScopeKey: "test",
    projectID: "test",
    sessionID: "test",
    directory: "/test",
    workspaceID: null,
  }
  const control: BrowserSchema.Control = {
    version: 1,
    controlID: "test",
    requestID: "test",
    requestDigest: digest,
    scope,
    hostID: "test",
    hostIncarnation: "test",
    resourceID: "test",
    credentialBinding: digest,
    profile: BrowserSchema.FILE_EXCHANGE_PROFILE,
    origin: "http://127.0.0.1:34567",
    postPaths: ["/upload"],
    filePolicy: { upload: true, download: true },
    revision: 1,
    epoch: 1,
    policyRevision: 1,
    state: "active",
    expiresAt: now + 30000,
    createdAt: now,
    updatedAt: now,
    cancel: null,
    stopConfirmedAt: null,
  }
  const action: BrowserSchema.Action = {
    version: 1,
    actionID: "test",
    controlID: "test",
    requestID: "test",
    commandDigest: digest,
    command: {
      type: "file.upload",
      tabID: "test",
      generation: 1,
      frameID: "test",
      observationRevision: 1,
      ref: "test",
      grantIDs: ["test"],
    },
    admissionID: "test",
    providerReceiptID: "test",
    providerAttemptID: "test",
    toolCallID: "test",
    sessionID: "test",
    hostIncarnation: "test",
    resourceID: "test",
    controlEpoch: 1,
    policyRevision: 1,
    revision: 1,
    deadline: now + 30000,
    outcome: "pending",
    result: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
    stopConfirmedAt: null,
  }
  // Controlled leaf inputs exercise Main cleanup only; they assert no Native grant or disclosure.
  const preview: BrowserFileSchema.Preview = {
    version: 1,
    instanceID: "test",
    controlID: "test",
    controlHash: digest,
    scopeHash: digest,
    helperHash: digest,
    rootIdentity: { kind: "posix", device: "1", inode: "1" },
    relative: "source.bin",
    name: "source.bin",
    observedAt: now,
    direction: "upload",
    targetPath: "/upload",
    fileIdentity: { kind: "posix", device: "1", inode: "2" },
    bytes: bytes.length,
    sha256: digest,
  }
  const grant: BrowserFileSchema.Grant = {
    version: 1,
    grantID: "test",
    controlID: "test",
    resourceID: "test",
    hostIncarnation: "test",
    controlEpoch: 1,
    policyRevision: 1,
    scopeHash: digest,
    instanceID: "test",
    command: { requestID: "test", previewID: "test", expectedControlRevision: 1, expiresAt: now + 30000 },
    commandHash: digest,
    preview,
    confirmation: { previewHash: digest, commandHash: digest, confirmationHash: digest, confirmedAt: now },
    expiresAt: now + 30000,
    createdAt: now,
  }
  const artifact: BrowserFileSchema.Artifact = {
    version: 1,
    artifactID: "test",
    instanceID: "test",
    grantID: "test",
    grantHash: digest,
    actionID: "test",
    admissionID: "test",
    providerReceiptID: "test",
    providerAttemptID: "test",
    toolCallID: "test",
    sessionID: "test",
    controlID: "test",
    resourceID: "test",
    hostIncarnation: "test",
    controlEpoch: 1,
    policyRevision: 1,
    scopeHash: digest,
    ordinal: 0,
    manifest: preview,
    state: "reserved",
    revision: 1,
    reservedBytes: 1024,
    publication: null,
    stopConfirmedAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const selected = Promise.withResolvers<string>()
  const selection = Promise.withResolvers<void>()
  const cleaning = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<boolean>()
  const facts = { settled: 0, selected: 0, submitted: 0, destroyed: 0 }
  const fail = (code: BrowserSchema.Error["code"]): never => {
    throw new Error(code)
  }
  const original = createManagedBrowserActions({
    send: async () => {
      throw new Error("No CDP dispatch in cleanup oracle")
    },
    current: async () => {},
    generation: () => 1,
    fail,
    dispatched: () => {},
  })
  const files = createManagedBrowserFiles({
    action,
    control,
    files: [{ grant, artifact }],
    current: async () => {},
    fail,
    actions: {
      ...original,
      fileTarget: async () => ({ direction: "upload", multiple: false, targetPath: "/upload", field: "asset" }),
      selectFiles: async (_command, stage) => {
        facts.selected++
        selected.resolve(stage[0]!.path)
        await selection.promise
      },
      submitFiles: async () => {
        facts.submitted++
        return true
      },
      clearFiles: async () => {
        cleaning.resolve()
        return cleaned.promise
      },
    },
    ask: async (leaf) => ({
      type: "file.leaf.response",
      id: "test",
      ...(leaf.operation === "upload.read" ? { payload: bytes.toString("base64") } : {}),
    }),
    destroyTarget: async () => {
      facts.destroyed++
      return false
    },
  })
  const run = files.run().then(
    () => "completed",
    (error: Error) => error.message,
  )
  if (process.platform === "win32") {
    // No Native upload.seal descriptor was supplied; a POSIX path cannot stand in for it.
    expect(await run).toBe("BROWSER_UNKNOWN")
    expect(facts.selected).toBe(0)
    expect(facts.submitted).toBe(0)
    const first = files.close()
    await cleaning.promise
    expect(files.close()).toBe(first)
    void first.then(() => facts.settled++)
    await Promise.resolve()
    expect(facts.settled).toBe(0)
    cleaned.resolve(false)
    expect(await first).toBe(false)
    expect(facts.destroyed).toBe(1)
    return
  }
  const stage = await selected.promise
  expect(await fs.readFile(stage)).toEqual(bytes)
  const first = files.close()
  await cleaning.promise
  const second = files.close()
  expect(second).toBe(first)
  void first.then(() => facts.settled++)
  void second.then(() => facts.settled++)
  await Promise.resolve()
  expect(facts.settled).toBe(0)
  expect(await fs.readFile(stage)).toEqual(bytes)
  // Failed target clearing remains false for every caller even though the private file is removed.
  cleaned.resolve(false)
  expect(await first).toBe(false)
  expect(await second).toBe(false)
  expect(
    await fs.lstat(stage).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(
    await fs.lstat(path.dirname(stage)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(facts.destroyed).toBe(1)
  selection.resolve()
  expect(await run).toBe("BROWSER_CANCELLED")
  expect(facts.submitted).toBe(0)
}, 5000)

test("shared file leaf: close joins actual stage allocation and pending selection before releasing custody", async () => {
  const ownedRoot = process.env.DAC_SHARED_FILE_PREPARATION_ROOT
  if (!ownedRoot) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-file-preparation-")))
    await fs.chmod(root, 0o700)
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", "close joins actual stage allocation"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        DAC_SHARED_FILE_PREPARATION_ROOT: root,
        DEEPAGENT_CODE_TEST_HOME: root,
        DEEPAGENT_CODE_HOME: path.join(root, "private-data"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 7000,
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
    console.log("SHARED_FILE_PREPARATION_EVIDENCE", root)
    expect(code, stderr).toBe(0)
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.phases).toEqual(process.platform === "win32" ? ["native-stage-unavailable"] : ["allocation", "selection"])
    expect(result.productionHelper).toBe(true)
    expect(result.nativeProof).toBe(false)
    expect(result.modelCalls).toBe(0)
    expect(result.remainingStages).toEqual([])
    return
  }
  // The child isolates both the storage root and this transparent scheduling
  // wrapper. Real FS operations and the production helper remain unchanged.
  const payload = Buffer.from("owned preparation bytes\n")
  const hash = createHash("sha256").update(payload).digest("hex")
  const origin = "http://127.0.0.1:39872"
  const targetURL = origin + "/upload?owned=preparation"
  const fail = (code: BrowserSchema.Error["code"]): never => {
    throw new Error(code)
  }
  const phaseFacts: Array<{
    phase: string
    closeHeld: boolean
    clearCalls: number
    submitCalls: number
    runError: string
  }> = []
  const phases = process.platform === "win32" ? (["native-stage-unavailable"] as const) : (["allocation", "selection"] as const)
  for (const phase of phases) {
    const now = Date.now()
    const binding: SharedBrowserFileSchema.Binding = {
      kind: "shared-v2",
      resourceID: "controlled-resource",
      rootSessionID: "controlled-session",
      mainIncarnation: "controlled-main",
      sidecarIncarnation: "controlled-sidecar",
      leaseID: "controlled-lease",
      leaseEpoch: 1,
      manualEpoch: 0,
      policyHash: hash,
      scopeHash: hash,
    }
    const preview: SharedBrowserFileSchema.Preview = {
      version: 2,
      binding,
      bindingHash: hash,
      instanceID: "controlled-only",
      scopeHash: hash,
      helperHash: hash,
      rootIdentity: { kind: "posix", device: "1", inode: "1" },
      observedAt: now,
      relative: "owned.bin",
      name: "owned.bin",
      direction: "upload",
      targetURL,
      fileIdentity: { kind: "posix", device: "1", inode: "2" },
      bytes: payload.length,
      sha256: hash,
    }
    const grant: SharedBrowserFileSchema.Grant = {
      version: 2,
      binding,
      bindingHash: hash,
      grantID: "controlled-grant",
      instanceID: "controlled-only",
      scopeHash: hash,
      command: {
        requestID: "controlled-request",
        previewID: "controlled-preview",
        expectedResourceRevision: 1,
        expectedLeaseID: binding.leaseID,
        expectedLeaseEpoch: 1,
        expectedManualEpoch: 0,
        expiresAt: now + 5000,
      },
      commandHash: hash,
      preview,
      confirmation: { previewHash: hash, commandHash: hash, confirmationHash: hash, confirmedAt: now },
      expiresAt: now + 5000,
      createdAt: now,
    }
    const artifact: SharedBrowserFileSchema.Artifact = {
      version: 2,
      binding,
      bindingHash: hash,
      artifactID: "controlled-artifact",
      instanceID: "controlled-only",
      grantID: grant.grantID,
      grantHash: hash,
      actionID: "controlled-action",
      admissionID: "controlled-admission",
      providerReceiptID: "controlled-receipt",
      providerAttemptID: "controlled-attempt",
      toolCallID: "controlled-tool",
      sessionID: binding.rootSessionID,
      scopeHash: hash,
      ordinal: 0,
      manifest: preview,
      state: "reserved",
      revision: 1,
      reservedBytes: payload.length,
      publication: null,
      stopConfirmedAt: null,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    const entered = Promise.withResolvers<string>()
    const release = Promise.withResolvers<void>()
    const facts = { clearCalls: 0, submitCalls: 0, closed: false, selectionAck: false }
    const originalMkdtemp = fs.mkdtemp
    const allocated: string[] = []
    if (phase === "allocation")
      fs.mkdtemp = new Proxy(originalMkdtemp, {
        apply(target, receiver, args) {
          return (Reflect.apply(target, receiver, args) as Promise<string | Buffer>).then(async (directory) => {
            if (
              typeof directory === "string" &&
              directory.startsWith(path.join(ownedRoot, "private-data", "tmp", "dac-browser-file-"))
            ) {
              allocated.push(directory)
              entered.resolve(directory)
              await release.promise
            }
            return directory
          })
        },
      })
    const files = createManagedBrowserFiles({
      action: {
        command: {
          type: "file.upload",
          tabID: "controlled-tab",
          generation: 1,
          frameID: "controlled-frame",
          observationRevision: 1,
          ref: "controlled-ref",
          grantIDs: [grant.grantID],
        },
        deadline: now + 5000,
      },
      shared: {
        origin,
        download: async () => {
          throw new Error("No network in preparation regression")
        },
      },
      files: [{ grant, artifact }],
      current: async () => {},
      fail,
      actions: {
        fileTarget: async () => ({
          direction: "upload",
          targetPath: "/upload",
          targetURL,
          multiple: false,
          field: "asset",
        }),
        selectFiles: async (_command, stage) => {
          if (phase !== "selection") throw new Error("Fenced allocation cannot select files")
          entered.resolve(stage[0]!.path)
          await release.promise
          facts.selectionAck = true
        },
        submitFiles: async () => {
          facts.submitCalls++
          return true
        },
        clearFiles: async () => {
          facts.clearCalls++
          expect(phase !== "selection" || facts.selectionAck).toBe(true)
          return true
        },
      },
      // Controlled approval/selection seams are not Main or Native credentials.
      ask: async (leaf) => ({ ...(leaf.operation === "upload.read" ? { payload: payload.toString("base64") } : {}) }),
    })
    const running = files.run().then(
      () => "unexpected-success",
      (error: Error) => error.message,
    )
    if (phase === "native-stage-unavailable") {
      // A Native stage descriptor is required; this controlled fixture supplies none.
      const error = await running
      expect(error).toBe("BROWSER_UNKNOWN")
      expect(await files.close()).toBe(true)
      expect(facts.submitCalls).toBe(0)
      expect(allocated).toEqual([])
      expect(
        await fs.lstat(path.join(ownedRoot, "private-data", "tmp")).then(
          () => "exists",
          (failure: NodeJS.ErrnoException) => failure.code,
        ),
      ).toBe("ENOENT")
      phaseFacts.push({
        phase,
        closeHeld: false,
        clearCalls: facts.clearCalls,
        submitCalls: facts.submitCalls,
        runError: error,
      })
      continue
    }
    const target = await entered.promise
    try {
      expect(
        phase === "allocation"
          ? (await fs.lstat(target)).isDirectory()
          : await fs.readFile(target).then((value) => value.equals(payload)),
      ).toBe(true)
      files.fence()
      const closing = files.close()
      void closing.then(() => {
        facts.closed = true
      })
      expect(files.close()).toBe(closing)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(facts.closed).toBe(false)
      expect(facts.clearCalls).toBe(0)
      release.resolve()
      const error = await running
      expect(error).toBe("BROWSER_CANCELLED")
      expect(await closing).toBe(true)
      expect(facts.clearCalls).toBe(1)
      expect(facts.submitCalls).toBe(0)
      const stage = phase === "allocation" ? target : path.dirname(target)
      expect(
        await fs.lstat(stage).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      expect(await files.close()).toBe(true)
      phaseFacts.push({
        phase,
        closeHeld: true,
        clearCalls: facts.clearCalls,
        submitCalls: facts.submitCalls,
        runError: error,
      })
    } finally {
      release.resolve()
      fs.mkdtemp = originalMkdtemp
      await running
      await files.close()
    }
    expect(phase !== "allocation" || allocated.length === 1).toBe(true)
  }
  const remaining = process.platform === "win32" ? [] : await fs.readdir(path.join(ownedRoot, "private-data", "tmp"))
  expect(remaining).toEqual([])
  await fs.writeFile(
    path.join(ownedRoot, "result.json"),
    JSON.stringify(
      {
        phases: phaseFacts.map((value) => value.phase),
        phaseFacts,
        productionHelper: true,
        realFilesystem: true,
        controlledSchedulingAndActions: true,
        nativeProof: false,
        modelCalls: 0,
        remainingStages: remaining,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}, 10_000)

const actual = process.env.DAC_BROWSER_FILES_ACTUAL === "1" ? test : test.skip

actual(
  process.env.DAC_BROWSER_FILES_SHARED_UPLOAD_ONLY === "1"
    ? "physical installed shared browser upload diagnoses actual Host current and helper transport"
    : process.env.DAC_BROWSER_FILES_FRESH_SHARED_ONLY === "1"
      ? "physical installed fresh shared browser file preview: explicit authority initializes only the local identity"
      : "physical installed browser file module: original Main confirmation, once upload/download and known custody",
  async () => {
    const request = process.env.DAC_BROWSER_FILES_BUILD_READY
    if (!request) throw new Error("A physical signed module build receipt is required")
    const ready = (await Bun.file(request).json()) as {
      module: string
      main: string
      root: string
      fixtureSHA: string
      mainFixtureSHA: string
    }
    const source = path.join(import.meta.dir, "fixture/managed-browser-files.ts")
    const digest = new Bun.CryptoHasher("sha256").update(await fs.readFile(source)).digest("hex")
    expect(ready.fixtureSHA).toBe(digest)
    expect(path.isAbsolute(ready.module)).toBe(true)
    expect(ready.mainFixtureSHA).toBe(
      new Bun.CryptoHasher("sha256")
        .update(await fs.readFile(path.join(import.meta.dir, "fixture/managed-browser-files-main.ts")))
        .digest("hex"),
    )
    expect(path.isAbsolute(ready.main)).toBe(true)
    const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-files-physical-"))
    await fs.chmod(root, 0o700)
    const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), ready.main], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        XDG_DATA_HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
        DAC_BROWSER_FILES_ROOT: root,
        DAC_BROWSER_FILES_MODULE: ready.module,
        DAC_BROWSER_FILES_FRESH_SHARED_ONLY: process.env.DAC_BROWSER_FILES_FRESH_SHARED_ONLY === "1" ? "1" : "0",
        DAC_BROWSER_FILES_SHARED_UPLOAD_ONLY: process.env.DAC_BROWSER_FILES_SHARED_UPLOAD_ONLY === "1" ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 190_000,
    })
    console.log("FILES_PHYSICAL_ROOT", root)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(code, result.stderr || stderr).toBe(0)
    expect(result.code).toBe(0)
    expect(result.result.actualInstalled).toBe(true)
    if (process.env.DAC_BROWSER_FILES_SHARED_UPLOAD_ONLY === "1") {
      expect(result.result.mode).toBe("shared-upload-diagnostic")
      expect(
        result.result.outcome,
        JSON.stringify({
          error: result.result.error,
          stages: result.fileStages,
          timings: result.result.timings.slice(-10),
        }),
      ).toBe("completed")
      expect(result.facts.uploads).toBe(1)
      expect(result.facts.uploadBytes).toBe(Buffer.byteLength("DAC native owned file fixture\n"))
      expect(result.facts.uploadHash).toBe(createHash("sha256").update("DAC native owned file fixture\n").digest("hex"))
      expect(result.result.selected?.[0]?.state).toBe("selected")
      expect(result.result.controlledProviderAttemptRows).toBe(1)
      expect(result.result.modelRequests).toBe(0)
      expect(result.result.inputs).toBe(1)
      expect(result.result.canonicalAdmissionAndPermissions).toBe(true)
      expect(result.result.currentFailureSnapshots).toEqual([])
      expect(result.result.permissionRefusal).toEqual({
        rejected: true,
        originalGrantsOnly: true,
        retiredLease: true,
        state: "closing",
      })
      expect(result.result.downloaded).toEqual({
        state: "published",
        bytes: Buffer.byteLength("DAC native owned file fixture\n"),
        sha256: createHash("sha256").update("DAC native owned file fixture\n").digest("hex"),
      })
      expect(result.facts.downloads).toBe(1)
      expect(result.facts.controlledNativeDecisions).toBe(3)
      expect(result.facts.permissionRevokedBeforeDecision).toBe(true)
      expect(result.facts.filePermitPassed).toBe(5)
      expect(result.facts.filePermitDenied).toBe(1)
      expect(
        result.driverStages.filter(
          (stage: { method: string; event: string }) =>
            stage.method === "Runtime.releaseObject" && stage.event === "enter",
        ).length,
      ).toBe(
        result.driverStages.filter(
          (stage: { method: string; event: string }) =>
            stage.method === "Runtime.releaseObject" && stage.event !== "enter",
        ).length,
      )
      expect(result.result.closed).toBe("closed")
      expect(result.result.physicalNativeApprovalAcceptance).toBe(false)
      return
    }
    if (process.env.DAC_BROWSER_FILES_FRESH_SHARED_ONLY === "1") {
      expect(result.result.mode).toBe("fresh-shared-preview")
      expect(result.result.node).toBe(managedBrowserInputRuntime.nodeVersion)
      expect(result.result.electron).toBe(managedBrowserInputRuntime.electronVersion)
      expect(result.result.freshIdentityBefore).toBe(true)
      expect(result.result.readsLeaveIdentityAbsent).toBe(true)
      expect(result.result.deniedPreviews).toBe(3)
      expect(result.result.identityFileMode).toBe(0o600)
      expect(result.result.identityDirectoryMode).toBe(0o700)
      expect(result.result.sameInstance).toBe(true)
      expect(result.result.previews).toBe(2)
      expect(result.result.grantCount).toBe(0)
      expect(result.result.operatorCount).toBe(0)
      expect(result.result.closed).toBe("closed")
      expect(result.facts.uploads).toBe(0)
      expect(result.facts.downloads).toBe(0)
      expect(result.facts.nativeConfirmRequests).toEqual([])
      expect(result.result.inputs).toBe(0)
      expect(result.result.providers).toBe(0)
      expect(result.windows).toBe(0)
      return
    }
    expect(result.result.controlledAdmission).toBe(true)
    expect(result.result.node).toBe(managedBrowserInputRuntime.nodeVersion)
    expect(result.result.electron).toBe(managedBrowserInputRuntime.electronVersion)
    expect(result.result.grantCount).toBe(2)
    expect(result.result.artifactCount).toBe(2)
    expect(result.result.selected[0].state).toBe("selected")
    expect(result.result.downloaded[0].state).toBe("published")
    expect(result.result.reservedBytes).toBe(result.result.metadataBytes)
    expect(result.facts.uploads).toBe(1)
    expect(result.facts.downloads).toBe(1)
    expect(result.facts.nativeConfirmRequests).toEqual(["upload", "download"])
    expect(result.result.inputs).toBe(0)
    expect(result.result.providers).toBe(0)
    expect(result.windows).toBe(0)
  },
  200_000,
)
