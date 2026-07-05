import { beforeAll, describe, expect, mock, test } from "bun:test"
import { ServerScope } from "@/utils/server-scope"

let getWorkspaceTerminalCacheKey: typeof import("./terminal").getWorkspaceTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let _splitLeaf: typeof import("./terminal")._splitLeaf
let _collapseLeaf: typeof import("./terminal")._collapseLeaf
let _neighborLeafId: typeof import("./terminal")._neighborLeafId
let _removePtyFromTree: typeof import("./terminal")._removePtyFromTree
let _treeDepth: typeof import("./terminal")._treeDepth
let _getLeaves: typeof import("./terminal")._getLeaves
let _clonePaneTree: typeof import("./terminal")._clonePaneTree

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
  migrateTerminalState = mod.migrateTerminalState
  _splitLeaf = mod._splitLeaf
  _collapseLeaf = mod._collapseLeaf
  _neighborLeafId = mod._neighborLeafId
  _removePtyFromTree = mod._removePtyFromTree
  _treeDepth = mod._treeDepth
  _getLeaves = mod._getLeaves
  _clonePaneTree = mod._clonePaneTree
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

type Leaf = { kind: "leaf"; id: string; activeId?: string; ptys: string[] }
type Split = { kind: "split"; id: string; dir: string; sizes: [number, number]; children: [Node, Node] }
type Node = Leaf | Split
type Store = { root: Node; all: Array<Record<string, unknown>>; focusedPaneId: string }

const asStore = (value: unknown) => value as Store
const leaves = (node: Node): Leaf[] =>
  node.kind === "leaf" ? [node] : [...leaves(node.children[0]), ...leaves(node.children[1])]

describe("migrateTerminalState", () => {
  test("drops invalid terminals and upgrades the flat v2 shape to a single leaf", () => {
    const store = asStore(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    )

    expect(store.all).toEqual([
      { id: "one", title: "Terminal 2", titleNumber: 2 },
      { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
    ])
    expect(store.root.kind).toBe("leaf")
    const root = store.root as Leaf
    expect(root.ptys).toEqual(["one", "two"])
    // active "missing" is invalid → the leaf owns no such pty, so activeId is dropped.
    expect(root.activeId).toBeUndefined()
    expect(store.focusedPaneId).toBe(root.id)
  })

  test("keeps a valid active id when upgrading the flat shape", () => {
    const store = asStore(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    )

    expect(store.all).toEqual([
      { id: "one", title: "Terminal 1", titleNumber: 1 },
      { id: "two", title: "shell", titleNumber: 7 },
    ])
    const root = store.root as Leaf
    expect(root.activeId).toBe("two")
    expect(root.ptys).toEqual(["one", "two"])
  })

  test("validates and reconciles a v3 pane tree, dropping dead ptys and re-homing orphans", () => {
    const store = asStore(
      migrateTerminalState({
        focusedPaneId: "leaf-b",
        all: [
          { id: "a", title: "a", titleNumber: 1 },
          { id: "b", title: "b", titleNumber: 2 },
          { id: "orphan", title: "orphan", titleNumber: 3 },
        ],
        root: {
          kind: "split",
          id: "split-1",
          dir: "horizontal",
          sizes: [0.7, 0.3],
          children: [
            { kind: "leaf", id: "leaf-a", activeId: "a", ptys: ["a", "dead"] },
            { kind: "leaf", id: "leaf-b", activeId: "gone", ptys: ["b", "gone"] },
          ],
        },
      }),
    )

    expect(store.root.kind).toBe("split")
    const all = leaves(store.root)
    const a = all.find((l) => l.id === "leaf-a")!
    const b = all.find((l) => l.id === "leaf-b")!
    // dead pty removed from leaf-a; orphan re-homed onto the first leaf.
    expect(a.ptys).toEqual(["a", "orphan"])
    expect(a.activeId).toBe("a")
    // "gone" was invalid → dropped; activeId falls back to first surviving pty.
    expect(b.ptys).toEqual(["b"])
    expect(b.activeId).toBe("b")
    expect(store.focusedPaneId).toBe("leaf-b")
  })

  test("collapses a v3 split whose child leaves both lose all ptys back to a single leaf", () => {
    const store = asStore(
      migrateTerminalState({
        all: [{ id: "keep", title: "keep", titleNumber: 1 }],
        root: {
          kind: "split",
          id: "split-1",
          dir: "vertical",
          sizes: [0.5, 0.5],
          children: [
            { kind: "leaf", id: "leaf-a", activeId: "dead-1", ptys: ["dead-1"] },
            { kind: "leaf", id: "leaf-b", activeId: "dead-2", ptys: ["dead-2"] },
          ],
        },
      }),
    )

    // Both children emptied → split collapses; the surviving leaf adopts the orphan "keep".
    expect(store.root.kind).toBe("leaf")
    const root = store.root as Leaf
    expect(root.ptys).toEqual(["keep"])
    expect(store.focusedPaneId).toBe(root.id)
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
