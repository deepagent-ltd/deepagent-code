import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createStore, produce } from "solid-js/store"
import { type ParentProps } from "solid-js"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type {
  Project,
  ProjectCurrentResponses,
  WorktreeListResponses,
  WorktreeSummaryResponses,
} from "@deepagent-code/sdk"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { decode64 } from "@/utils/base64"
import { SidePanelWorktree } from "@/pages/session/side-panel-worktree"
import { createWorkspaceRemoval, WorkspaceRemovalProvider } from "@/pages/layout/workspace-removal"
import { LayoutProvider, useLayout } from "@/context/layout"

const wiring = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  directory: (): string => "",
  toasts: [] as { variant?: string }[],
  layoutScope: (): string => "owned-layout",
  layoutProjects: (): Project[] => [],
  layoutOpened: (): { worktree: string; expanded: boolean }[] => [],
  layoutOpen: (_directory: string) => {},
  layoutClose: (_directory: string) => {},
}))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    scope: "owned-worktree-layout",
    get client() {
      return wiring.client!
    },
  }),
}))
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    ready: false,
    data: {
      get project() {
        return wiring.layoutProjects()
      },
    },
    child: (directory: string) => [
      {
        project: wiring
          .layoutProjects()
          .find((project) => project.worktree === directory || project.sandboxes.includes(directory))?.id,
      },
    ],
    project: { loadSessions: async () => {}, icon: () => {}, meta: () => {} },
  }),
}))
vi.mock("@/context/server", () => ({
  useServer: () => ({
    key: "owned-layout",
    scope: () => wiring.layoutScope(),
    projects: {
      list: () => wiring.layoutOpened(),
      open: (directory: string) => wiring.layoutOpen(directory),
      close: (directory: string) => wiring.layoutClose(directory),
      expand: () => {},
      collapse: () => {},
      move: () => {},
    },
  }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get client() {
      return wiring.client!
    },
    get directory() {
      return wiring.directory()
    },
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/utils/toast", () => ({ showToast: (value: { variant?: string }) => wiring.toasts.push(value) }))
afterEach(cleanup)

it("removes the captured workspace through SDK HTTP and leaves only its current route, preserving unrelated projects and late navigation", async () => {
  const primary = "/owned-primary"
  const linked = "/separate-path/linked"
  const other = "/another-project"
  const route = (directory: string, id = "") => `/${base64Encode(directory)}/session${id ? `/${id}` : ""}`
  const requests: { root: string | null; directory: string; force: boolean }[] = []
  const control = { fail: false, result: true, hold: undefined as Promise<void> | undefined }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    response.setHeader("Content-Type", "application/json")
    const url = new URL(request.url!, "http://localhost")
    if (url.pathname.endsWith("/safe-remove")) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { directory: string; force: boolean }
      const header = request.headers["x-deepagent-code-directory"]
      requests.push({
        root: url.searchParams.get("directory") ?? (typeof header === "string" ? decodeURIComponent(header) : null),
        ...body,
      })
      await control.hold
      response
        .writeHead(control.fail ? 409 : 200)
        .end(JSON.stringify(control.fail ? { name: "UnmergedWork" } : control.result))
      return
    }
    response.end(
      JSON.stringify(
        url.pathname.endsWith("/changes")
          ? { uncommitted: 0, ahead: 0 }
          : url.pathname.endsWith("/diff")
            ? { entries: [] }
            : { base: "main", additions: 0, deletions: 0, files: 0 },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Owned workspace HTTP peer did not bind")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  wiring.toasts = []
  vi.spyOn(window, "confirm").mockReturnValue(true)
  const [state, setState] = createStore({
    scope: "original-server",
    projects: [
      { id: "original-project", worktree: primary, sandboxes: [linked, "/kept-sibling"] },
      { id: "other-project", worktree: other, sandboxes: ["/other-linked"] },
    ],
    last: {
      [primary]: { directory: linked, id: "original-session" },
      [other]: { directory: other, id: "other-session" },
    } as Record<string, { directory: string; id: string }>,
    order: { [primary]: [primary, linked, "/kept-sibling"], [other]: [other, "/other-linked"] } as Record<
      string,
      string[]
    >,
    opened: [primary, linked, other],
  })
  const history = createMemoryHistory()
  history.set({ value: route(linked, "original-session") })
  const owner = { closed: 0, closedDirectories: [] as string[] }
  function Boundary(props: ParentProps) {
    const location = useLocation()
    const navigate = useNavigate()
    const removal = createWorkspaceRemoval({
      scope: () => state.scope,
      client: () => wiring.client!,
      project: () => state.projects.find((project) => project.id === "original-project"),
      currentDir: () => decode64(location.pathname.split("/")[1]) ?? "",
      lastSession: (root) => state.last[root],
      clearLastSession: (root) =>
        setState(
          "last",
          produce((draft) => {
            delete draft[root]
          }),
        ),
      removeSandbox: (project, directory) =>
        setState(
          "projects",
          produce((draft) => {
            const item = draft.find((item) => item.id === project.id && item.worktree === project.worktree)
            if (item) item.sandboxes = item.sandboxes.filter((sandbox) => sandbox !== directory)
          }),
        ),
      removeOrder: (root, directory) => setState("order", root, (order) => order.filter((item) => item !== directory)),
      closeProject: (directory) => setState("opened", (opened) => opened.filter((item) => item !== directory)),
      openProject: (root) => setState("opened", (opened) => (opened.includes(root) ? opened : [...opened, root])),
      navigate: (root) => navigate(route(root)),
    })
    return (
      <WorkspaceRemovalProvider value={removal}>
        <output>{location.pathname}</output>
        {props.children}
      </WorkspaceRemovalProvider>
    )
  }
  function Panel() {
    const params = useParams()
    wiring.directory = () => decode64(params.dir) ?? ""
    return (
      <SidePanelWorktree
        onClose={() => {
          owner.closed++
          owner.closedDirectories.push(wiring.directory())
        }}
      />
    )
  }
  const original = structuredClone(JSON.parse(JSON.stringify(state)))
  const reset = () => {
    setState(structuredClone(original))
    history.set({ value: route(linked, "original-session") })
  }
  try {
    render(() => (
      <MemoryRouter history={history} root={Boundary}>
        <Route path="/:dir/session/:id?" component={Panel} />
      </MemoryRouter>
    ))
    const remove = async () => fireEvent.click(await screen.findByRole("button", { name: "worktree.remove.action" }))
    control.fail = true
    await remove()
    await waitFor(() => expect(wiring.toasts.at(-1)?.variant).toBe("error"))
    expect(history.get()).toBe(route(linked, "original-session"))
    expect(state.opened).toContain(linked)
    expect(owner.closed).toBe(0)

    control.fail = false
    control.result = false
    wiring.toasts = []
    await remove()
    await waitFor(() => expect(wiring.toasts.at(-1)?.variant).toBe("error"))
    expect(state.projects[0].sandboxes).toContain(linked)
    control.result = true
    wiring.toasts = []
    await remove()
    await waitFor(() => expect(history.get()).toBe(route(primary)))
    expect(requests).toEqual(Array.from({ length: 3 }, () => ({ root: primary, directory: linked, force: false })))
    expect(state.last[primary]).toBeUndefined()
    expect(state.projects[0].sandboxes).toEqual(["/kept-sibling"])
    expect(state.order[primary]).toEqual([primary, "/kept-sibling"])
    expect(state.opened).toEqual([primary, other])
    expect(state.projects[1]).toEqual(original.projects[1])
    expect(state.last[other]).toEqual(original.last[other])
    expect(state.order[other]).toEqual(original.order[other])
    expect(owner.closed).toBe(1)
    expect(owner.closedDirectories).toEqual([linked])

    reset()
    const late = Promise.withResolvers<void>()
    control.hold = late.promise
    await remove()
    await waitFor(() => expect(requests).toHaveLength(4))
    history.set({ value: route(other, "unrelated-session") })
    late.resolve()
    await waitFor(() => expect(state.projects[0].sandboxes).toEqual(["/kept-sibling"]))
    expect(history.get()).toBe(route(other, "unrelated-session"))
    expect(state.last[other]?.id).toBe("other-session")
    expect(owner.closed).toBe(1)

    reset()
    const retired = Promise.withResolvers<void>()
    control.hold = retired.promise
    await remove()
    await waitFor(() => expect(requests).toHaveLength(5))
    setState("scope", "replacement-server")
    retired.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "worktree.remove.action" })).toHaveProperty("disabled", false),
    )
    expect(state.opened).toContain(linked)
    expect(state.projects[0].sandboxes).toContain(linked)
    expect(history.get()).toBe(route(linked, "original-session"))
    expect(owner.closed).toBe(1)
  } finally {
    control.hold = undefined
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it("resolves authoritative fresh-project metadata through the summary DTO and rejects unavailable or retired preflight", async () => {
  const primary = "/fresh-primary"
  const linked = "/independent-linked"
  const route = (directory: string) => `/${base64Encode(directory)}/session`
  const peer = {
    projectWorktree: primary as string | undefined,
    checkoutAvailable: true,
    hold: undefined as Promise<void> | undefined,
    projectRequests: [] as string[],
    listRequests: [] as string[],
    deletes: [] as { root: string | null; directory: string }[],
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    response.setHeader("Content-Type", "application/json")
    const url = new URL(request.url!, "http://localhost")
    if (url.pathname === "/project/current") {
      peer.projectRequests.push(url.searchParams.get("directory") ?? "")
      await peer.hold
      if (!peer.projectWorktree) {
        response.writeHead(503).end("{}")
        return
      }
      response.end(
        JSON.stringify({
          id: "fresh-project",
          worktree: peer.projectWorktree,
          vcs: "git",
          sandboxes: [],
          time: { created: 1, updated: 1 },
        } satisfies ProjectCurrentResponses[200]),
      )
      return
    }
    if (url.pathname === "/experimental/worktree") {
      peer.listRequests.push(url.searchParams.get("directory") ?? "")
      response.end(JSON.stringify([] satisfies WorktreeListResponses[200]))
      return
    }
    if (url.pathname.endsWith("/safe-remove")) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { directory: string }
      peer.deletes.push({ root: url.searchParams.get("directory"), directory: body.directory })
      response.end("true")
      return
    }
    const summary = {
      base: "main",
      additions: 0,
      deletions: 0,
      files: 0,
      ...(peer.checkoutAvailable && url.searchParams.get("directory") === linked ? { defaultCheckout: primary } : {}),
    } satisfies WorktreeSummaryResponses[200]
    response.end(
      JSON.stringify(
        url.pathname.endsWith("/changes")
          ? { uncommitted: 0, ahead: 0 }
          : url.pathname.endsWith("/diff")
            ? { entries: [] }
            : summary,
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fresh metadata HTTP peer did not bind")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  wiring.toasts = []
  vi.spyOn(window, "confirm").mockReturnValue(true)
  const [state, setState] = createStore({
    scope: "fresh-server",
    cache: [] as Project[],
    opened: [linked],
  })
  const completed: { project: { id: string; worktree: string }; directory: string }[] = []
  const opened: string[] = []
  const closed: string[] = []
  wiring.layoutScope = () => state.scope
  wiring.layoutProjects = () => state.cache
  wiring.layoutOpened = () => state.opened.map((worktree) => ({ worktree, expanded: true }))
  wiring.layoutOpen = (directory) => {
    opened.push(directory)
    setState("opened", (items) => (items.includes(directory) ? items : [...items, directory]))
  }
  wiring.layoutClose = (directory) => {
    closed.push(directory)
    setState("opened", (items) => items.filter((item) => item !== directory))
  }
  const history = createMemoryHistory()
  history.set({ value: route(linked) })
  function Boundary(props: ParentProps) {
    const location = useLocation()
    const navigate = useNavigate()
    const layout = useLayout()
    const removal = createWorkspaceRemoval({
      client: () => wiring.client!,
      scope: () => state.scope,
      project: () => state.cache[0],
      currentDir: () => decode64(location.pathname.split("/")[1]) ?? "",
      lastSession: () => undefined,
      clearLastSession: () => {},
      removeSandbox: (project, directory) => {
        if (directory === linked) completed.push({ project, directory })
        setState(
          "cache",
          produce((draft) => {
            const item = draft.find((item) => item.id === project.id && item.worktree === project.worktree)
            if (item) item.sandboxes = item.sandboxes.filter((sandbox) => sandbox !== directory)
          }),
        )
      },
      removeOrder: () => {},
      closeProject: layout.projects.close,
      openProject: layout.projects.open,
      navigate: (directory) => navigate(route(directory)),
    })
    return (
      <WorkspaceRemovalProvider value={removal}>
        <output>{location.pathname}</output>
        {props.children}
      </WorkspaceRemovalProvider>
    )
  }
  function LayoutBoundary(props: ParentProps) {
    return (
      <LayoutProvider>
        <Boundary>{props.children}</Boundary>
      </LayoutProvider>
    )
  }
  function Panel() {
    const params = useParams()
    wiring.directory = () => decode64(params.dir) ?? ""
    return <SidePanelWorktree onClose={() => {}} />
  }
  try {
    render(() => (
      <MemoryRouter history={history} root={LayoutBoundary}>
        <Route path="/:dir/session" component={Panel} />
      </MemoryRouter>
    ))
    const remove = async () => fireEvent.click(await screen.findByRole("button", { name: "worktree.remove.action" }))
    await remove()
    await waitFor(() => expect(peer.projectRequests).toEqual([linked]))
    await waitFor(() => expect(history.get()).toBe(route(primary)))
    expect(peer.deletes).toEqual([{ root: primary, directory: linked }])
    expect(peer.listRequests).toEqual([])
    expect(state.cache).toEqual([])
    expect(completed).toEqual([{ project: { id: "fresh-project", worktree: primary }, directory: linked }])

    history.set({ value: route(linked) })
    setState("cache", [
      {
        id: "fresh-project",
        worktree: linked,
        vcs: "git",
        sandboxes: [primary, "/kept-sibling"],
        icon: { color: "pink" },
        time: { created: 1, updated: 1 },
      },
    ])
    await waitFor(() => expect(state.opened).toEqual([linked]))
    peer.projectWorktree = linked
    await remove()
    await waitFor(() => expect(history.get()).toBe(route(primary)))
    expect(peer.projectRequests).toEqual([linked, linked])
    expect(peer.listRequests).toEqual([])
    expect(peer.deletes).toHaveLength(2)
    expect(completed[1]).toEqual({ project: { id: "fresh-project", worktree: linked }, directory: linked })
    expect(state.cache[0].worktree).toBe(linked)
    expect(state.opened).toEqual([primary])
    expect(state.cache[0].sandboxes).toEqual(["/kept-sibling"])
    expect(opened.at(-1)).toBe(primary)
    expect(closed).toContain(linked)

    history.set({ value: route(linked) })
    peer.checkoutAvailable = false
    wiring.toasts = []
    await remove()
    await waitFor(() => expect(wiring.toasts.at(-1)?.variant).toBe("error"))
    expect(peer.deletes).toHaveLength(2)
    expect(completed).toHaveLength(2)
    expect(history.get()).toBe(route(linked))

    peer.projectWorktree = undefined
    wiring.toasts = []
    await remove()
    await waitFor(() => expect(wiring.toasts.at(-1)?.variant).toBe("error"))
    expect(peer.deletes).toHaveLength(2)

    peer.projectWorktree = linked
    peer.checkoutAvailable = true
    const retired = Promise.withResolvers<void>()
    peer.hold = retired.promise
    await remove()
    await waitFor(() => expect(peer.projectRequests).toHaveLength(5))
    expect(screen.getByRole("button", { name: "worktree.remove.action" })).toHaveProperty("disabled", true)
    await remove()
    expect(peer.projectRequests).toHaveLength(5)
    setState("scope", "replacement-server")
    retired.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "worktree.remove.action" })).toHaveProperty("disabled", false),
    )
    expect(peer.deletes).toHaveLength(2)
    expect(peer.listRequests).toEqual([])
    expect(completed).toHaveLength(2)
    expect(history.get()).toBe(route(linked))

    const moved = Promise.withResolvers<void>()
    peer.hold = moved.promise
    await remove()
    await waitFor(() => expect(peer.projectRequests).toHaveLength(6))
    history.set({ value: route("/different-project") })
    moved.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "worktree.remove.action" })).toHaveProperty("disabled", false),
    )
    expect(peer.deletes).toHaveLength(2)
    expect(history.get()).toBe(route("/different-project"))

    history.set({ value: route(linked) })
    const disposed = Promise.withResolvers<void>()
    peer.hold = disposed.promise
    await remove()
    await waitFor(() => expect(peer.projectRequests).toHaveLength(7))
    cleanup()
    disposed.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(peer.deletes).toHaveLength(2)
    expect(completed).toHaveLength(2)
  } finally {
    peer.hold = undefined
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
