/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import type { BrowserGetResponse } from "@deepagent-code/sdk"
import { ProjectProvider } from "../../../src/context/project"
import { DialogBrowserFiles } from "../../../src/component/dialog-browser-files"
import { useDialog } from "../../../src/ui/dialog"
import { mountIM, until } from "../../fixture/im-environment"

test("actual TUI/SDK previews a file and preserves a lost approval; reopening uses its original request GET without transferring", async () => {
  const root = await mkdtemp("/tmp/dac-file-browser-tui-")
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const grant = { grantID: "grant-one", direction: "upload", name: "report.txt", bytes: 3,
    expiresAt: Date.now() + 60_000, state: "approved" }
  let approved = false
  let reopen: (() => void) | undefined
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/path") return Response.json({ directory: root, worktree: root })
    if (path === "/project/current") return Response.json({ id: "project", worktree: root })
    if (path.startsWith("/experimental/workspace")) return Response.json([])
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined
    calls.push({ method: request.method, path, body })
    if (path.endsWith("/preview")) return Response.json({ controlID: "file-control", previewID: "preview-one", controlRevision: 1,
      preview: { direction: "upload", name: "report.txt", relative: "report.txt", bytes: 3,
        sha256: "a".repeat(64), targetPath: "/upload", observedAt: 1 } })
    if (path.endsWith("/approve")) { approved = true; return Response.json({ code: "BROWSER_FILE_UNKNOWN" }, { status: 503 }) }
    if (path.includes("/requests/")) return Response.json({ requestID: path.split("/").at(-1),
      state: approved ? "approved" : "missing", grant: approved ? grant : null })
    return Response.json({ files: [], grants: approved ? [grant] : [], nextCursor: null })
  } })
  const view: BrowserGetResponse = { nativeVerification: "verified", stopConfirmed: false, availability: "available",
    control: { version: 1, controlID: "file-control", requestID: "control-create", requestDigest: "b".repeat(64),
      scope: { principal: "user", securityNamespaceID: "namespace", locationKey: "location", projectScopeKey: "project-scope",
        namespaceBindingHash: "c".repeat(64), sessionID: "session", projectID: "project", directory: root, workspaceID: null },
      hostID: "host", hostIncarnation: "incarnation", resourceID: "resource", credentialBinding: "d".repeat(64),
      origin: "http://127.0.0.1:3000", revision: 1, epoch: 1, policyRevision: 1, state: "active",
      expiresAt: Date.now() + 300_000, createdAt: 1, updatedAt: 1, cancel: null, stopConfirmedAt: null,
      profile: "managed-loopback-exchange-v1", postPaths: ["/upload"], filePolicy: { upload: true, download: true } } }
  const component = () => <ProjectProvider><DialogBrowserFiles view={view} active={() => true} back={() => {}} /></ProjectProvider>
  const rendered = await mountIM(root, server.url.origin, component, 80, () => {
    const dialog = useDialog()
    reopen = () => dialog.replace(component)
    return <box />
  })
  try {
    await rendered.frame("File exchange")
    await until(() => calls.length === 1, "initial readonly list")
    expect(calls[0].method).toBe("GET")
    await until(() => !rendered.app.captureCharFrame().includes("Working"), "initial list settled")
    await rendered.app.renderOnce()
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Project file path")
    await rendered.type("report.txt", true)
    rendered.app.mockInput.pressTab()
    await rendered.type("/upload", true)
    rendered.app.mockInput.pressEnter()
    await rendered.frame("a".repeat(32))
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Unable to complete this operation")
    const command = calls.find((call) => call.path.endsWith("/approve"))?.body
    expect(command).toMatchObject({ previewID: "preview-one", expectedControlRevision: 1 })
    expect(command?.requestID).toBeString()
    reopen?.()
    await rendered.frame("report.txt · Upload · Approved")
    expect(calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(1)
    expect(calls.find((call) => call.path.includes("/requests/"))?.path).toContain(String(command?.requestID))
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2)
    expect(calls.every((call) => !/\/actions|file\.upload|file\.download/.test(call.path))).toBeTrue()
  } finally {
    rendered.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
