/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { getOwner, onMount, runWithOwner } from "solid-js"
import { createStore } from "solid-js/store"
import { ProjectProvider, useProject } from "../../../src/context/project"
import { useDialog } from "../../../src/ui/dialog"
import { DialogSelect } from "../../../src/ui/dialog-select"
import { DialogPacks } from "../../../src/component/dialog-packs"
import { DialogTerminal } from "../../../src/component/dialog-terminal"
import { DialogBackup } from "../../../src/component/dialog-backup"
import { DialogGitTimeline } from "../../../src/component/dialog-git-timeline"
import { mountIM, until } from "../../fixture/im-environment"

async function fixture() {
  const root = await mkdtemp("/tmp/dac-action-tui-")
  const state = { calls: [] as { method: string; path: string; directory: string | null; auth: string | null; body: unknown }[],
    pinned: false, ptys: [] as { id: string; title: string }[] }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.text() : ""
    state.calls.push({ method: request.method, path: url.pathname, directory: url.searchParams.get("location[directory]") ?? url.searchParams.get("directory"),
      auth: request.headers.get("authorization"), body: body ? JSON.parse(body) : undefined })
    state.calls.at(-1)!.directory ??= request.headers.has("x-deepagent-code-directory") ? decodeURIComponent(request.headers.get("x-deepagent-code-directory")!) : null
    if (url.pathname === "/deepagent/packs/all") return Response.json({ packs: [{ id: "owned-pack", name: "Owned pack",
      version: "1", risk: "low", domains: [], builtin: false, pinned: state.pinned }] })
    if (url.pathname === "/deepagent/packs/pin" && request.method === "POST") {
      state.pinned = true
      return Response.json({ pinned: true })
    }
    if (url.pathname === "/pty" && request.method === "GET") return Response.json(state.ptys)
    if (url.pathname === "/pty" && request.method === "POST") {
      state.ptys.push({ id: "owned-pty", title: "Created terminal" })
      return Response.json(state.ptys[0])
    }
    if (url.pathname === "/backup/list") return Response.json({ backups: [{ fileName: "Owned backup", filePath: `${root}/manifest.json`,
      sizeBytes: 42, sha256: "a".repeat(64), createdAt: 1 }] })
    if (url.pathname === "/backup/verify") return Response.json({ ok: true, checked: 3, problems: [] })
    if (url.pathname === "/bootstrap/status") return Response.json("ready")
    if (url.pathname === "/path") return Response.json({ directory: root, worktree: root })
    if (url.pathname === "/project/current") return Response.json({ id: "owned-project", worktree: root })
    return new Response(null, { status: 404 })
  } })
  return { root, state, server, async close() { server.stop(true); await rm(root, { recursive: true, force: true }) } }
}

test("unbound declared dialog actions are visible and keyboard reachable while hidden, disabled and locked actions never run", async () => {
  const peer = await fixture()
  const called: string[] = []
  const blocked: string[] = []
  const [state, setState] = createStore({ locked: false })
  function View() {
    return <DialogSelect title="Owned actions" options={[{ title: "Owned item", value: "owned" }]} locked={state.locked}
      actions={[
        { command: "owned.unbound", title: "Unbound operation", onTrigger: (option) => called.push(option.value) },
        { command: "owned.hidden", title: "Hidden operation", hidden: true, onTrigger: () => blocked.push("hidden") },
        { command: "owned.disabled", title: "Disabled operation", disabled: true, onTrigger: () => blocked.push("disabled") },
      ]} />
  }
  const rendered = await mountIM(peer.root, peer.server.url.origin, View, 80)
  try {
    const frame = await rendered.frame("Unbound operation")
    expect(frame).toContain("Disabled operation")
    expect(frame).not.toContain("Hidden operation")
    rendered.app.mockInput.pressTab()
    rendered.app.mockInput.pressEnter()
    await until(() => called.length === 1, "unbound action activated by Tab and Enter")
    expect(called).toEqual(["owned"])
    expect(blocked).toHaveLength(0)
    setState("locked", true)
    rendered.app.mockInput.pressTab()
    rendered.app.mockInput.pressEnter()
    await rendered.app.renderOnce()
    expect(called).toEqual(["owned"])
    expect(blocked).toHaveLength(0)
  } finally { rendered.app.renderer.destroy(); await peer.close() }
}, 10_000)

test("an actual packs dialog reaches its unbound footer action and pins the exact selected pack through SDK HTTP", async () => {
  const peer = await fixture()
  const rendered = await mountIM(peer.root, peer.server.url.origin, DialogPacks, 80)
  try {
    await rendered.frame("Owned pack")
    await rendered.frame("pin/unpin")
    rendered.app.mockInput.pressTab()
    rendered.app.mockInput.pressEnter()
    await until(() => peer.state.pinned, "original SDK pack pin")
    await rendered.frame("📌 Owned pack")
    expect(peer.state.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/deepagent/packs/pin", directory: peer.root, auth: "Bearer fixture-token", body: { packId: "owned-pack" } },
    ])
    expect(peer.state.calls.filter((call) => call.method === "GET").every((call) => call.path === "/deepagent/packs/all")).toBeTrue()
  } finally { rendered.app.renderer.destroy(); await peer.close() }
}, 10_000)

test("unbound footer actions wrap within 80 columns and mouse activation still respects disabled and locked state", async () => {
  const peer = await fixture()
  const called: string[] = []
  const [state, setState] = createStore({ locked: false })
  function View() {
    return <DialogSelect title="Mouse actions" options={[{ title: "Owned item", value: "owned" }]} locked={state.locked}
      actions={Array.from({ length: 7 }, (_, index) => ({ command: `owned.mouse.${index}`, title: `Operation ${index}`,
        disabled: index === 6, onTrigger: () => called.push(String(index)) }))} />
  }
  const rendered = await mountIM(peer.root, peer.server.url.origin, View, 80)
  const click = async (text: string) => {
    const lines = rendered.app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    await rendered.app.mockMouse.click(lines[y].indexOf(text) + 2, y)
    await rendered.app.renderOnce()
  }
  try {
    const frame = await rendered.frame("Operation 6")
    expect(Array.from({ length: 7 }, (_, index) => frame.includes(`Operation ${index}`)).every(Boolean)).toBeTrue()
    await click("Operation 5")
    expect(called).toEqual(["5"])
    await click("Operation 6")
    expect(called).toEqual(["5"])
    setState("locked", true)
    await click("Operation 0")
    expect(called).toEqual(["5"])
  } finally { rendered.app.renderer.destroy(); await peer.close() }
}, 10_000)

test("an empty terminal registry still offers explicit create and never enables attach or remove before a real PTY exists", async () => {
  const peer = await fixture()
  const rendered = await mountIM(peer.root, peer.server.url.origin, DialogTerminal, 80)
  try {
    await until(() => peer.state.calls.some((call) => call.path === "/pty"), "original empty PTY read")
    await rendered.frame("new")
    rendered.app.mockInput.pressTab()
    rendered.app.mockInput.pressEnter()
    await until(() => peer.state.ptys.length === 1, "explicit new terminal from empty list")
    await rendered.frame("Created terminal")
    expect(peer.state.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/pty", directory: peer.root, auth: "Bearer fixture-token", body: undefined },
    ])
    expect(peer.state.calls.some((call) => call.method === "DELETE")).toBeFalse()
  } finally { rendered.app.renderer.destroy(); await peer.close() }
}, 10_000)

test("backup verification is keyboard reachable and stays a GET-only check of the original selected manifest", async () => {
  const peer = await fixture()
  const rendered = await mountIM(peer.root, peer.server.url.origin, DialogBackup, 80)
  try {
    await rendered.frame("Owned backup")
    await rendered.frame("verify")
    rendered.app.mockInput.pressTab()
    rendered.app.mockInput.pressEnter()
    await rendered.frame("checked: 3")
    expect(peer.state.calls.every((call) => call.method === "GET" && call.auth === "Bearer fixture-token")).toBeTrue()
    expect(peer.state.calls.filter((call) => call.path === "/backup/verify")).toHaveLength(1)
  } finally { rendered.app.renderer.destroy(); await peer.close() }
}, 10_000)

test("a real asynchronous Git log replaces the loading view and the selected commit opens its original details", async () => {
  const peer = await fixture()
  const run = async (args: string[]) => {
    const process = Bun.spawn(["git", ...args], { cwd: peer.root, stdout: "pipe", stderr: "pipe" })
    expect(await process.exited).toBe(0)
    return new Response(process.stdout).text()
  }
  await run(["init", "-q"])
  await Bun.write(`${peer.root}/owned.txt`, "original\n")
  await run(["add", "owned.txt"])
  await run(["-c", "user.name=Owned fixture", "-c", "user.email=owned@example.invalid", "commit", "-q", "-m", "Owned history commit"])
  function OpenGit() {
    const project = useProject()
    const dialog = useDialog()
    const owner = getOwner()!
    onMount(() => void project.sync().then(() => dialog.replace(() =>
      runWithOwner(owner, () => <DialogGitTimeline file="owned.txt" />))))
    return <box />
  }
  // Keep the Project owner outside the dialog, as in the product. Synchronize its original
  // SDK placement before constructing the Git view, so the command only sees our repository.
  const rendered = await mountIM(peer.root, peer.server.url.origin, () => <box />, 80,
    () => <ProjectProvider><OpenGit /></ProjectProvider>)
  try {
    await rendered.frame("Owned history commit")
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Owned fixture")
    expect(peer.state.calls.every((call) => call.method === "GET" && ["/path", "/project/current"].includes(call.path))).toBeTrue()
  } finally { rendered.app.renderer.destroy(); await peer.close() }
}, 10_000)
