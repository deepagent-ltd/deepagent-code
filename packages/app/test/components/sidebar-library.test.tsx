import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import type { ComponentProps } from "solid-js"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { SidebarContent } from "@/pages/layout/sidebar-shell"
import { DialogLibrary } from "@/components/library/dialog-library"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict) => dict[key],
    intl: () => "en-US",
  }),
}))
afterEach(cleanup)

it("groups global rail actions without duplicating destinations and preserves project access when collapsed", () => {
  const [state, setState] = createStore({ opened: false, pending: true })
  const open = vi.fn()
  const attention = vi.fn()
  const library = vi.fn()
  const settings = vi.fn()
  render(() => (
    <SidebarContent
      opened={() => state.opened}
      aimMove={() => undefined}
      projects={() => [{ worktree: "/project", expanded: true }]}
      renderProject={(project) => <button aria-label="Current project">{project().worktree}</button>}
      handleDragStart={() => undefined}
      handleDragEnd={() => undefined}
      handleDragOver={() => undefined}
      openProjectLabel="Open project"
      openProjectKeybind={() => "⌘O"}
      onOpenProject={open}
      renderProjectOverlay={() => undefined}
      settingsLabel={() => "Settings"}
      settingsKeybind={() => "⌘,"}
      onOpenSettings={settings}
      attentionLabel={() => "Needs attention"}
      onOpenAttention={attention}
      libraryLabel={() => "Library"}
      onOpenLibrary={library}
      reviewPending={() => state.pending}
      renderPanel={() => <button>Session navigation</button>}
    />
  ))
  const rail = document.querySelector('[data-component="sidebar-rail"]')!
  expect(Array.from(rail.querySelectorAll("button"), (button) => button.getAttribute("aria-label"))).toEqual([
    "Current project",
    "Open project",
    "Needs attention",
    "Library",
    "Settings",
  ])
  ;["Open project", "Needs attention", "Library", "Settings"].forEach((name) =>
    fireEvent.click(screen.getByRole("button", { name })),
  )
  expect([open, attention, library, settings].map((action) => action.mock.calls.length)).toEqual([1, 1, 1, 1])
  expect(rail.querySelector('[data-action="sidebar-library"]')?.parentElement?.querySelector("span")).toBeTruthy()
  setState("pending", false)
  expect(rail.querySelector('[data-action="sidebar-library"]')?.parentElement?.querySelector("span")).toBeNull()
  const panel = screen.getByText("Session navigation").parentElement!
  expect(panel.hasAttribute("inert")).toBe(true)
  setState("opened", true)
  expect(panel.hasAttribute("inert")).toBe(false)
  expect(document.querySelector("#deepagent-code-icon-library path")?.getAttribute("stroke-linecap")).toBe("round")
  expect(document.querySelector("#deepagent-code-icon-terminal rect")?.getAttribute("rx")).toBe("2.25")
})

it("keeps Library knowledge scoped and history/archive global through actual panels and SDK HTTP", async () => {
  const calls: Array<{ method: string; path: string; directory: string | null; body: unknown }> = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    response.setHeader("Access-Control-Allow-Methods", "GET, PATCH, POST, DELETE, OPTIONS")
    if (request.method === "OPTIONS") return response.writeHead(204).end()
    const url = new URL(request.url!, "http://localhost")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    calls.push({
      method: request.method!,
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    })
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/global/projects")
      return response.end(
        JSON.stringify([
          { id: "current", worktree: "/current workspace", name: "Current workspace" },
          { id: "historical", worktree: "/historical", name: "Historical workspace" },
        ]),
      )
    if (url.pathname === "/experimental/session")
      return response.end(
        JSON.stringify([
          {
            id: "archived-session",
            directory: "/archived workspace",
            title: "Original archived task",
            time: { created: 1, updated: 2, archived: 3 },
          },
        ]),
      )
    if (url.pathname === "/deepagent/knowledge/pending") return response.end('{"items":[]}')
    if (url.pathname === "/deepagent/env-facts") return response.end('{"adopted":[],"pending":[]}')
    if (request.method === "PATCH" && url.pathname === "/session/archived-session") return response.end("{}")
    response.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Library HTTP fixture did not bind")
  const global = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  const scoped = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/current workspace",
    throwOnError: true,
  })
  const open = vi.fn()
  const [scope, setScope] = createStore({ current: true })
  function Launcher() {
    const dialog = useDialog()
    return (
      <button
        onClick={() =>
          dialog.show(() => (
            <DialogLibrary
              current={() => scope.current}
              knowledge={{
                client: scoped as unknown as ComponentProps<typeof DialogLibrary>["knowledge"]["client"],
                wikiAvailable: false,
              }}
              history={{
                client: global as unknown as ComponentProps<typeof DialogLibrary>["history"]["client"],
                activeWorktrees: new Set(["/current workspace"]),
                onOpen: open,
              }}
              archived={{ client: global }}
            />
          ))
        }
      >
        Open Library
      </button>
    )
  }
  try {
    render(() => (
      <DialogProvider>
        <Launcher />
      </DialogProvider>
    ))
    fireEvent.click(screen.getByRole("button", { name: "Open Library" }))
    await screen.findByRole("dialog", { name: dict["sidebar.library"] })
    await waitFor(() => expect(calls.some((call) => call.path === "/deepagent/knowledge/pending")).toBe(true))
    expect(screen.queryByRole("tab", { name: dict["knowledge.tab.wiki"] })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: dict["sidebar.history"] }))
    fireEvent.click(await screen.findByRole("button", { name: /Historical workspace/ }))
    expect(open).toHaveBeenCalledWith("/historical")
    expect(screen.queryByRole("button", { name: /Current workspace/ })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: dict["session.archived.title"] }))
    await screen.findByText("Original archived task")
    fireEvent.click(screen.getByRole("button", { name: dict["common.delete"] }))
    expect(screen.getByRole("button", { name: dict["session.delete.button"] })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: dict["common.cancel"] }))
    expect(screen.queryByRole("button", { name: dict["session.delete.button"] })).toBeNull()
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: dict["session.archived.restore"] }))
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true))
    const read = calls.find((call) => call.path === "/experimental/session")!
    expect(read.directory).toBeNull()
    expect(calls.find((call) => call.path === "/global/projects")?.directory).toBeNull()
    expect(
      calls
        .filter((call) => call.path.startsWith("/deepagent/"))
        .every(
          (call) =>
            call.directory === "/current workspace" || call.directory === encodeURIComponent("/current workspace"),
        ),
    ).toBe(true)
    const restore = calls.find((call) => call.method === "PATCH")!
    expect(restore.directory).toBe("/archived workspace")
    expect(restore.body).toEqual({ time: { archived: null } })
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1)
    fireEvent.click(screen.getByRole("tab", { name: dict["sidebar.history"] }))
    const menu = await screen.findByRole("button", { name: dict["common.moreOptions"] })
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: dict["common.delete"] }), { key: "Enter" })
    await screen.findByRole("dialog", { name: dict["project.delete.title"] })
    expect(screen.getByRole("button", { name: dict["project.delete.button"] })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: dict["common.cancel"] }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Open Library" }))
    await screen.findByRole("dialog", { name: dict["sidebar.library"] })
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/deepagent/knowledge/pending")).toHaveLength(2)
      expect(calls.filter((call) => call.path === "/deepagent/env-facts")).toHaveLength(2)
    })
    await screen.findByText(dict["review.empty"])
    setScope("current", false)
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.getByRole("status").textContent).toBe(dict["common.requestFailed"])
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
