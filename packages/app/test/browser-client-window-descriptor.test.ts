import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { BrowserClientWindow } from "./fixture/browser-client-window-descriptor"

const source = "return {version:1,steps:[]};"
const input = {
  version: 1,
  evidence: "source-runtime-canonical-client-hold-window",
  rootURL: "http://127.0.0.1:33001",
  appOrigin: "http://127.0.0.1:33002",
  pageOrigin: "http://127.0.0.1:33003",
  authorizationFile: "/tmp/browser-client-unused-authorization",
  directory: "/tmp/browser-client-unused-project",
  output: "/tmp/browser-client-unused-output",
  deadlineAt: Date.now() + 10000,
  sessions: { gui: "ses_browser_gui", tui: "ses_browser_tui" },
  postPath: "/program-submit",
  program: { source, argsJSON: "null", scriptHash: createHash("sha256").update(source).digest("hex"),
    argsHash: createHash("sha256").update("null").digest("hex"), operations: ["fill", "select", "click"], maxSteps: 3 },
  model: { providerID: "fixture", modelID: "test-model" },
  expectedProviderTurnsPerClient: 5,
  stopFile: "/tmp/browser-client-unused-stop",
}

test("client window accepts independent observations and rejects changed approved bytes or reused Session", () => {
  expect(BrowserClientWindow.decode(input).program.source).toBe(source)
  expect(() => BrowserClientWindow.decode({ ...input, program: { ...input.program, source: source + " " } })).toThrow()
  expect(() => BrowserClientWindow.decode({ ...input, sessions: { ...input.sessions, tui: input.sessions.gui } })).toThrow()
  expect(() => BrowserClientWindow.decode({ ...input, rootURL: input.appOrigin })).toThrow()
  expect(() => BrowserClientWindow.decode({ ...input, rootURL: "https://external.example" })).toThrow()
})

test("client window reads private original credential and refuses broad mode, symlink, or expired live window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-client-descriptor-"))
  await fs.chmod(root, 0o700)
  const authorizationFile = path.join(root, "authorization")
  const file = path.join(root, "descriptor.json")
  try {
    await fs.writeFile(authorizationFile, "Basic Zml4dHVyZTpub3QtYS1yZWFsLXNlY3JldA==", { mode: 0o600 })
    await fs.writeFile(file, JSON.stringify({ ...input, authorizationFile }), { mode: 0o600 })
    expect((await BrowserClientWindow.read(file, true)).input.sessions).toEqual(input.sessions)
    await fs.chmod(authorizationFile, 0o644)
    await expect(BrowserClientWindow.read(file)).rejects.toThrow("Private original")
    await fs.chmod(authorizationFile, 0o600)
    await fs.symlink(authorizationFile, path.join(root, "linked"))
    await fs.writeFile(file, JSON.stringify({ ...input, authorizationFile: path.join(root, "linked") }), { mode: 0o600 })
    await expect(BrowserClientWindow.read(file)).rejects.toThrow("Private original")
    await fs.writeFile(file, JSON.stringify({ ...input, authorizationFile, deadlineAt: 1 }), { mode: 0o600 })
    await expect(BrowserClientWindow.read(file, true)).rejects.toThrow("window has ended")
  } finally {
    await fs.rm(root, { recursive: true })
  }
})
