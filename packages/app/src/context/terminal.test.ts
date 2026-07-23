import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerScope } from "@/utils/server-scope"

let getWorkspaceTerminalCacheKey: typeof import("./terminal").getWorkspaceTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let _splitLeaf: typeof import("./terminal")._splitLeaf
let _collapseLeaf: typeof import("./terminal")._collapseLeaf
let _neighborLeafId: typeof import("./terminal")._neighborLeafId
let _removePtyFromTree: typeof import("./terminal")._removePtyFromTree
let _treeDepth: typeof import("./terminal")._treeDepth
let _getLeaves: typeof import("./terminal")._getLeaves
let _clonePaneTree: typeof import("./terminal")._clonePaneTree
let createTerminalSession: (typeof import("./terminal").TerminalTesting)["createWorkspaceTerminalSession"]

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@deepagent-code/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
    useData: () => undefined,
    DataProvider: () => undefined,
    useDialog: () => undefined,
    DialogProvider: () => undefined,
    useI18n: () => ({ t: (key: string) => key }),
    I18nProvider: () => undefined,
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  _splitLeaf = mod._splitLeaf
  _collapseLeaf = mod._collapseLeaf
  _neighborLeafId = mod._neighborLeafId
  _removePtyFromTree = mod._removePtyFromTree
  _treeDepth = mod._treeDepth
  _getLeaves = mod._getLeaves
  _clonePaneTree = mod._clonePaneTree
  createTerminalSession = mod.TerminalTesting.createWorkspaceTerminalSession
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo"))).toBe("local\u0000/repo\u0000__workspace__")
  })

  test("can include a server scope", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo", "ssh:debian" as ServerScope))).toBe(
      "ssh:debian\u0000/repo\u0000__workspace__",
    )
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

// ── V3.7 pane pure-function regression tests (P2 补强) ─────────────────────────
// These guard splitLeaf / collapseLeaf / neighborLeafId / removePtyFromTree so
// structural changes to the pane tree helpers stay visible immediately.

type PL = { kind: "leaf"; id: string; activeId: string | undefined; ptys: string[] }
type PS = { kind: "split"; id: string; dir: "horizontal" | "vertical"; sizes: [number, number]; children: [PN, PN] }
type PN = PL | PS

function mkLeaf(id: string, ptys: string[] = [], active?: string): PL {
  return { kind: "leaf", id, ptys, activeId: active ?? ptys[0] }
}

describe("pane tree helpers", () => {
  test("splitLeaf creates a split with equal sizes", () => {
    const root = mkLeaf("root", ["a"])
    const second = mkLeaf("second", ["b"], "b")
    const next = _splitLeaf(root, "root", "vertical", second) as PS
    expect(next.kind).toBe("split")
    expect(next.dir).toBe("vertical")
    expect(next.sizes).toEqual([0.5, 0.5])
    const [left, right] = next.children as [PL, PL]
    expect(left.id).toBe("root")
    expect(right.id).toBe("second")
  })

  test("splitLeaf is a no-op when leafId is not found", () => {
    const root = mkLeaf("root", ["a"])
    expect(_splitLeaf(root, "missing", "vertical", mkLeaf("x"))).toBe(root)
  })

  test("treeDepth returns 1 for a single leaf", () => {
    expect(_treeDepth(mkLeaf("a"))).toBe(1)
  })

  test("treeDepth returns 2 for one split", () => {
    const split = _splitLeaf(mkLeaf("a"), "a", "vertical", mkLeaf("b"))
    expect(_treeDepth(split)).toBe(2)
  })

  test("getLeaves returns all leaf nodes", () => {
    const root = mkLeaf("root", ["a"])
    const split = _splitLeaf(root, "root", "vertical", mkLeaf("second", ["b"]))
    const leaves = _getLeaves(split)
    expect(leaves.map((l) => l.id).sort()).toEqual(["root", "second"])
  })

  test("collapseLeaf removes a leaf and its parent split merges with the sibling", () => {
    // root → split(left, right); close left → root becomes right
    const left = mkLeaf("left", ["a"])
    const right = mkLeaf("right", ["b"])
    const split = _splitLeaf(left, "left", "vertical", right)
    const collapsed = _collapseLeaf(split, "left")
    expect(collapsed.kind).toBe("leaf")
    expect((collapsed as PL).id).toBe("right")
  })

  test("collapseLeaf on the root leaf empties it in-place (always keeps one leaf)", () => {
    const root = mkLeaf("root", ["a"])
    const result = _collapseLeaf(root, "root") as PL
    // The root can't be removed — implementation returns { ...root, ptys:[], activeId:undefined }
    expect(result.kind).toBe("leaf")
    expect(result.id).toBe("root")
    expect(result.ptys).toEqual([])
    expect(result.activeId).toBeUndefined()
  })

  test("removePtyFromTree removes a pty and collapses empty leaf", () => {
    // root(a) → split(root, second(b))
    const root = mkLeaf("root", ["a"], "a")
    const second = mkLeaf("second", ["b"], "b")
    const split = _splitLeaf(root, "root", "horizontal", second)
    // Remove 'a' from root; root leaf empties → collapses back to second
    const next = _removePtyFromTree(split, "a")
    expect(next.kind).toBe("leaf")
    expect((next as PL).id).toBe("second")
  })

  test("removePtyFromTree is a no-op for unknown pty", () => {
    const root = mkLeaf("root", ["a"])
    expect(_removePtyFromTree(root, "unknown")).toStrictEqual(root)
  })

  test("neighborLeafId returns the sibling leaf", () => {
    // neighborLeafId uses "horizontal" split for left/right navigation
    // and "vertical" split for up/down (matching the implementation).
    const left = mkLeaf("left", ["a"])
    const right = mkLeaf("right", ["b"])
    const split = _splitLeaf(left, "left", "horizontal", right) as PS
    expect(_neighborLeafId(split, "left", "right")).toBe("right")
    expect(_neighborLeafId(split, "right", "left")).toBe("left")
    // vertical split → up/down navigation
    const top = mkLeaf("top", ["c"])
    const bottom = mkLeaf("bottom", ["d"])
    const vsplit = _splitLeaf(top, "top", "vertical", bottom) as PS
    expect(_neighborLeafId(vsplit, "top", "down")).toBe("bottom")
    expect(_neighborLeafId(vsplit, "bottom", "up")).toBe("top")
  })

  test("neighborLeafId returns undefined when there is only one leaf", () => {
    const root = mkLeaf("root", ["a"])
    expect(_neighborLeafId(root, "root", "right")).toBeUndefined()
  })
})

describe("clonePaneTree (circular-structure regression)", () => {
  test("splitting a store-proxy leaf yields a plain, JSON-safe, acyclic tree", async () => {
    const { createStore, unwrap } = await import("solid-js/store")
    // Mirror the real bug: the leaf being split lives inside the reactive store,
    // so splitLeaf embeds a live proxy as children[0]. Before the fix, cloning
    // was absent and reconcile/JSON.stringify hit a circular structure.
    const [store] = createStore({ root: mkLeaf("root", ["a"]) as ReturnType<typeof mkLeaf> })
    const proxyLeaf = store.root // a Solid store proxy
    const split = _splitLeaf(proxyLeaf, "root", "vertical", mkLeaf("second", ["b"], "b"))

    const cloned = _clonePaneTree(split)

    // Serializable without throwing "circular structure".
    expect(() => JSON.stringify(cloned)).not.toThrow()
    // Structure preserved.
    const roundTrip = JSON.parse(JSON.stringify(cloned))
    expect(roundTrip.kind).toBe("split")
    expect(roundTrip.children.map((c: { id: string }) => c.id)).toEqual(["root", "second"])
    // Detached from the store: the clone shares no identity with the proxy.
    expect(cloned).not.toBe(split)
    expect((cloned as PS).children[0]).not.toBe(unwrap(proxyLeaf))
  })
})

function terminalHarness(
  create: () => Promise<{ data?: { id: string; title: string } }>,
  runtime: { id: () => string | undefined; ensure: () => Promise<void> } = {
    id: () => "runtime-1",
    ensure: async () => undefined,
  },
) {
  const sdk = {
    directory: "/repo",
    url: "http://localhost:4096",
    client: {
      pty: {
        create,
        remove: async () => ({ response: new Response(null, { status: 200 }) }),
        update: async () => ({ response: new Response(null, { status: 200 }) }),
      },
    },
    event: { on: () => () => undefined },
  } as unknown as Parameters<typeof createTerminalSession>[0]
  return createRoot((dispose) => ({
    session: createTerminalSession(sdk, runtime),
    dispose,
  }))
}

describe("runtime terminal controller", () => {
  test("keeps frontend tab identity separate from the server PTY handle", async () => {
    const harness = terminalHarness(async () => ({ data: { id: "pty-server-1", title: "Terminal 1" } }))
    try {
      expect(await harness.session.new()).toBeTrue()
      const tab = harness.session.all()[0]!
      expect(tab.id).not.toBe(tab.ptyId)
      expect(tab.ptyId).toBe("pty-server-1")
      expect((harness.session.root() as PL).ptys).toEqual([tab.id])
    } finally {
      harness.dispose()
    }
  })

  test("starts PTY creation without waiting for the advisory runtime check", async () => {
    let ensureCalls = 0
    let createCalls = 0
    const harness = terminalHarness(
      async () => {
        createCalls += 1
        return { data: { id: "pty-server-1", title: "Terminal 1" } }
      },
      {
        id: () => undefined,
        ensure: () => {
          ensureCalls += 1
          return new Promise<void>(() => undefined)
        },
      },
    )
    try {
      expect(await harness.session.new()).toBeTrue()
      expect(ensureCalls).toBe(1)
      expect(createCalls).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  test("does not commit a split when server creation fails", async () => {
    let fail = false
    let sequence = 0
    const harness = terminalHarness(async () => {
      if (fail) throw new Error("spawn failed")
      sequence += 1
      return { data: { id: `pty-${sequence}`, title: `Terminal ${sequence}` } }
    })
    try {
      await harness.session.new()
      const paneId = harness.session.focusedPaneId()
      harness.session.setPaneBounds(paneId, { width: 600, height: 300 })
      const before = JSON.stringify(harness.session.root())
      fail = true

      expect(await harness.session.split("horizontal")).toBeFalse()
      expect(JSON.stringify(harness.session.root())).toBe(before)
      expect(harness.session.all()).toHaveLength(1)
      expect(harness.session.createError()?.message).toBe("spawn failed")
    } finally {
      harness.dispose()
    }
  })

  test("keeps every pane populated across consecutive nested splits", async () => {
    let sequence = 0
    const harness = terminalHarness(async () => {
      sequence += 1
      return { data: { id: `pty-${sequence}`, title: `Terminal ${sequence}` } }
    })
    try {
      expect(harness.session.canSplit(harness.session.focusedPaneId())).toBeFalse()
      await harness.session.new()
      harness.session.setPaneBounds(harness.session.focusedPaneId(), { width: 1_600, height: 400 })
      expect(await harness.session.split("horizontal")).toBeTrue()

      harness.session.setPaneBounds(harness.session.focusedPaneId(), { width: 800, height: 400 })
      expect(await harness.session.split("horizontal")).toBeTrue()

      harness.session.setPaneBounds(harness.session.focusedPaneId(), { width: 530, height: 400 })
      expect(await harness.session.split("horizontal")).toBeTrue()

      const leaves = _getLeaves(harness.session.root())
      expect(leaves).toHaveLength(4)
      expect(leaves.every((leaf) => leaf.ptys.length === 1 && leaf.activeId === leaf.ptys[0])).toBeTrue()
      expect(new Set(leaves.flatMap((leaf) => leaf.ptys))).toEqual(new Set(harness.session.all().map((pty) => pty.id)))
    } finally {
      harness.dispose()
    }
  })

  test("drops a stale create completion after the server runtime changes", async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let resolveCreate: ((value: { data: { id: string; title: string } }) => void) | undefined
    const harness = terminalHarness(
      () =>
        new Promise((resolve) => {
          markStarted?.()
          resolveCreate = resolve
        }),
    )
    try {
      const create = harness.session.new()
      await started
      harness.session.resetRuntime()
      resolveCreate?.({ data: { id: "pty-stale", title: "Terminal 1" } })

      expect(await create).toBeFalse()
      expect(harness.session.all()).toEqual([])
      expect(harness.session.root().kind).toBe("leaf")
      expect(harness.session.closeRequest()).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  test("collapses a split to its surviving pane when closing that pane's final terminal", async () => {
    let sequence = 0
    const harness = terminalHarness(async () => {
      sequence += 1
      return { data: { id: `pty-${sequence}`, title: `Terminal ${sequence}` } }
    })
    try {
      await harness.session.new()
      harness.session.setPaneBounds(harness.session.focusedPaneId(), { width: 1_000, height: 400 })
      expect(await harness.session.split("horizontal")).toBeTrue()

      const [first, second] = harness.session.all()
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      await harness.session.close(second!.id)

      const root = harness.session.root()
      expect(root.kind).toBe("leaf")
      if (root.kind !== "leaf") throw new Error("expected split to collapse to a leaf")
      expect(root.ptys).toEqual([first!.id])
      expect(root.activeId).toBe(first!.id)
      expect(harness.session.focusedPaneId()).toBe(root.id)
      expect(harness.session.closeRequest()).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  test("requests panel close only when the user closes the final tab", async () => {
    const harness = terminalHarness(async () => ({ data: { id: "pty-server-1", title: "Terminal 1" } }))
    try {
      await harness.session.new()
      const id = harness.session.all()[0]!.id
      expect(harness.session.closeRequest()).toBe(0)

      await harness.session.close(id)
      expect(harness.session.closeRequest()).toBe(1)
    } finally {
      harness.dispose()
    }
  })
})
