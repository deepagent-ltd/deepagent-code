// QA Main entry. Original managed windows and native confirmations remain unmodified.
import { app, BrowserWindow, clipboard, utilityProcess } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { installManagedBrowser } from "../managed-browser"
import { managedBrowserInputFixtureAsset } from "./managed-browser-input-fixture-asset"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"

const root = process.env.DAC_BROWSER_CLIPBOARD_ROOT!
const readText = "界".repeat(5_461) + "x"
const writeText = "文".repeat(2_730) + "xy"

async function main() {
  app.setPath("userData", path.join(root, "electron-user"))
  app.setPath("sessionData", path.join(root, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  // Only a single standard UTF-8 text format can be restored exactly here. Other
  // formats never leave the OS clipboard and force a zero-operation-only run.
  const formats = BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE ? clipboard.availableFormats() : []
  const nativeTextFormat = process.platform === "darwin" ? "public.utf8-plain-text" : "text/plain"
  const original = !BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE ? undefined : formats.length === 0 ? { kind: "empty" as const } :
    formats.length === 1 && formats[0] === "text/plain" ?
      { kind: "text" as const, bytes: clipboard.readBuffer(nativeTextFormat), text: clipboard.readText() } : undefined
  const safe = original !== undefined && (original.kind === "empty" ||
    original.text.isWellFormed() && Buffer.from(original.text, "utf8").equals(original.bytes))
  const state = { changed: false, expected: "", restored: false, externalChanged: false,
    result: undefined as unknown, stdout: "", stderr: "", stages: [] as string[], completed: false,
    pageBypass: undefined as { readAllowed: boolean; writeAllowed: boolean; copyAllowed: boolean; contentChanged: boolean } | undefined }
  const restore = () => {
    if (!state.changed) { state.restored = true; return }
    // An independent user copy wins: never overwrite a new clipboard owner.
    const current = clipboard.availableFormats()
    if (current.length !== 1 || current[0] !== "text/plain" || ![readText, writeText].includes(clipboard.readText())) {
      state.externalChanged = true
      return
    }
    if (original?.kind === "empty") clipboard.clear()
    if (original?.kind === "text") clipboard.writeBuffer(nativeTextFormat, original.bytes)
    const final = clipboard.availableFormats()
    state.restored = original?.kind === "empty" ? final.length === 0 : original?.kind === "text" &&
      final.length === 1 && final[0] === "text/plain" && clipboard.readBuffer(nativeTextFormat).equals(original.bytes) &&
      clipboard.readText() === original.text
  }
  const peer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") { response.writeHead(405); response.end(); return }
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end('<!doctype html><title>Clipboard module QA</title><h1>Original managed browser clipboard</h1><p>Private loopback page</p>')
  })
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve))
  const address = peer.address()
  assert.ok(address && typeof address !== "string")
  const child = utilityProcess.fork(process.env.DAC_BROWSER_CLIPBOARD_MODULE!, [], { cwd: path.join(root, "project"),
    env: { ...process.env, DAC_BROWSER_CLIPBOARD_ORIGIN: `http://127.0.0.1:${address.port}`,
      DAC_BROWSER_CLIPBOARD_SAFE: safe ? "1" : "0" }, stdio: "pipe" })
  const stop = installManagedBrowser(child, "private-clipboard-module", managedBrowserInputFixtureAsset(root))
  const finish = async (code: number) => {
    if (state.completed) return
    state.completed = true
    clearTimeout(timer)
    stop()
    restore()
    peer.closeAllConnections()
    await new Promise<void>((resolve) => peer.close(() => resolve()))
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ code, result: state.result,
      facts: { safeRestore: safe, originalFormatCount: formats.length, stages: state.stages,
        restored: state.restored, externalChanged: state.externalChanged, pageBypass: state.pageBypass,
        clipboardInspectedByQA: BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE, windows: BrowserWindow.getAllWindows().length },
      stdout: state.stdout, stderr: state.stderr }), { mode: 0o600 })
    app.exit(code || (state.restored || state.externalChanged ? 0 : 4))
  }
  const timer = setTimeout(() => { child.kill(); void finish(3) }, 150_000)
  child.stdout?.on("data", (bytes: Buffer) => { state.stdout += bytes.toString() })
  child.stderr?.on("data", (bytes: Buffer) => { state.stderr += bytes.toString() })
  child.on("message", (message: { type?: string; name?: string; result?: unknown }) => {
    if (message.type === "clipboard-stage") {
      const name = message.name!
      state.stages.push(name)
      if (safe && (name === "read" || name === "page-bypass")) {
        state.changed = true
        state.expected = readText
        clipboard.writeText(readText)
      }
      if (safe && name === "write") state.expected = writeText
      console.log("CLIPBOARD_NATIVE_QA", name)
      void fs.writeFile(path.join(root, "stage.json"), JSON.stringify({ name, safeRestore: safe }), { mode: 0o600 })
      void (async () => {
        if (safe && name === "page-bypass") {
          const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === `http://127.0.0.1:${address.port}/`)
          assert.ok(window)
          // QA drives a real user-gesture page, never a mocked permission handler.
          state.pageBypass = await window.webContents.executeJavaScript(`(async () => {
            const facts = {readAllowed:false,writeAllowed:false,copyAllowed:false};
            try { await navigator.clipboard.readText(); facts.readAllowed=true } catch {}
            try { await navigator.clipboard.writeText('clipboard-page-owned-write'); facts.writeAllowed=true } catch {}
            const node=document.createElement('textarea');node.value='clipboard-page-owned-copy';document.body.append(node);node.select();
            facts.copyAllowed=document.execCommand('copy');node.remove();return facts;
          })()`, true)
          state.pageBypass!.contentChanged = clipboard.readText() !== readText
          // This remains exclusively synthetic QA data, including a successful bypass.
          clipboard.writeText(readText)
        }
        child.postMessage({ type: "clipboard-stage-ready", name })
      })().catch(() => { child.kill(); void finish(1) })
    }
    if (message.type === "clipboard-result") state.result = message.result
  })
  child.on("exit", (code) => { void finish(code ?? 1) })
}

void main().catch(async () => {
  // Do not serialize exceptions that could contain the RAM-only original content.
  await fs.writeFile(path.join(root, "main-failure.json"), JSON.stringify({ code: "CLIPBOARD_QA_MAIN_FAILED" }), { mode: 0o600 })
  app.exit(1)
})
