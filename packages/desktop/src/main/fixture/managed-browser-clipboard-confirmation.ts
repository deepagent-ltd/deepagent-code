// Actual Main confirmation only: this fixture never reads or writes OS clipboard data.
import { app, BrowserWindow } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { createManagedBrowserClipboard, createManagedBrowserClipboardConfirmation } from "../managed-browser-clipboard"

const root = process.env.DAC_BROWSER_CLIPBOARD_CONFIRMATION_ROOT!
const facts = { cases: [] as { name: string; code?: string; approved: boolean; currentChecks: number; observationChecks: number }[],
  leaseDenied: "", dispatched: 0, clipboardInspected: false, windows: 0 }
const fail = (code: BrowserSchema.Error["code"]): never => { throw new BrowserSchema.Error({ code, message: code }) }
const confirm = createManagedBrowserClipboardConfirmation(fail)
const failCode = (error: unknown) => error instanceof BrowserSchema.Error ? error.code : "FIXTURE_ERROR"

async function main() {
  app.setPath("userData", path.join(root, "electron-user"))
  app.setPath("sessionData", path.join(root, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const control = Schema.decodeUnknownSync(BrowserSchema.Control)({ version: 1, profile: BrowserSchema.INTERACTION_PROFILE,
    controlID: "confirmation-control", requestID: "confirmation-request", requestDigest: "a".repeat(64),
    scope: { principal: "confirmation-principal", securityNamespaceID: "confirmation-namespace", locationKey: "confirmation-location",
      projectScopeKey: "confirmation-project-scope", namespaceBindingHash: "a".repeat(64), sessionID: "confirmation-session",
      projectID: "confirmation-project", directory: root, workspaceID: null }, hostID: "confirmation-host", hostIncarnation: "confirmation-incarnation",
    resourceID: "confirmation-resource", credentialBinding: "a".repeat(64), origin: "http://127.0.0.1:1", postPaths: [],
    clipboardPolicy: { read: true, write: true }, revision: 1, epoch: 1, policyRevision: 1, state: "active", expiresAt: Date.now() + 180_000,
    createdAt: Date.now(), updatedAt: Date.now(), cancel: null, stopConfirmedAt: null })
  const window = new BrowserWindow({ width: 760, height: 460, title: "Clipboard confirmation QA", show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "clipboard-confirmation-private", javascript: false } })
  await window.loadURL("data:text/html,<title>Clipboard confirmation QA</title><h1>Native confirmation only</h1><p>No clipboard API is called. QA operates the original native dialog.</p>")
  const action = (name: string, direction: "read" | "write") => Schema.decodeUnknownSync(BrowserSchema.Action)({ version: 1,
    actionID: name, controlID: control.controlID, requestID: name, commandDigest: "a".repeat(64),
    command: { type: `clipboard.${direction}`, tabID: "confirmation-tab", generation: 0, frameID: "confirmation-frame", observationRevision: 1,
      ...(direction === "write" ? { text: "clipboard-confirmation-owned-synthetic" } : {}) }, admissionID: name,
    providerReceiptID: name, providerAttemptID: name, toolCallID: name, sessionID: control.scope.sessionID,
    hostIncarnation: control.hostIncarnation, resourceID: control.resourceID, controlEpoch: 1, policyRevision: 1, revision: 1,
    deadline: Date.now() + 45_000, outcome: "pending", result: null, errorCode: null, createdAt: Date.now(), updatedAt: Date.now(), terminalAt: null, stopConfirmedAt: null })
  const run = async (name: string, direction: "read" | "write", close = false) => {
    const checks = { current: 0, observe: 0 }
    await fs.writeFile(path.join(root, "stage.json"), JSON.stringify({ name, confirmationOnly: true }), { mode: 0o600 })
    console.log("CLIPBOARD_CONFIRMATION_STAGE", name)
    const input = { control, action: action(name, direction), window,
      current: async () => { checks.current++ }, observe: async () => { checks.observe++ } }
    const running = confirm(input).then((release) => { release(); release(); return { approved: true } }, (error: unknown) => ({ approved: false, code: failCode(error) }))
    if (name === "cancel-read") {
      await new Promise((resolve) => setTimeout(resolve, 250))
      facts.leaseDenied = await confirm({ ...input, action: action("lease-competing-write", "write") })
        .then((release) => { release(); return "UNEXPECTED_APPROVAL" }, (error: unknown) => failCode(error))
      assert.equal(facts.leaseDenied, "BROWSER_CAPACITY")
    }
    const cancel = close ? setInterval(() => {
      void fs.readFile(path.join(root, "close-request"), "utf8").then(() => window.destroy(), () => {})
    }, 100) : undefined
    const result = await running
    if (cancel) clearInterval(cancel)
    facts.cases.push({ name, ...result, currentChecks: checks.current, observationChecks: checks.observe })
    if (name === "checked-read") assert.equal(result.approved, true)
    if (name !== "checked-read") assert.equal(result.approved, false)
  }
  assert.equal(BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE, false)
  const blocked = await createManagedBrowserClipboard(fail)({ control, action: action("official-blocked-read", "read"), window,
    current: async () => fail("BROWSER_UNKNOWN"), observe: async () => fail("BROWSER_UNKNOWN"), dispatched: () => { facts.dispatched++ } })
    .then(() => "UNEXPECTED_APPROVAL", (error: unknown) => failCode(error))
  assert.equal(blocked, "BROWSER_DRIVER_UNAVAILABLE")
  await run("cancel-read", "read")
  await run("unchecked-write", "write")
  await run("checked-read", "read")
  await run("close-write", "write", true)
  facts.windows = BrowserWindow.getAllWindows().length
  assert.equal(facts.windows, 0)
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ success: true, node: process.versions.node,
    electron: process.versions.electron, blocked, facts }), { mode: 0o600 })
  app.exit(0)
}

const timeout = setTimeout(() => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  void fs.writeFile(path.join(root, "failure.json"), JSON.stringify({ code: "CONFIRMATION_QA_TIMEOUT" }), { mode: 0o600 }).then(() => app.exit(2))
}, 165_000)
void main().then(() => clearTimeout(timeout), async (error: unknown) => {
  clearTimeout(timeout)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  await fs.writeFile(path.join(root, "failure.json"), JSON.stringify({ code: failCode(error), facts }), { mode: 0o600 })
  app.exit(1)
})
