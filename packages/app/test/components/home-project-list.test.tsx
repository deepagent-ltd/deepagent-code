import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import Home from "@/pages/home"
import { dict } from "@/i18n/en"

const facts = vi.hoisted(() => ({
  projects: [] as { id: string; worktree: string; time: { created: number; updated: number } }[],
  ready: true,
  opened: [] as string[],
  touched: [] as string[],
  picked: 0,
}))

// The original Home and UI controls render observed project facts. These context
// boundaries provide no model, execution, filesystem or permission implementation.
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    get ready() { return facts.ready },
    data: { get project() { return facts.projects }, path: { home: "/private/observed-home" } },
  }),
}))
vi.mock("@/context/server", async (original) => ({
  ...(await original<typeof import("@/context/server")>()),
  useServer: () => ({
    key: "local", name: "Local Server", current: { type: "sidecar", http: { url: "http://127.0.0.1" } },
  }),
}))
vi.mock("@/context/global", () => ({
  useGlobal: () => ({
    servers: { health: { local: { healthy: true } } },
    createServerCtx: () => ({ projects: {
      open: (directory: string) => facts.opened.push(directory),
      touch: (directory: string) => facts.touched.push(directory),
    } }),
  }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({}) }))
vi.mock("@/components/directory-picker", () => ({ useDirectoryPicker: () => () => { facts.picked++ } }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {} }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))

beforeEach(() => {
  facts.projects = []
  facts.ready = true
  facts.opened = []
  facts.touched = []
  facts.picked = 0
})
afterEach(cleanup)

function mount() {
  return render(() => <MemoryRouter history={createMemoryHistory()}>
    <Route path="/" component={Home} />
    <Route path="/:directory" component={() => <div>Opened observed project</div>} />
  </MemoryRouter>)
}

it("renders the original empty Home when only the internal global placeholder exists", () => {
  facts.projects = [{ id: "global", worktree: "/", time: { created: 1, updated: 1 } }]
  const view = mount()
  expect(view.container.querySelectorAll("[data-home-project-row]")).toHaveLength(0)
  expect(screen.getByText(dict["home.empty.title"])).toBeTruthy()
  expect(screen.queryByText(dict["home.recentProjects"])).toBeNull()
  expect(screen.getByRole("button", { name: dict["home.newChat"] })).toBeTruthy()
  expect(screen.getByRole("button", { name: dict["command.project.open"] })).toBeTruthy()
  expect(facts.opened).toEqual([])
  expect(facts.picked).toBe(0)
})

it("keeps the five most recent real projects while a newer global placeholder consumes no slot", () => {
  facts.projects = [
    { id: "global", worktree: "/", time: { created: 99, updated: 99 } },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `project-${index}`, worktree: `/project-${index}`,
      time: { created: index, updated: index } })),
  ]
  const view = mount()
  const rows = [...view.container.querySelectorAll<HTMLElement>("[data-home-project-row]")]
  expect(rows.map((row) => row.dataset.projectWorktree)).toEqual([
    "/project-5", "/project-4", "/project-3", "/project-2", "/project-1",
  ])
  expect(screen.getByText(dict["home.recentProjects"])).toBeTruthy()
  expect(screen.queryByText(dict["home.empty.title"])).toBeNull()
  expect(facts.opened).toEqual([])
})

it("uses project identity rather than a root path heuristic and preserves the original open action", () => {
  facts.projects = [
    { id: "global", worktree: "/private/non-root-placeholder", time: { created: 10, updated: 10 } },
    { id: "actual-git-root", worktree: "/", time: { created: 9, updated: 9 } },
  ]
  const view = mount()
  const rows = [...view.container.querySelectorAll<HTMLElement>("[data-home-project-row]")]
  expect(rows.map((row) => row.dataset.projectWorktree)).toEqual(["/"])
  fireEvent.click(rows[0]!)
  expect(facts.opened).toEqual(["/"])
  expect(facts.touched).toEqual(["/"])
  expect(facts.picked).toBe(0)
})
