import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@deepagent-code/ui/context"
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "./sdk"
import type { Platform } from "./platform"
import { useServer } from "./server"
import { defaultTitle, titleNumber } from "./terminal-title"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"
import { uuid } from "@/utils/uuid"

// ─── Pane tree types (V3.7 Phase 4.2) ────────────────────────────────────────

export type PaneId = string

/** Leaf node: owns an ordered list of PTYs, one of which is active */
export type PaneLeaf = {
  kind: "leaf"
  id: PaneId
  activeId: string | undefined
  ptys: string[] // PTY ids owned by this leaf (ordered)
}

/** Split node: two children arranged horizontally or vertically */
export type PaneSplit = {
  kind: "split"
  id: PaneId
  dir: "horizontal" | "vertical"
  /** sizes[0] + sizes[1] === 1.0 */
  sizes: readonly [number, number]
  children: readonly [PaneNode, PaneNode]
}

export type PaneNode = PaneLeaf | PaneSplit

/** Top-level store shape (V3.7) */
export type TerminalStore = {
  root: PaneNode
  all: LocalPTY[]
  focusedPaneId: PaneId
}

const MAX_SPLIT_DEPTH = 3

// ─── Pure tree helpers ────────────────────────────────────────────────────────

function findLeafById(root: PaneNode, id: PaneId): PaneLeaf | undefined {
  if (root.kind === "leaf") return root.id === id ? root : undefined
  return findLeafById(root.children[0], id) ?? findLeafById(root.children[1], id)
}

function findLeafForPty(root: PaneNode, ptyId: string): PaneLeaf | undefined {
  if (root.kind === "leaf") return root.ptys.includes(ptyId) ? root : undefined
  return findLeafForPty(root.children[0], ptyId) ?? findLeafForPty(root.children[1], ptyId)
}

function findParent(
  root: PaneNode,
  id: PaneId,
): { parent: PaneSplit; index: 0 | 1 } | undefined {
  if (root.kind === "leaf") return undefined
  for (let i = 0; i < 2; i++) {
    if (root.children[i].id === id) return { parent: root, index: i as 0 | 1 }
    const found = findParent(root.children[i], id)
    if (found) return found
  }
  return undefined
}

function replaceNode(root: PaneNode, id: PaneId, replacement: PaneNode): PaneNode {
  if (root.id === id) return replacement
  if (root.kind === "leaf") return root
  return {
    ...root,
    children: [
      replaceNode(root.children[0], id, replacement),
      replaceNode(root.children[1], id, replacement),
    ] as [PaneNode, PaneNode],
  }
}

function getLeaves(root: PaneNode): PaneLeaf[] {
  if (root.kind === "leaf") return [root]
  return [...getLeaves(root.children[0]), ...getLeaves(root.children[1])]
}

function treeDepth(root: PaneNode): number {
  if (root.kind === "leaf") return 1
  return 1 + Math.max(treeDepth(root.children[0]), treeDepth(root.children[1]))
}

/** Level of a leaf: 1 for the root leaf, +1 per enclosing split. */
function leafLevel(root: PaneNode, id: PaneId, depth = 1): number | undefined {
  if (root.kind === "leaf") return root.id === id ? depth : undefined
  return leafLevel(root.children[0], id, depth + 1) ?? leafLevel(root.children[1], id, depth + 1)
}

/** Descend to the leaf on the given side (0 = first/top-left, 1 = last/bottom-right). */
function edgeLeaf(node: PaneNode, side: 0 | 1): PaneLeaf {
  let current = node
  while (current.kind === "split") current = current.children[side]
  return current
}

/** Replace a leaf's fields, returning a new tree. */
function updateLeaf(root: PaneNode, id: PaneId, patch: Partial<Omit<PaneLeaf, "kind" | "id">>): PaneNode {
  if (root.kind === "leaf") return root.id === id ? { ...root, ...patch } : root
  return {
    ...root,
    children: [updateLeaf(root.children[0], id, patch), updateLeaf(root.children[1], id, patch)] as [
      PaneNode,
      PaneNode,
    ],
  }
}

/** Split a leaf into two, keeping its ptys on the first child and the new pty on the second. */
function splitLeaf(
  root: PaneNode,
  leafId: PaneId,
  dir: "horizontal" | "vertical",
  newLeaf: PaneLeaf,
): PaneNode {
  const leaf = findLeafById(root, leafId)
  if (!leaf) return root
  const split: PaneSplit = {
    kind: "split",
    id: uuid(),
    dir,
    sizes: [0.5, 0.5],
    children: [leaf, newLeaf],
  }
  return replaceNode(root, leafId, split)
}

// ── @internal: exported thin wrappers for unit tests only ──────────────────────
/** @internal */ export const _splitLeaf = (root: PaneNode, leafId: PaneId, dir: "horizontal" | "vertical", newLeaf: PaneLeaf) => splitLeaf(root, leafId, dir, newLeaf)
/** @internal */ export const _collapseLeaf = (root: PaneNode, leafId: PaneId) => collapseLeaf(root, leafId)
/** @internal */ export const _neighborLeafId = (root: PaneNode, focusedId: PaneId, dir: "left" | "right" | "up" | "down") => neighborLeafId(root, focusedId, dir)
/** @internal */ export const _removePtyFromTree = (root: PaneNode, ptyId: string) => removePtyFromTree(root, ptyId)
/** @internal */ export const _treeDepth = (root: PaneNode) => treeDepth(root)
/** @internal */ export const _getLeaves = (root: PaneNode) => getLeaves(root)

/** Remove a pty from whatever leaf owns it; collapse the leaf into its sibling when it empties. */
function removePtyFromTree(root: PaneNode, ptyId: string): PaneNode {
  const leaf = findLeafForPty(root, ptyId)
  if (!leaf) return root

  const nextPtys = leaf.ptys.filter((p) => p !== ptyId)
  const nextActive =
    leaf.activeId === ptyId
      ? (() => {
          const idx = leaf.ptys.indexOf(ptyId)
          return nextPtys[idx] ?? nextPtys[idx - 1] ?? nextPtys[0]
        })()
      : leaf.activeId

  if (nextPtys.length > 0) {
    return updateLeaf(root, leaf.id, { ptys: nextPtys, activeId: nextActive })
  }

  // Leaf is now empty: collapse it into its sibling (or clear it if it is the root).
  return collapseLeaf(root, leaf.id)
}

/** Remove a leaf, replacing its parent split with the surviving sibling. Root leaf is emptied in place. */
function collapseLeaf(root: PaneNode, leafId: PaneId): PaneNode {
  const parent = findParent(root, leafId)
  if (!parent) {
    // Root leaf: keep an empty leaf so the tree always has one.
    if (root.kind === "leaf" && root.id === leafId) return { ...root, ptys: [], activeId: undefined }
    return root
  }
  const sibling = parent.parent.children[parent.index === 0 ? 1 : 0]
  return replaceNode(root, parent.parent.id, sibling)
}

/** Reorder a pty within its owning leaf. */
function reorderPtyInLeaf(root: PaneNode, ptyId: string, toIndex: number): PaneNode {
  const leaf = findLeafForPty(root, ptyId)
  if (!leaf) return root
  const from = leaf.ptys.indexOf(ptyId)
  if (from === -1) return root
  const next = leaf.ptys.slice()
  next.splice(from, 1)
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, ptyId)
  return updateLeaf(root, leaf.id, { ptys: next })
}

/** Compute the neighbouring leaf id in a direction, tiling-wm style. */
function neighborLeafId(root: PaneNode, focusedId: PaneId, dir: "left" | "right" | "up" | "down"): PaneId | undefined {
  const wantDir: PaneSplit["dir"] = dir === "left" || dir === "right" ? "horizontal" : "vertical"
  const towardSecond = dir === "right" || dir === "down"
  let currentId = focusedId
  for (;;) {
    const p = findParent(root, currentId)
    if (!p) return undefined
    if (p.parent.dir === wantDir) {
      if (towardSecond && p.index === 0) return edgeLeaf(p.parent.children[1], 0).id
      if (!towardSecond && p.index === 1) return edgeLeaf(p.parent.children[0], 1).id
    }
    currentId = p.parent.id
  }
}

/** Swap a pty id inside its owning leaf (used when a pty is recreated via clone). */
function replacePtyIdInTree(root: PaneNode, oldId: string, newId: string): PaneNode {
  const leaf = findLeafForPty(root, oldId)
  if (!leaf) return root
  return updateLeaf(root, leaf.id, {
    ptys: leaf.ptys.map((p) => (p === oldId ? newId : p)),
    activeId: leaf.activeId === oldId ? newId : leaf.activeId,
  })
}

/** Move a pty from its current leaf to another leaf; collapse the source if it empties. */
function movePtyBetweenLeaves(root: PaneNode, ptyId: string, targetLeafId: PaneId): PaneNode {
  const source = findLeafForPty(root, ptyId)
  const target = findLeafById(root, targetLeafId)
  if (!source || !target || source.id === target.id) return root

  const withoutSource = removePtyFromTree(root, ptyId)
  // removePtyFromTree may have collapsed the source; the target leaf survives regardless.
  const stillTarget = findLeafById(withoutSource, targetLeafId)
  if (!stillTarget) return withoutSource
  const nextPtys = [...stillTarget.ptys, ptyId]
  return updateLeaf(withoutSource, targetLeafId, { ptys: nextPtys, activeId: ptyId })
}

/** Set a split node's sizes. */
function updateSplitSizes(root: PaneNode, splitId: PaneId, next: readonly [number, number]): PaneNode {
  if (root.kind === "leaf") return root
  if (root.id === splitId) return { ...root, sizes: next }
  return {
    ...root,
    children: [
      updateSplitSizes(root.children[0], splitId, next),
      updateSplitSizes(root.children[1], splitId, next),
    ] as [PaneNode, PaneNode],
  }
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Upgrade old flat {active,all} state to the pane-tree TerminalStore */
export function migrateToPaneModel(old: {
  active?: string
  all: LocalPTY[]
}): TerminalStore {
  const rootId = uuid()
  return {
    all: old.all,
    focusedPaneId: rootId,
    root: {
      kind: "leaf",
      id: rootId,
      activeId: old.active,
      ptys: old.all.map((p) => p.id),
    },
  }
}

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
}

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberFromTitle(title: string) {
  return titleNumber(title, MAX_TERMINAL_SESSIONS)
}

function pty(value: unknown): LocalPTY | undefined {
  if (!record(value)) return

  const id = text(value.id)
  if (!id) return

  const title = text(value.title) ?? ""
  const number = num(value.titleNumber)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = text(value.buffer)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)

  return {
    id,
    title,
    titleNumber: number && number > 0 ? number : (numberFromTitle(title) ?? 0),
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}

function normalizePtys(value: unknown): { all: LocalPTY[]; active?: string } {
  const seen = new Set<string>()
  const record_ = record(value) ? value : {}
  const all = (Array.isArray(record_.all) ? record_.all : []).flatMap((item) => {
    const next = pty(item)
    if (!next || seen.has(next.id)) return []
    seen.add(next.id)
    return [next]
  })
  const active = text(record_.active)
  return { all, active: active && seen.has(active) ? active : undefined }
}

function sizes(value: unknown): readonly [number, number] {
  if (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    value[0] > 0 &&
    value[1] > 0
  ) {
    const total = value[0] + value[1]
    if (total > 0) return [value[0] / total, value[1] / total]
  }
  return [0.5, 0.5]
}

/** Parse a persisted pane node, keeping only ptys that exist in `valid`. */
function paneNode(value: unknown, valid: Set<string>): PaneNode | undefined {
  if (!record(value)) return
  const id = text(value.id)
  if (!id) return

  if (value.kind === "split") {
    const rawChildren = Array.isArray(value.children) ? value.children : []
    const first = paneNode(rawChildren[0], valid)
    const second = paneNode(rawChildren[1], valid)
    if (first && second) {
      const dir = value.dir === "vertical" ? "vertical" : "horizontal"
      return { kind: "split", id, dir, sizes: sizes(value.sizes), children: [first, second] }
    }
    // Collapse to whichever child survived.
    return first ?? second
  }

  const ptys = (Array.isArray(value.ptys) ? value.ptys : []).flatMap((p) =>
    typeof p === "string" && valid.has(p) ? [p] : [],
  )
  const activeCandidate = text(value.activeId)
  const activeId = activeCandidate && ptys.includes(activeCandidate) ? activeCandidate : ptys[0]
  return { kind: "leaf", id, activeId, ptys }
}

/** Collapse leaves that hold no ptys into their sibling; a single empty root leaf survives. */
function pruneEmptyLeaves(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return node
  const first = pruneEmptyLeaves(node.children[0])
  const second = pruneEmptyLeaves(node.children[1])
  const firstEmpty = first.kind === "leaf" && first.ptys.length === 0
  const secondEmpty = second.kind === "leaf" && second.ptys.length === 0
  if (firstEmpty && !secondEmpty) return second
  if (secondEmpty && !firstEmpty) return first
  if (firstEmpty && secondEmpty) return first
  return { ...node, children: [first, second] }
}

/** Reconcile a parsed tree with the authoritative pty list: assign orphans,
 *  prune stale empty leaves, and guarantee at least one leaf. */
function reconcileTree(root: PaneNode | undefined, all: LocalPTY[]): PaneNode {
  const assigned = new Set<string>()
  if (root) for (const leaf of getLeaves(root)) for (const p of leaf.ptys) assigned.add(p)
  const orphans = all.filter((p) => !assigned.has(p.id)).map((p) => p.id)

  if (!root) {
    return { kind: "leaf", id: uuid(), activeId: all[0]?.id, ptys: all.map((p) => p.id) }
  }

  root = pruneEmptyLeaves(root)

  if (orphans.length) {
    const leaves = getLeaves(root)
    const target = leaves[0]
    if (target) {
      const nextPtys = [...target.ptys, ...orphans]
      root = replaceNode(root, target.id, {
        ...target,
        ptys: nextPtys,
        activeId: target.activeId ?? nextPtys[0],
      })
    }
  }
  return root
}

function migrateStore(value: Record<string, unknown>): TerminalStore {
  const { all, active } = normalizePtys(value)
  const validIds = new Set(all.map((p) => p.id))

  if (value.root) {
    // v3 format: validate + reconcile.
    const parsed = paneNode(value.root, validIds)
    const root = reconcileTree(parsed, all)
    const leaves = getLeaves(root)
    const focusedRaw = text(value.focusedPaneId)
    const focusedPaneId =
      focusedRaw && leaves.some((l) => l.id === focusedRaw) ? focusedRaw : leaves[0]!.id
    return { root, all, focusedPaneId }
  }

  // v2 (old flat) format: upgrade to a single leaf.
  return migrateToPaneModel({ active, all })
}

export function migrateTerminalState(value: unknown) {
  if (!record(value)) return value
  return migrateStore(value)
}

export function getWorkspaceTerminalCacheKey(dir: string, scope: ServerScopeValue = ServerScope.local) {
  return ScopedKey.from(scope, dir, WORKSPACE_KEY)
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, TerminalCacheEntry>>()

const trimTerminal = (pty: LocalPTY) => {
  if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return pty
  return {
    ...pty,
    buffer: undefined,
    cursor: undefined,
    scrollY: undefined,
  }
}

function terminalPersistTarget(scope: ServerScopeValue, dir: string, legacy?: string[]) {
  return Persist.serverWorkspace(scope, dir, "terminal", legacy)
}

export function clearWorkspaceTerminals(
  dir: string,
  sessionIDs?: string[],
  platform?: Platform,
  scope: ServerScopeValue = ServerScope.local,
) {
  const key = getWorkspaceTerminalCacheKey(dir, scope)
  for (const cache of caches) {
    const entry = cache.get(key)
    entry?.value.clear()
  }

  void removePersisted(terminalPersistTarget(scope, dir), platform)

  if (scope !== ServerScope.local) return
  const legacy = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) {
    for (const key of getLegacyTerminalStorageKeys(dir, id)) {
      legacy.add(key)
    }
  }
  for (const key of legacy) {
    void removePersisted({ key }, platform)
  }
}

function createWorkspaceTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  scope: ServerScopeValue,
  legacySessionID?: string,
) {
  const legacy = scope === ServerScope.local ? getLegacyTerminalStorageKeys(dir, legacySessionID) : []

  const initialRootId = uuid()
  const [store, setStore, _, ready] = persisted(
    {
      ...terminalPersistTarget(scope, dir, legacy),
      migrate: migrateTerminalState,
    },
    createStore<TerminalStore>({
      all: [],
      focusedPaneId: initialRootId,
      root: { kind: "leaf", id: initialRootId, activeId: undefined, ptys: [] },
    }),
  )

  // ── tree read helpers over the reactive store ──
  const focusedLeaf = (): PaneLeaf => {
    return findLeafById(store.root, store.focusedPaneId) ?? getLeaves(store.root)[0]!
  }

  /**
   * Commit a rebuilt tree via reconcile keyed by `id`. Our pure tree helpers
   * return brand-new object graphs; a plain setStore("root", next) would swap
   * every node's proxy and remount all <Terminal> components (dropping their
   * WebSockets) on each edit — fatal for resize drags that fire per frame.
   * Reconciling by id keeps identity for unchanged subtrees so only the fields
   * that actually changed (a leaf's activeId, a split's sizes) update in place.
   */
  const setRoot = (next: PaneNode | ((prev: PaneNode) => PaneNode)) => {
    const value = typeof next === "function" ? next(store.root) : next
    setStore("root", reconcile(value, { key: "id", merge: false }))
  }

  /** Commit a new root, keeping focusedPaneId pointing at a real leaf. */
  const commitRoot = (nextRoot: PaneNode, nextFocused?: PaneId) => {
    const leaves = getLeaves(nextRoot)
    const focused =
      nextFocused && leaves.some((l) => l.id === nextFocused)
        ? nextFocused
        : leaves.some((l) => l.id === store.focusedPaneId)
          ? store.focusedPaneId
          : leaves[0]!.id
    batch(() => {
      setRoot(nextRoot)
      setStore("focusedPaneId", focused)
    })
  }

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = new Set(
      store.all.flatMap((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return [direct]
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
        (number) => !existingTitleNumbers.has(number),
      ) ?? 1
    )
  }

  const removeExited = (id: string) => {
    const index = store.all.findIndex((x) => x.id === id)
    if (index === -1) return
    batch(() => {
      setRoot((root) => removePtyFromTree(root, id))
      setStore(
        "all",
        produce((draft) => {
          draft.splice(index, 1)
        }),
      )
      // focusedPaneId may now point at a collapsed leaf; repair it.
      const leaves = getLeaves(store.root)
      if (!leaves.some((l) => l.id === store.focusedPaneId)) {
        setStore("focusedPaneId", leaves[0]!.id)
      }
    })
  }

  const unsub = sdk.event.on("pty.exited", (event: { properties: { id: string } }) => {
    removeExited(event.properties.id)
  })
  onCleanup(unsub)

  const update = (client: ReturnType<typeof useSDK>["client"], pty: Partial<LocalPTY> & { id: string }) => {
    const index = store.all.findIndex((x) => x.id === pty.id)
    const previous = index >= 0 ? store.all[index] : undefined
    if (index >= 0) {
      setStore("all", index, (item) => ({ ...item, ...pty }))
    }
    client.pty
      .update({
        ptyID: pty.id,
        title: pty.title,
        size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
      })
      .catch((error: unknown) => {
        if (previous) {
          const currentIndex = store.all.findIndex((item) => item.id === pty.id)
          if (currentIndex >= 0) setStore("all", currentIndex, previous)
        }
        console.error("Failed to update terminal", error)
      })
  }

  const clone = async (client: ReturnType<typeof useSDK>["client"], id: string) => {
    const index = store.all.findIndex((x) => x.id === id)
    const pty = store.all[index]
    if (!pty) return
    const next = await client.pty
      .create({
        title: pty.title,
      })
      .catch((error: unknown) => {
        console.error("Failed to clone terminal", error)
        return undefined
      })
    if (!next?.data) return

    batch(() => {
      setStore("all", index, {
        id: next.data.id,
        title: next.data.title ?? pty.title,
        titleNumber: pty.titleNumber,
        buffer: undefined,
        cursor: undefined,
        scrollY: undefined,
        rows: undefined,
        cols: undefined,
      })
      setRoot((root) => replacePtyIdInTree(root, id, next.data.id))
    })
  }

  /** Create a PTY on the server and hand its id to `place`, which mutates the tree. */
  const createPty = (place: (id: string, title: string, titleNumber: number) => void) => {
    if (store.all.length >= MAX_TERMINAL_SESSIONS) return
    const nextNumber = pickNextTerminalNumber()
    sdk.client.pty
      .create({ title: defaultTitle(nextNumber) })
      .then((pty: { data?: { id?: string; title?: string } }) => {
        const id = pty.data?.id
        if (!id) return
        const title = pty.data?.title ?? defaultTitle(nextNumber)
        batch(() => {
          setStore("all", store.all.length, { id, title, titleNumber: nextNumber })
          place(id, title, nextNumber)
        })
      })
      .catch((error: unknown) => {
        console.error("Failed to create terminal", error)
      })
  }

  return {
    ready,
    all: createMemo(() => store.all),
    root: createMemo(() => store.root),
    focusedPaneId: createMemo(() => store.focusedPaneId),
    active: createMemo(() => focusedLeaf().activeId),
    paneLevel(paneId: PaneId) {
      return leafLevel(store.root, paneId) ?? 1
    },
    canSplit(paneId: PaneId) {
      return (leafLevel(store.root, paneId) ?? 1) < MAX_SPLIT_DEPTH
    },
    leafPtys(paneId: PaneId) {
      return findLeafById(store.root, paneId)?.ptys ?? []
    },
    clear() {
      batch(() => {
        const rootId = uuid()
        setRoot({ kind: "leaf", id: rootId, activeId: undefined, ptys: [] })
        setStore("focusedPaneId", rootId)
        setStore("all", [])
      })
    },
    new() {
      const leafId = focusedLeaf().id
      createPty((id) => {
        setRoot((root) => {
          const leaf = findLeafById(root, leafId)
          if (!leaf) return root
          return updateLeaf(root, leafId, { ptys: [...leaf.ptys, id], activeId: id })
        })
      })
    },
    split(dir: "horizontal" | "vertical", paneId?: PaneId) {
      const leaf = (paneId ? findLeafById(store.root, paneId) : undefined) ?? focusedLeaf()
      const level = leafLevel(store.root, leaf.id) ?? 1
      if (level >= MAX_SPLIT_DEPTH) return
      const newLeafId = uuid()
      createPty((id) => {
        const newLeaf: PaneLeaf = { kind: "leaf", id: newLeafId, activeId: id, ptys: [id] }
        setRoot((root) => splitLeaf(root, leaf.id, dir, newLeaf))
        setStore("focusedPaneId", newLeafId)
      })
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      update(sdk.client, pty)
    },
    trim(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      if (index === -1) return
      setStore("all", index, (pty) => trimTerminal(pty))
    },
    trimAll() {
      setStore("all", (all) => {
        const next = all.map(trimTerminal)
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
    async clone(id: string) {
      await clone(sdk.client, id)
    },
    bind() {
      const client = sdk.client
      return {
        trim(id: string) {
          const index = store.all.findIndex((x) => x.id === id)
          if (index === -1) return
          setStore("all", index, (pty) => trimTerminal(pty))
        },
        update(pty: Partial<LocalPTY> & { id: string }) {
          update(client, pty)
        },
        async clone(id: string) {
          await clone(client, id)
        },
      }
    },
    open(id: string) {
      const leaf = findLeafForPty(store.root, id)
      if (!leaf) return
      commitRoot(updateLeaf(store.root, leaf.id, { activeId: id }), leaf.id)
    },
    activateInPane(paneId: PaneId, ptyId: string) {
      const leaf = findLeafById(store.root, paneId)
      if (!leaf || !leaf.ptys.includes(ptyId)) return
      commitRoot(updateLeaf(store.root, paneId, { activeId: ptyId }), paneId)
    },
    setFocusedPane(paneId: PaneId) {
      if (findLeafById(store.root, paneId)) setStore("focusedPaneId", paneId)
    },
    movePtyToPane(ptyId: string, targetPaneId: PaneId) {
      commitRoot(movePtyBetweenLeaves(store.root, ptyId, targetPaneId), targetPaneId)
    },
    resizePane(splitId: PaneId, sizes: readonly [number, number]) {
      setRoot((root) => updateSplitSizes(root, splitId, sizes))
    },
    focusNeighbor(dir: "left" | "right" | "up" | "down") {
      const next = neighborLeafId(store.root, store.focusedPaneId, dir)
      if (next) setStore("focusedPaneId", next)
    },
    next() {
      const leaf = focusedLeaf()
      const index = leaf.ptys.indexOf(leaf.activeId ?? "")
      if (leaf.ptys.length === 0) return
      const nextIndex = index === -1 ? 0 : (index + 1) % leaf.ptys.length
      commitRoot(updateLeaf(store.root, leaf.id, { activeId: leaf.ptys[nextIndex] }), leaf.id)
    },
    previous() {
      const leaf = focusedLeaf()
      if (leaf.ptys.length === 0) return
      const index = leaf.ptys.indexOf(leaf.activeId ?? "")
      const prevIndex = index <= 0 ? leaf.ptys.length - 1 : index - 1
      commitRoot(updateLeaf(store.root, leaf.id, { activeId: leaf.ptys[prevIndex] }), leaf.id)
    },
    async close(id: string) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index !== -1) {
        batch(() => {
          setRoot((root) => removePtyFromTree(root, id))
          setStore(
            "all",
            produce((all) => {
              all.splice(index, 1)
            }),
          )
          const leaves = getLeaves(store.root)
          if (!leaves.some((l) => l.id === store.focusedPaneId)) {
            setStore("focusedPaneId", leaves[0]!.id)
          }
        })
      }

      await sdk.client.pty.remove({ ptyID: id }).catch((error: unknown) => {
        console.error("Failed to close terminal", error)
      })
    },
    async closePane(paneId: PaneId) {
      const leaf = findLeafById(store.root, paneId)
      if (!leaf) return
      const ids = [...leaf.ptys]
      batch(() => {
        setRoot((root) => {
          let next = root
          for (const id of ids) next = removePtyFromTree(next, id)
          return next
        })
        setStore(
          "all",
          produce((all) => {
            for (const id of ids) {
              const idx = all.findIndex((p) => p.id === id)
              if (idx !== -1) all.splice(idx, 1)
            }
          }),
        )
        const leaves = getLeaves(store.root)
        if (!leaves.some((l) => l.id === store.focusedPaneId)) {
          setStore("focusedPaneId", leaves[0]!.id)
        }
      })
      for (const id of ids) {
        await sdk.client.pty.remove({ ptyID: id }).catch((error: unknown) => {
          console.error("Failed to close terminal", error)
        })
      }
    },
    move(id: string, to: number) {
      setRoot((root) => reorderPtyInLeaf(root, id, to))
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const server = useServer()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()
    const scope = server.scope()

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, legacySessionID: string | undefined, serverScope: ServerScopeValue) => {
      // Terminals are workspace-scoped so tabs persist while switching sessions in the same directory.
      const key = getWorkspaceTerminalCacheKey(dir, serverScope)
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(sdk, dir, serverScope, legacySessionID),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => loadWorkspace(params.dir!, params.id, scope))

    createEffect(
      on(
        () => ({ dir: params.dir, id: params.id, scope }),
        (next, prev) => {
          if (!prev?.dir) return
          if (next.dir === prev.dir && next.id === prev.id && next.scope === prev.scope) return
          if (next.dir === prev.dir && next.id && next.scope === prev.scope) return
          loadWorkspace(prev.dir, prev.id, prev.scope).trimAll()
        },
        { defer: true },
      ),
    )

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      root: () => workspace().root(),
      focusedPaneId: () => workspace().focusedPaneId(),
      paneLevel: (paneId: PaneId) => workspace().paneLevel(paneId),
      canSplit: (paneId: PaneId) => workspace().canSplit(paneId),
      leafPtys: (paneId: PaneId) => workspace().leafPtys(paneId),
      active: () => workspace().active(),
      new: () => workspace().new(),
      split: (dir: "horizontal" | "vertical", paneId?: PaneId) => workspace().split(dir, paneId),
      update: (pty: Partial<LocalPTY> & { id: string }) => workspace().update(pty),
      trim: (id: string) => workspace().trim(id),
      trimAll: () => workspace().trimAll(),
      clone: (id: string) => workspace().clone(id),
      bind: () => workspace(),
      open: (id: string) => workspace().open(id),
      activateInPane: (paneId: PaneId, ptyId: string) => workspace().activateInPane(paneId, ptyId),
      setFocusedPane: (paneId: PaneId) => workspace().setFocusedPane(paneId),
      movePtyToPane: (ptyId: string, targetPaneId: PaneId) => workspace().movePtyToPane(ptyId, targetPaneId),
      resizePane: (splitId: PaneId, sizes: readonly [number, number]) => workspace().resizePane(splitId, sizes),
      focusNeighbor: (dir: "left" | "right" | "up" | "down") => workspace().focusNeighbor(dir),
      close: (id: string) => workspace().close(id),
      closePane: (paneId: PaneId) => workspace().closePane(paneId),
      move: (id: string, to: number) => workspace().move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
