import { beforeAll, describe, expect, mock, test } from "bun:test"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      tree: {
        state: () => undefined,
        list: () => Promise.resolve(),
        children: () => [],
        expand: () => {},
        collapse: () => {},
      },
    }),
  }))
  mock.module("@deepagent-code/ui/collapsible", () => ({
    Collapsible: {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    },
  }))
  mock.module("@deepagent-code/ui/file-icon", () => ({ FileIcon: () => null }))
  mock.module("@deepagent-code/ui/icon", () => ({ Icon: () => null }))
  mock.module("@deepagent-code/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  // The desktop file-management branch added ContextMenu, InlineInput, GitTimelineDialog, and
  // toast/language helpers to this module. Their Kobalte-backed UI leaves call solid-js/web
  // `template()` at module top level; under bun:test solid-js resolves to its server build and
  // those calls throw notSup(), so stub the leaves the way collapsible/tooltip are stubbed above.
  mock.module("@deepagent-code/ui/context-menu", () => ({
    ContextMenu: Object.assign(() => null, {
      Trigger: (props: { children?: unknown }) => props.children,
      Portal: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    }),
  }))
  mock.module("@deepagent-code/ui/dialog", () => ({
    Dialog: Object.assign(() => null, { Content: (props: { children?: unknown }) => props.children }),
  }))
  mock.module("@deepagent-code/ui/inline-input", () => ({ InlineInput: () => null }))
  mock.module("@deepagent-code/ui/toast", () => ({ showToast: () => undefined, Toast: () => null }))
  mock.module("@deepagent-code/ui/v2/toast-v2", () => ({ showToastV2: () => undefined, ToastV2: () => null }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = new Set<string>()
    const filter = { dirs: new Set(["src", "src/components"]) }

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) expanded.add(dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })
})
