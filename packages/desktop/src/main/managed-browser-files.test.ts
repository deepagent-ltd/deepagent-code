import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { createManagedBrowserActions } from "./managed-browser-actions"
import { createManagedBrowserFiles } from "./managed-browser-files"

test("Main file leaf: concurrent close joins delayed cleanup of the actual private stage", async () => {
  const bytes = Buffer.from("private stage")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const now = Date.now()
  const scope: BrowserSchema.Scope = { principal: "test", securityNamespaceID: "test", namespaceBindingHash: digest,
    locationKey: "test", projectScopeKey: "test", projectID: "test", sessionID: "test", directory: "/test", workspaceID: null }
  const control: BrowserSchema.Control = { version: 1, controlID: "test", requestID: "test", requestDigest: digest, scope,
    hostID: "test", hostIncarnation: "test", resourceID: "test", credentialBinding: digest, profile: BrowserSchema.FILE_EXCHANGE_PROFILE,
    origin: "http://127.0.0.1:34567", postPaths: ["/upload"], filePolicy: { upload: true, download: true },
    revision: 1, epoch: 1, policyRevision: 1, state: "active", expiresAt: now + 30000, createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null }
  const action: BrowserSchema.Action = { version: 1, actionID: "test", controlID: "test", requestID: "test", commandDigest: digest,
    command: { type: "file.upload", tabID: "test", generation: 1, frameID: "test", observationRevision: 1, ref: "test", grantIDs: ["test"] },
    admissionID: "test", providerReceiptID: "test", providerAttemptID: "test", toolCallID: "test", sessionID: "test", hostIncarnation: "test",
    resourceID: "test", controlEpoch: 1, policyRevision: 1, revision: 1, deadline: now + 30000, outcome: "pending", result: null,
    errorCode: null, createdAt: now, updatedAt: now, terminalAt: null, stopConfirmedAt: null }
  // Controlled leaf inputs exercise Main cleanup only; they assert no Native grant or disclosure.
  const preview: BrowserFileSchema.Preview = { version: 1, instanceID: "test", controlID: "test", controlHash: digest, scopeHash: digest,
    helperHash: digest, rootIdentity: { kind: "posix", device: "1", inode: "1" }, relative: "source.bin", name: "source.bin", observedAt: now,
    direction: "upload", targetPath: "/upload", fileIdentity: { kind: "posix", device: "1", inode: "2" }, bytes: bytes.length, sha256: digest }
  const grant: BrowserFileSchema.Grant = { version: 1, grantID: "test", controlID: "test", resourceID: "test", hostIncarnation: "test",
    controlEpoch: 1, policyRevision: 1, scopeHash: digest, instanceID: "test", command: { requestID: "test", previewID: "test", expectedControlRevision: 1, expiresAt: now + 30000 },
    commandHash: digest, preview, confirmation: { previewHash: digest, commandHash: digest, confirmationHash: digest, confirmedAt: now }, expiresAt: now + 30000, createdAt: now }
  const artifact: BrowserFileSchema.Artifact = { version: 1, artifactID: "test", instanceID: "test", grantID: "test", grantHash: digest,
    actionID: "test", admissionID: "test", providerReceiptID: "test", providerAttemptID: "test", toolCallID: "test", sessionID: "test",
    controlID: "test", resourceID: "test", hostIncarnation: "test", controlEpoch: 1, policyRevision: 1, scopeHash: digest, ordinal: 0,
    manifest: preview, state: "reserved", revision: 1, reservedBytes: 1024, publication: null, stopConfirmedAt: null, releasedAt: null, createdAt: now, updatedAt: now }
  const selected = Promise.withResolvers<string>()
  const selection = Promise.withResolvers<void>()
  const cleaning = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<boolean>()
  const facts = { settled: 0, submitted: 0, destroyed: 0 }
  const fail = (code: BrowserSchema.Error["code"]): never => { throw new Error(code) }
  const original = createManagedBrowserActions({ send: async () => { throw new Error("No CDP dispatch in cleanup oracle") }, current: async () => {}, generation: () => 1, fail, dispatched: () => {} })
  const files = createManagedBrowserFiles({ action, control, files: [{ grant, artifact }], current: async () => {}, fail,
    actions: { ...original, fileTarget: async () => ({ direction: "upload", multiple: false, targetPath: "/upload", field: "asset" }),
      selectFiles: async (_command, stage) => { selected.resolve(stage[0]!.path); await selection.promise },
      submitFiles: async () => { facts.submitted++ }, clearFiles: async () => { cleaning.resolve(); return cleaned.promise } },
    ask: async (leaf) => ({ type: "file.leaf.response", id: "test", ...(leaf.operation === "upload.read" ? { payload: bytes.toString("base64") } : {}) }),
    destroyTarget: async () => { facts.destroyed++; return false } })
  const run = files.run().then(() => "completed", (error: Error) => error.message)
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
  expect(await fs.lstat(stage).then(() => true, () => false)).toBe(false)
  expect(await fs.lstat(path.dirname(stage)).then(() => true, () => false)).toBe(false)
  expect(facts.destroyed).toBe(1)
  selection.resolve()
  expect(await run).toBe("BROWSER_CANCELLED")
  expect(facts.submitted).toBe(0)
}, 5000)

const actual = process.env.DAC_BROWSER_FILES_ACTUAL === "1" ? test : test.skip

actual("physical installed browser file module: original Main confirmation, once upload/download and known custody", async () => {
  const request = process.env.DAC_BROWSER_FILES_BUILD_READY
  if (!request) throw new Error("A physical signed module build receipt is required")
  const ready = await Bun.file(request).json() as { module: string; main: string; root: string; fixtureSHA: string; mainFixtureSHA: string }
  const source = path.join(import.meta.dir, "fixture/managed-browser-files.ts")
  const digest = new Bun.CryptoHasher("sha256").update(await fs.readFile(source)).digest("hex")
  expect(ready.fixtureSHA).toBe(digest)
  expect(path.isAbsolute(ready.module)).toBe(true)
  expect(ready.mainFixtureSHA).toBe(new Bun.CryptoHasher("sha256").update(await fs.readFile(path.join(import.meta.dir, "fixture/managed-browser-files-main.ts"))).digest("hex"))
  expect(path.isAbsolute(ready.main)).toBe(true)
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-files-physical-"))
  await fs.chmod(root, 0o700)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), ready.main], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root, DAC_BROWSER_FILES_ROOT: root, DAC_BROWSER_FILES_MODULE: ready.module }, stdout: "pipe", stderr: "pipe", timeout: 190_000,
  })
  console.log("FILES_PHYSICAL_ROOT", root)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(code, result.stderr || stderr).toBe(0)
  expect(result.code).toBe(0)
  expect(result.result.actualInstalled).toBe(true)
  expect(result.result.controlledAdmission).toBe(true)
  expect(result.result.node).toBe("24.18.0")
  expect(result.result.electron).toBe("41.10.3")
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
}, 200_000)
