// Physical QA Main: RAM-only original snapshot and actual pasteboard generation guard.
import { app, BrowserWindow, clipboard, utilityProcess } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { installManagedBrowser } from "../managed-browser"
import { managedBrowserInputFixtureAsset } from "./managed-browser-input-fixture-asset"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"

const root = process.env.DAC_BROWSER_CLIPBOARD_ROOT!
const readText = "界".repeat(5_461) + "x"
const writeText = "文".repeat(2_730) + "xy"
const state = { completed: false, changed: false, restored: false, externalChanged: false,
  result: undefined as unknown, failure: "", stages: [] as string[], expectedCount: 0, changes: [] as { stage: string; before: number; after: number }[],
  nativeUI: [] as { direction: string; attachedSheet: boolean; matched: boolean; before: number; after: number; clicked: boolean }[],
  pageBypass: undefined as { readAllowed: boolean; writeAllowed: boolean; copyAllowed: boolean; contentChanged: boolean } | undefined }
const owner = () => {
  const value = execFileSync(path.join(root, "pasteboard-owner"), [], { timeout: 3000, encoding: "utf8", maxBuffer: 128,
    env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } }).trim().split(" ").map(Number)
  assert.equal(value.length, 2)
  assert.ok(value.every((value) => Number.isSafeInteger(value) && value >= 0))
  return { count: value[0]!, items: value[1]! }
}
const requireOwner = () => {
  const actual = owner()
  if (actual.count !== state.expectedCount) { state.externalChanged = true; throw new Error("QA_EXTERNAL_CLIPBOARD_CHANGE") }
  return actual
}

async function main() {
  const credential = process.env.DAC_BROWSER_CLIPBOARD_QA_CREDENTIAL
  assert.ok(credential && /^[a-f0-9]{64}$/.test(credential), "QA_CREDENTIAL_CONTRACT_MISSING")
  assert.equal(process.platform, "darwin")
  assert.equal(BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE, true, "QA_PRIVATE_FEATURE_OVERLAY_MISSING")
  app.setPath("userData", path.join(root, "electron-user"))
  app.setPath("sessionData", path.join(root, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const actor = createRequire(import.meta.url)(path.join(root, "native-ui-qa.node")) as {
    act(handle: Buffer, direction: "read" | "write", nonce: string, mode: "observe" | "approve"): string
  }
  const actorTimers = new Set<ReturnType<typeof setInterval>>()
  const initial = owner()
  const formats = clipboard.availableFormats()
  const original = formats.length === 0 && initial.items === 0 ? { kind: "empty" as const } :
    formats.length === 1 && formats[0] === "text/plain" && initial.items === 1 ?
      { kind: "text" as const, bytes: clipboard.readBuffer("public.utf8-plain-text"), text: clipboard.readText() } : undefined
  assert.ok(original && (original.kind === "empty" || original.text.isWellFormed() &&
    Buffer.from(original.text, "utf8").equals(original.bytes)), "QA_ORIGINAL_FORMAT_UNRESTORABLE")
  assert.equal(owner().count, initial.count, "QA_SNAPSHOT_CHANGED")
  state.expectedCount = initial.count
  const setSynthetic = () => {
    const before = requireOwner().count
    clipboard.writeText(readText)
    const after = owner()
    assert.ok(after.items === 1 && after.count > before && clipboard.readText() === readText, "QA_SYNTHETIC_WRITE_UNVERIFIED")
    state.expectedCount = after.count
    state.changed = true
    state.changes.push({ stage: "set-synthetic", before, after: after.count })
  }
  const restore = () => {
    if (!state.changed) { state.restored = true; return }
    // NSPasteboard exposes no expected-count CAS. This detects prior external
    // changes; the final check-to-write interval is not an OS atomic guarantee.
    const before = requireOwner().count
    if (original.kind === "empty") clipboard.clear()
    if (original.kind === "text") clipboard.writeBuffer("public.utf8-plain-text", original.bytes)
    const final = owner()
    const formats = clipboard.availableFormats()
    state.restored = original.kind === "empty" ? final.items === 0 && formats.length === 0 :
      final.items === 1 && formats.length === 1 && formats[0] === "text/plain" &&
      clipboard.readBuffer("public.utf8-plain-text").equals(original.bytes) && clipboard.readText() === original.text
    assert.ok(final.count > before && state.restored, "QA_RESTORE_UNVERIFIED")
    state.changes.push({ stage: "restore", before, after: final.count })
    if (original.kind === "text") original.bytes.fill(0)
  }
  const peer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") { response.writeHead(405); response.end(); return }
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end('<!doctype html><title>Clipboard physical QA</title><h1>Private clipboard QA</h1><p>Controlled synthetic clipboard only.</p>')
  })
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve))
  const address = peer.address()
  assert.ok(address && typeof address !== "string")
  const child = utilityProcess.fork(process.env.DAC_BROWSER_CLIPBOARD_MODULE!, [], { cwd: path.join(root, "project"),
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      DAC_BROWSER_CLIPBOARD_ROOT: root, DAC_BROWSER_CLIPBOARD_QA_CREDENTIAL: credential, DAC_BROWSER_CLIPBOARD_ORIGIN: `http://127.0.0.1:${address.port}`, DAC_BROWSER_CLIPBOARD_SAFE: "1" }, stdio: "pipe" })
  const stop = installManagedBrowser(child, credential, managedBrowserInputFixtureAsset(root))
  const finish = async (code: number) => {
    if (state.completed) return
    state.completed = true
    clearTimeout(timer)
    for (const timer of actorTimers) clearInterval(timer)
    stop()
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    if (state.stages.at(-1) === "write" && !state.externalChanged && code === 0) {
      const after = owner()
      // This is the one expected product write, not an arbitrary new owner.
      if (after.items !== 1 || after.count <= state.expectedCount || clipboard.readText() !== writeText) state.externalChanged = true
      if (!state.externalChanged) {
        state.changes.push({ stage: "native-write", before: state.expectedCount, after: after.count })
        state.expectedCount = after.count
      }
    }
    if (!state.externalChanged) {
      try { restore() } catch { state.failure ||= "QA_RESTORE_OR_OWNER_CHANGED" }
    }
    peer.closeAllConnections()
    await new Promise<void>((resolve) => peer.close(() => resolve()))
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ code, result: state.result,
      facts: { stages: state.stages, changes: state.changes, restored: state.restored, externalChanged: state.externalChanged,
        pageBypass: state.pageBypass, nativeUI: state.nativeUI, failure: state.failure, windows: BrowserWindow.getAllWindows().length,
        originalSnapshotRAMOnly: true, ownerCAS: false } }), { mode: 0o600 })
    app.exit(code || (state.restored && !state.externalChanged && !state.failure ? 0 : 4))
  }
  const timer = setTimeout(() => { state.failure = "QA_DEADLINE"; child.kill(); void finish(3) }, 120_000)
  child.stdout?.on("data", () => {})
  child.stderr?.on("data", () => {})
  child.on("message", (message: { type?: string; name?: string; result?: unknown }) => {
    if (message.type === "clipboard-stage") {
      void (async () => {
        const name = message.name!
        state.stages.push(name)
        if (name === "read" || name === "page-bypass") setSynthetic()
        if (name === "write") requireOwner()
        console.log("CLIPBOARD_PHYSICAL_QA", name)
        await fs.writeFile(path.join(root, "stage.json"), JSON.stringify({ name, syntheticOnly: true }), { mode: 0o600 })
        if (name === "page-bypass") {
          const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === `http://127.0.0.1:${address.port}/`)
          assert.ok(window)
          const before = requireOwner().count
          state.pageBypass = await window.webContents.executeJavaScript(`(async()=>{
            const facts={readAllowed:false,writeAllowed:false,copyAllowed:false};
            try{await navigator.clipboard.readText();facts.readAllowed=true}catch{}
            try{await navigator.clipboard.writeText('clipboard-page-owned-write');facts.writeAllowed=true}catch{}
            const node=document.createElement('textarea');node.value='clipboard-page-owned-copy';document.body.append(node);node.select();
            facts.copyAllowed=document.execCommand('copy');node.remove();return facts;
          })()`, true)
          state.pageBypass!.contentChanged = owner().count !== before
          if (state.pageBypass!.contentChanged) state.externalChanged = true
          assert.deepEqual(state.pageBypass, { readAllowed: false, writeAllowed: false, copyAllowed: false, contentChanged: false }, "QA_PAGE_CLIPBOARD_BYPASS")
        }
        if (name === "read" || name === "write") {
          const direction = name
          const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === `http://127.0.0.1:${address.port}/`)
          assert.ok(window)
          const timer = setInterval(() => {
            try {
              if (window.isDestroyed()) { clearInterval(timer); actorTimers.delete(timer); return }
              const observed = JSON.parse(actor.act(window.getNativeWindowHandle(), direction, path.basename(root), "observe")) as {
                attachedSheet: boolean; matched: boolean; before: number; after: number; clicked: boolean
              }
              if (!observed.matched) return
              requireOwner()
              const clicked = JSON.parse(actor.act(window.getNativeWindowHandle(), direction, path.basename(root), "approve")) as typeof observed
              state.nativeUI.push({ direction, ...clicked })
              assert.ok(clicked.attachedSheet && clicked.matched && clicked.before === 0 && clicked.after === 1 && clicked.clicked)
              clearInterval(timer)
              actorTimers.delete(timer)
            } catch { state.failure = "QA_NATIVE_UI_OR_OWNER_FAILED"; child.kill(); void finish(1) }
          }, 50)
          actorTimers.add(timer)
        }
        child.postMessage({ type: "clipboard-stage-ready", name })
      })().catch(() => { state.failure = "QA_STAGE_OR_OWNER_FAILED"; child.kill(); void finish(1) })
    }
    if (message.type === "clipboard-result") state.result = message.result
  })
  child.on("exit", (code) => { void finish(code ?? 1) })
}

void main().catch(async (error: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  await fs.writeFile(path.join(root, "main-failure.json"), JSON.stringify({ code: error instanceof Error ? error.message.match(/QA_[A-Z_]+/)?.[0] ?? "QA_SETUP_OR_ORIGINAL_CLIPBOARD_UNAVAILABLE" : "QA_SETUP_OR_ORIGINAL_CLIPBOARD_UNAVAILABLE" }), { mode: 0o600 })
  app.exit(1)
})
