import { createStore } from "solid-js/store"
import { createSimpleContext } from "@deepagent-code/ui/context"
import { batch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "./sdk"
import { usePlatform, type Platform } from "./platform"
import { useServer } from "./server"
import { defaultTitle, titleNumber } from "./terminal-title"
import { withServerAbortRetry } from "./terminal-retry"
import { Persist, removePersisted } from "@/utils/persist"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"
import { uuid } from "@/utils/uuid"
import { formatServerError } from "@/utils/server-errors"

export type PaneId = string

export type PaneLeaf = {
  kind: "leaf"
  id: PaneId
  activeId: string | undefined
  ptys: string[]
}

export type PaneSplit = {
  kind: "split"
  id: PaneId
  dir: "horizontal" | "vertical"
  sizes: readonly [number, number]
  children: readonly [PaneNode, PaneNode]
}

export type PaneNode = PaneLeaf | PaneSplit

export type TerminalStatus = "connecting" | "ready" | "reconnecting" | "exited" | "error"
export type TerminalOperation = "create" | "connect" | "resize" | "rename" | "close"

export type TerminalFailure = {
  operation: TerminalOperation
  code: string
  message: string
  status?: number
  ptyId?: string
  directory?: string
  runtimeId?: string
}

export type LocalPTY = {
  /** Stable frontend tab identity. Never sent to the PTY server. */
  id: string
  /** Process handle owned by the current server runtime. */
  ptyId: string
  title: string
  titleNumber: number
  status: TerminalStatus
  error?: TerminalFailure
}

export type TerminalStore = {
  root: PaneNode
  all: LocalPTY[]
  focusedPaneId: PaneId
}

export type PaneBounds = { width: number; height: number }

export const MAX_SPLIT_DEPTH = 8
export const MAX_TERMINAL_PANES = 8
export const MIN_TERMINAL_PANE_WIDTH = 160
export const MIN_TERMINAL_PANE_HEIGHT = 160

const MAX_TERMINAL_SESSIONS = 20
const WORKSPACE_KEY = "__workspace__"
const RUNTIME_POLL_MS = 5_000

function findLeafById(root: PaneNode, id: PaneId): PaneLeaf | undefined {
  if (root.kind === "leaf") return root.id === id ? root : undefined
  return findLeafById(root.children[0], id) ?? findLeafById(root.children[1], id)
}

function findLeafForPty(root: PaneNode, id: string): PaneLeaf | undefined {
  if (root.kind === "leaf") return root.ptys.includes(id) ? root : undefined
  return findLeafForPty(root.children[0], id) ?? findLeafForPty(root.children[1], id)
}

function findParent(root: PaneNode, id: PaneId): { parent: PaneSplit; index: 0 | 1 } | undefined {
  if (root.kind === "leaf") return
  for (const index of [0, 1] as const) {
    if (root.children[index].id === id) return { parent: root, index }
    const found = findParent(root.children[index], id)
    if (found) return found
  }
}

function replaceNode(root: PaneNode, id: PaneId, replacement: PaneNode): PaneNode {
  if (root.id === id) return replacement
  if (root.kind === "leaf") return root
  return {
    ...root,
    children: [replaceNode(root.children[0], id, replacement), replaceNode(root.children[1], id, replacement)],
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

function leafLevel(root: PaneNode, id: PaneId, depth = 1): number | undefined {
  if (root.kind === "leaf") return root.id === id ? depth : undefined
  return leafLevel(root.children[0], id, depth + 1) ?? leafLevel(root.children[1], id, depth + 1)
}

function edgeLeaf(node: PaneNode, side: 0 | 1): PaneLeaf {
  if (node.kind === "leaf") return node
  return edgeLeaf(node.children[side], side)
}

function clonePaneTree(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return { kind: "leaf", id: node.id, activeId: node.activeId, ptys: [...node.ptys] }
  return {
    kind: "split",
    id: node.id,
    dir: node.dir,
    sizes: [node.sizes[0], node.sizes[1]],
    children: [clonePaneTree(node.children[0]), clonePaneTree(node.children[1])],
  }
}

function updateLeaf(root: PaneNode, id: PaneId, patch: Partial<Omit<PaneLeaf, "kind" | "id">>): PaneNode {
  if (root.kind === "leaf") return root.id === id ? { ...root, ...patch } : root
  return {
    ...root,
    children: [updateLeaf(root.children[0], id, patch), updateLeaf(root.children[1], id, patch)],
  }
}

function splitLeaf(root: PaneNode, leafId: PaneId, dir: PaneSplit["dir"], newLeaf: PaneLeaf): PaneNode {
  const leaf = findLeafById(root, leafId)
  if (!leaf) return root
  return replaceNode(root, leafId, {
    kind: "split",
    id: uuid(),
    dir,
    sizes: [0.5, 0.5],
    children: [leaf, newLeaf],
  })
}

function balanceSplits(root: PaneNode, dir: PaneSplit["dir"]): PaneNode {
  if (root.kind === "leaf") return root
  const children = [balanceSplits(root.children[0], dir), balanceSplits(root.children[1], dir)] as const
  if (root.dir !== dir) return { ...root, children }
  const first = getLeaves(children[0]).length
  const second = getLeaves(children[1]).length
  return { ...root, sizes: [first / (first + second), second / (first + second)], children }
}

function collapseLeaf(root: PaneNode, leafId: PaneId): PaneNode {
  const parent = findParent(root, leafId)
  if (!parent) {
    if (root.kind === "leaf" && root.id === leafId) return { ...root, ptys: [], activeId: undefined }
    return root
  }
  return replaceNode(root, parent.parent.id, parent.parent.children[parent.index === 0 ? 1 : 0])
}

function removePtyFromTree(root: PaneNode, id: string): PaneNode {
  const leaf = findLeafForPty(root, id)
  if (!leaf) return root
  const ptys = leaf.ptys.filter((item) => item !== id)
  const activeId =
    leaf.activeId === id ? (ptys[leaf.ptys.indexOf(id)] ?? ptys[leaf.ptys.indexOf(id) - 1] ?? ptys[0]) : leaf.activeId
  if (ptys.length) return updateLeaf(root, leaf.id, { ptys, activeId })
  return collapseLeaf(root, leaf.id)
}

function reorderPtyInLeaf(root: PaneNode, id: string, toIndex: number): PaneNode {
  const leaf = findLeafForPty(root, id)
  if (!leaf) return root
  const from = leaf.ptys.indexOf(id)
  if (from === -1) return root
  const ptys = leaf.ptys.slice()
  ptys.splice(from, 1)
  ptys.splice(Math.max(0, Math.min(toIndex, ptys.length)), 0, id)
  return updateLeaf(root, leaf.id, { ptys })
}

function movePtyBetweenLeaves(root: PaneNode, id: string, targetLeafId: PaneId): PaneNode {
  const source = findLeafForPty(root, id)
  const target = findLeafById(root, targetLeafId)
  if (!source || !target || source.id === target.id) return root
  const withoutSource = removePtyFromTree(root, id)
  const nextTarget = findLeafById(withoutSource, targetLeafId)
  if (!nextTarget) return withoutSource
  return updateLeaf(withoutSource, targetLeafId, { ptys: [...nextTarget.ptys, id], activeId: id })
}

function updateSplitSizes(root: PaneNode, splitId: PaneId, sizes: readonly [number, number]): PaneNode {
  if (root.kind === "leaf") return root
  if (root.id === splitId) return { ...root, sizes }
  return {
    ...root,
    children: [updateSplitSizes(root.children[0], splitId, sizes), updateSplitSizes(root.children[1], splitId, sizes)],
  }
}

function neighborLeafId(root: PaneNode, focusedId: PaneId, dir: "left" | "right" | "up" | "down") {
  const wanted = dir === "left" || dir === "right" ? "horizontal" : "vertical"
  const second = dir === "right" || dir === "down"
  let current = focusedId
  for (;;) {
    const parent = findParent(root, current)
    if (!parent) return
    if (parent.parent.dir === wanted) {
      if (second && parent.index === 0) return edgeLeaf(parent.parent.children[1], 0).id
      if (!second && parent.index === 1) return edgeLeaf(parent.parent.children[0], 1).id
    }
    current = parent.parent.id
  }
}

/** @internal */ export const _splitLeaf = splitLeaf
/** @internal */ export const _collapseLeaf = collapseLeaf
/** @internal */ export const _neighborLeafId = neighborLeafId
/** @internal */ export const _removePtyFromTree = removePtyFromTree
/** @internal */ export const _treeDepth = treeDepth
/** @internal */ export const _getLeaves = getLeaves
/** @internal */ export const _clonePaneTree = clonePaneTree

function errorStatus(error: unknown) {
  if (error instanceof Error && error.cause && typeof error.cause === "object") {
    const status = (error.cause as { status?: unknown }).status
    if (typeof status === "number") return status
  }
  if (!error || typeof error !== "object") return
  const response = (error as { response?: unknown }).response
  if (response instanceof Response) return response.status
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

export function terminalFailure(input: {
  operation: TerminalOperation
  error: unknown
  status?: number
  ptyId?: string
  directory?: string
  runtimeId?: string
}): TerminalFailure {
  const status = input.status ?? errorStatus(input.error)
  const code =
    status === 404
      ? "PTY_NOT_FOUND"
      : status === 403
        ? "PTY_FORBIDDEN"
        : status === 503
          ? "SERVER_RESTARTING"
          : `PTY_${input.operation.toUpperCase()}_FAILED`
  return {
    operation: input.operation,
    code,
    message: formatServerError(input.error, undefined, `Terminal ${input.operation} failed`),
    ...(status !== undefined ? { status } : {}),
    ...(input.ptyId ? { ptyId: input.ptyId } : {}),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
  }
}

function logFailure(failure: TerminalFailure) {
  const log = failure.status === 404 ? console.info : console.error
  log("[terminal] operation failed", failure)
}

function notifyCreateFailed(failure: TerminalFailure) {
  return import("@/utils/toast")
    .then(({ showToast }) =>
      showToast({ variant: "error", title: "Failed to open terminal", description: failure.message }),
    )
    .catch(() => undefined)
}

export function getWorkspaceTerminalCacheKey(dir: string, scope: ServerScopeValue = ServerScope.local) {
  return ScopedKey.from(scope, dir, WORKSPACE_KEY)
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

function terminalPersistTarget(scope: ServerScopeValue, dir: string) {
  return Persist.serverWorkspace(scope, dir, "terminal")
}

function removeTerminalPersistence(
  dir: string,
  sessionIDs: string[] | undefined,
  platform: Platform,
  scope: ServerScopeValue,
) {
  removePersisted(terminalPersistTarget(scope, dir), platform)
  if (scope !== ServerScope.local) return
  const keys = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) for (const key of getLegacyTerminalStorageKeys(dir, id)) keys.add(key)
  for (const key of keys) removePersisted({ key }, platform)
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>
const sessions = new Set<{ dir: string; scope: ServerScopeValue; value: TerminalSession }>()

export function clearWorkspaceTerminals(
  dir: string,
  sessionIDs?: string[],
  platform?: Platform,
  scope: ServerScopeValue = ServerScope.local,
) {
  for (const entry of sessions) {
    if (entry.dir === dir && entry.scope === scope) entry.value.clear()
  }
  if (platform) removeTerminalPersistence(dir, sessionIDs, platform, scope)
}

function createWorkspaceTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  runtime: { id: () => string | undefined; ensure: () => Promise<void> },
) {
  const rootId = uuid()
  const [store, setStore] = createStore({ all: [] as LocalPTY[] })
  const [root, setRootSignal] = createSignal<PaneNode>({
    kind: "leaf",
    id: rootId,
    activeId: undefined,
    ptys: [],
  })
  const [focusedPaneId, setFocusedPaneId] = createSignal(rootId)
  const [paneBounds, setPaneBounds] = createSignal<Record<PaneId, PaneBounds>>({})
  const [pendingVersion, setPendingVersion] = createSignal(0)
  const [createError, setCreateError] = createSignal<TerminalFailure>()
  const [closeRequest, setCloseRequest] = createSignal(0)
  const pendingCreates = new Set<string>()
  const pendingRetries = new Set<string>()
  const pendingSplitLeaves = new Set<PaneId>()
  const pendingTitleNumbers = new Set<number>()
  let generation = 0

  const touchPending = () => setPendingVersion((value) => value + 1)
  const focusedLeaf = () => findLeafById(root(), focusedPaneId()) ?? edgeLeaf(root(), 0)
  const setRoot = (next: PaneNode | ((root: PaneNode) => PaneNode)) => {
    const value = typeof next === "function" ? next(root()) : next
    setRootSignal(clonePaneTree(value))
  }
  const commitRoot = (next: PaneNode, focused?: PaneId) => {
    const leaves = getLeaves(next)
    const nextFocused =
      focused && leaves.some((leaf) => leaf.id === focused)
        ? focused
        : leaves.some((leaf) => leaf.id === focusedPaneId())
          ? focusedPaneId()
          : edgeLeaf(next, 0).id
    batch(() => {
      setRoot(next)
      setFocusedPaneId(nextFocused)
    })
  }
  const reset = () => {
    generation += 1
    pendingCreates.clear()
    pendingRetries.clear()
    pendingSplitLeaves.clear()
    pendingTitleNumbers.clear()
    setCreateError(undefined)
    setPaneBounds({})
    touchPending()
    const id = uuid()
    batch(() => {
      setRoot({ kind: "leaf", id, activeId: undefined, ptys: [] })
      setFocusedPaneId(id)
      setStore("all", [])
    })
  }
  const pickTitleNumber = () => {
    const used = new Set(
      store.all.flatMap((pty) => {
        if (Number.isFinite(pty.titleNumber) && pty.titleNumber > 0) return [pty.titleNumber]
        const parsed = titleNumber(pty.title, MAX_TERMINAL_SESSIONS)
        return parsed === undefined ? [] : [parsed]
      }),
    )
    for (const number of pendingTitleNumbers) used.add(number)
    return Array.from({ length: used.size + 1 }, (_, index) => index + 1).find((number) => !used.has(number)) ?? 1
  }
  const discard = async (ptyId: string) => {
    const result = await sdk.client.pty.remove({ ptyID: ptyId }, { throwOnError: false })
    if (result.response?.ok || result.response?.status === 404) return
    logFailure(
      terminalFailure({
        operation: "close",
        error: result.error,
        status: result.response?.status,
        ptyId,
        directory: sdk.directory,
        runtimeId: runtime.id(),
      }),
    )
  }
  const canSplitLeaf = (paneId: PaneId, direction: PaneSplit["dir"], allowPending = false) => {
    pendingVersion()
    const leaf = findLeafById(root(), paneId)
    const bounds = paneBounds()[paneId]
    const available = direction === "horizontal" ? bounds?.width : bounds?.height
    const minimum = direction === "horizontal" ? MIN_TERMINAL_PANE_WIDTH : MIN_TERMINAL_PANE_HEIGHT
    return (
      Boolean(leaf?.activeId && leaf.ptys.includes(leaf.activeId)) &&
      (leaf ? (leafLevel(root(), leaf.id) ?? MAX_SPLIT_DEPTH) : MAX_SPLIT_DEPTH) < MAX_SPLIT_DEPTH &&
      available !== undefined &&
      available >= minimum * 2 &&
      getLeaves(root()).length + pendingSplitLeaves.size <=
        (allowPending ? MAX_TERMINAL_PANES : MAX_TERMINAL_PANES - 1) &&
      (allowPending || !pendingSplitLeaves.has(paneId))
    )
  }
  const createPty = async (place: (pty: LocalPTY) => void, canPlace: () => boolean = () => true) => {
    if (store.all.length + pendingCreates.size >= MAX_TERMINAL_SESSIONS || !canPlace()) return false
    const requestId = uuid()
    const number = pickTitleNumber()
    pendingCreates.add(requestId)
    pendingTitleNumbers.add(number)
    setCreateError(undefined)
    touchPending()
    if (!runtime.id()) void runtime.ensure().catch(() => undefined)
    const epoch = generation
    try {
      const result = await withServerAbortRetry(() => sdk.client.pty.create({ title: defaultTitle(number) }))
      const ptyId = result.data?.id
      if (!ptyId) throw new Error("Terminal creation returned no PTY id")
      if (epoch !== generation) return false
      if (!canPlace()) {
        await discard(ptyId)
        return false
      }
      place({
        id: uuid(),
        ptyId,
        title: result.data?.title ?? defaultTitle(number),
        titleNumber: number,
        status: "connecting",
      })
      return true
    } catch (error) {
      if (epoch !== generation) return false
      const failure = terminalFailure({
        operation: "create",
        error,
        directory: sdk.directory,
        runtimeId: runtime.id(),
      })
      setCreateError(failure)
      logFailure(failure)
      void notifyCreateFailed(failure)
      return false
    } finally {
      pendingCreates.delete(requestId)
      pendingTitleNumbers.delete(number)
      touchPending()
    }
  }
  const removeLocal = (id: string) => {
    if (!store.all.some((pty) => pty.id === id)) return
    batch(() => {
      const next = removePtyFromTree(root(), id)
      const leaves = getLeaves(next)
      setRoot(next)
      setStore(
        "all",
        store.all.filter((pty) => pty.id !== id),
      )
      if (!leaves.some((leaf) => leaf.id === focusedPaneId())) setFocusedPaneId(edgeLeaf(next, 0).id)
    })
  }
  const markServerExit = (ptyId: string) => {
    const index = store.all.findIndex((pty) => pty.ptyId === ptyId)
    if (index === -1) return
    setStore("all", index, {
      status: "exited",
      error: terminalFailure({
        operation: "connect",
        error: new Error("Terminal process exited"),
        status: 404,
        ptyId,
        directory: sdk.directory,
        runtimeId: runtime.id(),
      }),
    })
  }

  const unsubExited = sdk.event.on("pty.exited", (event) => markServerExit(event.properties.id))
  const unsubDeleted = sdk.event.on("pty.deleted", (event) => markServerExit(event.properties.id))
  onCleanup(() => {
    unsubExited()
    unsubDeleted()
  })

  return {
    ready: () => true,
    all: createMemo(() => store.all),
    root,
    focusedPaneId,
    active: createMemo(() => focusedLeaf().activeId),
    creating: () => {
      pendingVersion()
      return pendingCreates.size > 0
    },
    createError,
    closeRequest,
    runtimeId: runtime.id,
    paneBounds,
    paneLevel: (paneId: PaneId) => leafLevel(root(), paneId) ?? 1,
    leafPtys: (paneId: PaneId) => findLeafById(root(), paneId)?.ptys ?? [],
    setPaneBounds(paneId: PaneId, bounds: PaneBounds | undefined) {
      setPaneBounds((current) => {
        if (bounds) return { ...current, [paneId]: bounds }
        const next = { ...current }
        delete next[paneId]
        return next
      })
    },
    canSplit(paneId: PaneId, direction: PaneSplit["dir"] = "horizontal") {
      return canSplitLeaf(paneId, direction)
    },
    resetRuntime() {
      reset()
    },
    clear() {
      const ptyIds = store.all.map((pty) => pty.ptyId)
      reset()
      for (const ptyId of ptyIds) void discard(ptyId)
    },
    async new() {
      const paneId = focusedLeaf().id
      return createPty(
        (pty) => {
          batch(() => {
            setStore("all", store.all.length, pty)
            setRoot((root) => {
              const leaf = findLeafById(root, paneId)
              if (!leaf) return root
              return updateLeaf(root, paneId, { ptys: [...leaf.ptys, pty.id], activeId: pty.id })
            })
          })
        },
        () => Boolean(findLeafById(root(), paneId)),
      )
    },
    async split(direction: PaneSplit["dir"], paneId?: PaneId) {
      const leaf = (paneId ? findLeafById(root(), paneId) : undefined) ?? focusedLeaf()
      if (!canSplitLeaf(leaf.id, direction)) return false
      const targetId = leaf.id
      const newLeafId = uuid()
      pendingSplitLeaves.add(targetId)
      touchPending()
      return createPty(
        (pty) => {
          batch(() => {
            setStore("all", store.all.length, pty)
            setRoot((root) =>
              balanceSplits(
                splitLeaf(root, targetId, direction, {
                  kind: "leaf",
                  id: newLeafId,
                  activeId: pty.id,
                  ptys: [pty.id],
                }),
                direction,
              ),
            )
            setFocusedPaneId(newLeafId)
          })
        },
        () => canSplitLeaf(targetId, direction, true),
      ).finally(() => {
        pendingSplitLeaves.delete(targetId)
        touchPending()
      })
    },
    async retry(id: string) {
      if (pendingRetries.has(id)) return false
      const current = store.all.find((pty) => pty.id === id)
      if (!current) return false
      pendingRetries.add(id)
      setStore("all", store.all.indexOf(current), { status: "connecting", error: undefined })
      if (!runtime.id()) void runtime.ensure().catch(() => undefined)
      const epoch = generation
      try {
        const result = await withServerAbortRetry(() => sdk.client.pty.create({ title: current.title }))
        const ptyId = result.data?.id
        if (!ptyId) throw new Error("Terminal creation returned no PTY id")
        const index = store.all.findIndex((pty) => pty.id === id)
        if (epoch !== generation || index === -1) {
          if (epoch === generation) await discard(ptyId)
          return false
        }
        const oldPtyId = store.all[index].ptyId
        setStore("all", index, {
          ptyId,
          title: result.data?.title ?? current.title,
          status: "connecting",
          error: undefined,
        })
        if (oldPtyId !== ptyId) void discard(oldPtyId)
        return true
      } catch (error) {
        const index = store.all.findIndex((pty) => pty.id === id)
        if (epoch !== generation || index === -1) return false
        const failure = terminalFailure({
          operation: "create",
          error,
          ptyId: store.all[index].ptyId,
          directory: sdk.directory,
          runtimeId: runtime.id(),
        })
        setStore("all", index, { status: "error", error: failure })
        logFailure(failure)
        return false
      } finally {
        pendingRetries.delete(id)
      }
    },
    setStatus(id: string, ptyId: string, status: TerminalStatus, error?: TerminalFailure) {
      const index = store.all.findIndex((pty) => pty.id === id && pty.ptyId === ptyId)
      if (index === -1) return
      setStore("all", index, { status, error: status === "ready" ? undefined : error })
    },
    update(input: Partial<LocalPTY> & { id: string }) {
      if (input.title === undefined) return
      const index = store.all.findIndex((pty) => pty.id === input.id)
      const pty = store.all[index]
      if (!pty || input.title === pty.title) return
      const previous = pty.title
      const ptyId = pty.ptyId
      setStore("all", index, "title", input.title)
      void sdk.client.pty.update({ ptyID: ptyId, title: input.title }, { throwOnError: false }).then((result) => {
        if (result.response?.ok) return
        const failure = terminalFailure({
          operation: "rename",
          error: result.error,
          status: result.response?.status,
          ptyId,
          directory: sdk.directory,
          runtimeId: runtime.id(),
        })
        const currentIndex = store.all.findIndex((item) => item.id === input.id && item.ptyId === ptyId)
        if (currentIndex === -1) return
        if (failure.status === 404) {
          setStore("all", currentIndex, { status: "exited", error: failure })
        } else if (store.all[currentIndex].title === input.title) {
          setStore("all", currentIndex, "title", previous)
        }
        logFailure(failure)
      })
    },
    open(id: string) {
      const leaf = findLeafForPty(root(), id)
      if (leaf) commitRoot(updateLeaf(root(), leaf.id, { activeId: id }), leaf.id)
    },
    activateInPane(paneId: PaneId, id: string) {
      const leaf = findLeafById(root(), paneId)
      if (leaf?.ptys.includes(id)) commitRoot(updateLeaf(root(), paneId, { activeId: id }), paneId)
    },
    setFocusedPane(paneId: PaneId) {
      if (findLeafById(root(), paneId)) setFocusedPaneId(paneId)
    },
    movePtyToPane(id: string, targetPaneId: PaneId) {
      commitRoot(movePtyBetweenLeaves(root(), id, targetPaneId), targetPaneId)
    },
    resizePane(splitId: PaneId, sizes: readonly [number, number]) {
      setRoot((root) => updateSplitSizes(root, splitId, sizes))
    },
    focusNeighbor(dir: "left" | "right" | "up" | "down") {
      const next = neighborLeafId(root(), focusedPaneId(), dir)
      if (next) setFocusedPaneId(next)
    },
    next() {
      const leaf = focusedLeaf()
      if (!leaf.ptys.length) return
      const index = leaf.ptys.indexOf(leaf.activeId ?? "")
      commitRoot(
        updateLeaf(root(), leaf.id, { activeId: leaf.ptys[index === -1 ? 0 : (index + 1) % leaf.ptys.length] }),
        leaf.id,
      )
    },
    previous() {
      const leaf = focusedLeaf()
      if (!leaf.ptys.length) return
      const index = leaf.ptys.indexOf(leaf.activeId ?? "")
      commitRoot(
        updateLeaf(root(), leaf.id, { activeId: leaf.ptys[index <= 0 ? leaf.ptys.length - 1 : index - 1] }),
        leaf.id,
      )
    },
    async close(id: string) {
      const closePanel = store.all.length === 1 && store.all[0]?.id === id
      const ptyId = store.all.find((pty) => pty.id === id)?.ptyId
      removeLocal(id)
      if (closePanel) setCloseRequest((value) => value + 1)
      if (ptyId) await discard(ptyId)
    },
    async closePane(paneId: PaneId) {
      const leaf = findLeafById(root(), paneId)
      if (!leaf) return
      const ids = [...leaf.ptys]
      const closePanel = ids.length > 0 && ids.length === store.all.length
      const ptyIds = store.all.filter((pty) => ids.includes(pty.id)).map((pty) => pty.ptyId)
      for (const id of ids) removeLocal(id)
      if (closePanel) setCloseRequest((value) => value + 1)
      await Promise.all(ptyIds.map(discard))
    },
    move(id: string, to: number) {
      setRoot((root) => reorderPtyInLeaf(root, id, to))
    },
  }
}

/** @internal */ export const TerminalTesting = { createWorkspaceTerminalSession }

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const server = useServer()
    const platform = usePlatform()
    const scope = server.scope()
    let runtimeId: string | undefined
    let runtimeRequest: Promise<void> | undefined
    let terminal: TerminalSession | undefined

    const ensureRuntime = () => {
      if (runtimeRequest) return runtimeRequest
      runtimeRequest = sdk.client.global
        .health({ cache: "no-store" })
        .then((result) => {
          const next = result.data?.runtimeId ?? sdk.url
          if (!runtimeId) {
            runtimeId = next
            return
          }
          if (runtimeId === next) return
          console.info("[terminal] server runtime changed", { previousRuntimeId: runtimeId, runtimeId: next })
          runtimeId = next
          terminal?.resetRuntime()
        })
        .catch((error) => {
          if (import.meta.env.DEV) console.debug("[terminal] runtime check failed", error)
        })
        .finally(() => {
          runtimeRequest = undefined
        })
      return runtimeRequest
    }

    terminal = createWorkspaceTerminalSession(sdk, { id: () => runtimeId, ensure: ensureRuntime })
    const registered = { dir: sdk.directory, scope, value: terminal }
    sessions.add(registered)
    removeTerminalPersistence(sdk.directory, undefined, platform, scope)

    onMount(() => {
      void ensureRuntime()
      const timer = setInterval(() => {
        if (terminal?.all().length) void ensureRuntime()
      }, RUNTIME_POLL_MS)
      onCleanup(() => clearInterval(timer))
    })
    onCleanup(() => {
      sessions.delete(registered)
      terminal?.clear()
    })

    return terminal
  },
})
