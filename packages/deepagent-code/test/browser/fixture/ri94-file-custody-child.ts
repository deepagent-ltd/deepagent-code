// Original installed Root, NativeHost, file service and HTTP; hooks only delay original observations.
import { Server, BrowserNativeHost } from "../../../src/node"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { LocalAuthority } from "../../../src/installation/local-authority"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFiles } from "../../../src/browser/file-exchange"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import type { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
const root = process.env.DAC_BROWSER_TEST_ROOT!
const directory = path.join(root, "project")
const globals = globalThis as typeof globalThis & {
  __RI94Files?: { api: BrowserFiles.Interface; native: BrowserFileCapability.Interface;
    counts: () => { observing: number; opening: number; active: number; captures: number; previewing: number; operations: number } };
  __RI94ObserveAwait?: () => Promise<void>; __RI94PreviewAwait?: () => Promise<void>; __RI94OperationAwait?: () => Promise<void>;
  __RI94ChildClose?: (original: (...args: unknown[]) => boolean, args: unknown[]) => boolean
}
await BrowserNativeHost.prepare()
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
await AppRuntime.runPromise(Effect.gen(function* () {
  yield* NativeInstallation.current()
  yield* LocalAuthority.initializeInstallation()
}))
async function post(route: string, input: unknown) {
  const response = await fetch(new URL(route, listener.url), { method: "POST",
    headers: { authorization: `Basic ${Buffer.from("deepagent-code:private-fixture").toString("base64")}`,
      "content-type": "application/json", "x-deepagent-code-directory": directory, connection: "close" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(10000) })
  return { status: response.status, value: await response.json() }
}
const result = { phase: "root", error: "", facts: {} as object }
try {
  const session = await AppRuntime.runPromise(SessionV2.Service.use((sessions) => sessions.create({ location: { directory: AbsolutePath.make(directory) } })))
  const created = await post("/api/v1/browser/controls", { requestID: "custody", sessionID: session.id,
    profile: BrowserSchema.FILE_EXCHANGE_PROFILE, origin: process.env.DAC_BROWSER_ORIGIN!, postPaths: ["/upload"],
    filePolicy: { upload: true, download: false }, expiresAt: Date.now() + 120000 })
  assert.equal(created.status, 200, JSON.stringify(created.value))
  const controlID = created.value.control.controlID as string
  const control = await AppRuntime.runPromise(Effect.gen(function* () { return yield* BrowserControl.get((yield* Database.Service).db, controlID) }))
  assert(control)
  const input = { controlID, scope: control.scope, request: { direction: "upload", relative: "source.bin", targetPath: "/upload" } as const }
  result.phase = "http-preview"
  const first = await post(`/api/v1/browser/controls/${controlID}/files/preview`, input.request)
  assert.equal(first.status, 200, JSON.stringify(first.value))
  assert.equal(first.value.preview.bytes, 37)
  const native = globals.__RI94Files!
  assert(native)
  const ready = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const enters = { value: 0 }
  globals.__RI94ObserveAwait = () => { if (++enters.value === 8) ready.resolve(); return release.promise }
  const observations = Array.from({ length: 8 }, () => AppRuntime.runPromiseExit(native.native.preview({ control, request: input.request })))
  await ready.promise
  assert.equal(native.counts().opening, 8)
  assert(Exit.isFailure(await AppRuntime.runPromiseExit(native.native.preview({ control, request: input.request }))))
  assert.equal(enters.value, 8)
  globals.__RI94ObserveAwait = undefined; release.resolve()
  assert((await Promise.all(observations)).every(Exit.isSuccess))
  assert.equal(native.counts().opening, 0)
  result.phase = "preview-64"
  const previewReady = Promise.withResolvers<void>(); const previewRelease = Promise.withResolvers<void>(); const previewEnters = { value: 0 }
  const remainingCaptures = 64 - native.counts().captures
  globals.__RI94PreviewAwait = () => { if (++previewEnters.value === remainingCaptures) previewReady.resolve(); return previewRelease.promise }
  const previews = Array.from({ length: remainingCaptures }, () => AppRuntime.runPromiseExit(native.api.preview(input)))
  await previewReady.promise
  assert.equal(native.counts().captures + native.counts().previewing, 64)
  assert(Exit.isFailure(await AppRuntime.runPromiseExit(native.api.preview(input))))
  assert.equal(previewEnters.value, remainingCaptures)
  globals.__RI94PreviewAwait = undefined; previewRelease.resolve()
  await Promise.all(previews)
  while (native.counts().captures < 64) assert(Exit.isSuccess(await AppRuntime.runPromiseExit(native.api.preview(input))))
  assert(Exit.isFailure(await AppRuntime.runPromiseExit(native.api.preview(input))))
  result.phase = "operation-exact"
  const operationReady = Promise.withResolvers<void>(); const operationRelease = Promise.withResolvers<void>(); const operationEnters = { value: 0 }
  globals.__RI94OperationAwait = () => { operationEnters.value++; operationReady.resolve(); return operationRelease.promise }
  const command = { requestID: "exact-operation", previewID: "not-a-capture", expectedControlRevision: control.revision, expiresAt: Date.now() + 60000 }
  const original = AppRuntime.runPromiseExit(native.api.approve({ controlID, scope: control.scope, command }))
  await operationReady.promise
  const joined = AppRuntime.runPromiseExit(native.api.approve({ controlID, scope: control.scope, command }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(operationEnters.value, 1)
  globals.__RI94OperationAwait = undefined; operationRelease.resolve()
  assert((await Promise.all([original, joined])).every(Exit.isFailure))
  const maximum = BrowserSchema.MAX_CONTROLS * 64
  for (let index = 1; index < maximum; index++) {
    const outcome = await AppRuntime.runPromiseExit(native.api.approve({ controlID, scope: control.scope,
      command: { ...command, requestID: `known-negative-${index}` } }))
    assert(Exit.isFailure(outcome))
  }
  assert.equal(native.counts().operations, maximum)
  assert(Exit.isFailure(await AppRuntime.runPromiseExit(native.api.approve({ controlID, scope: control.scope,
    command: { ...command, requestID: "overflow" } }))))
  result.phase = "unknown-native-close"
  const delayed: Array<{ original: (...args: unknown[]) => boolean; args: unknown[] }> = []
  const closeReady = Promise.withResolvers<void>()
  globals.__RI94ChildClose = (original, args) => { delayed.push({ original, args }); closeReady.resolve(); return true }
  const unknown = AppRuntime.runPromiseExit(native.native.preview({ control, request: input.request }))
  await closeReady.promise
  assert(Exit.isFailure(await unknown))
  assert.equal(native.counts().opening, 1)
  const before = delayed.length
  assert.equal(before, 1)
  globals.__RI94ChildClose = undefined
  delayed.forEach((held) => held.original(...held.args))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(native.counts().opening, 0)
  result.phase = "complete"
  const census = await AppRuntime.runPromise(Effect.gen(function* () { const db = (yield* Database.Service).db;
    return { providers: (yield* db.all("SELECT attempt_id FROM session_provider_attempt")).length,
      artifacts: (yield* db.all("SELECT artifact_id FROM browser_file_artifact")).length,
      grants: (yield* db.all("SELECT grant_id FROM browser_file_grant")).length } }))
  assert.deepEqual(census, { providers: 0, artifacts: 0, grants: 0 })
  result.facts = { originalHttpNativePreview: true, observationBound: 8, previewBound: 64, operationBound: maximum,
    operationExactBodies: operationEnters.value, unknownNativeRetained: true, lateOriginalCloseReleased: true, census, counts: native.counts() }
} catch (error) { result.error = error instanceof Error ? error.stack ?? error.message : String(error) }
finally {
  await listener.stop(); await AppRuntime.dispose()
  await fs.writeFile(path.join(root, "child-result.json"), JSON.stringify(result), { mode: 0o600 })
  Reflect.get(process, "parentPort").postMessage({ type: "ri94-files-result", ok: result.phase === "complete" })
}
