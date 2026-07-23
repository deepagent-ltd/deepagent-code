import { createStore } from "solid-js/store"
import { createSimpleContext } from "@deepagent-code/ui/context"
import { batch, createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext, type JSX, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
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
  /** True when restored from cross-project navigation cache; cleared on first ready. */
  restored?: boolean
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

/** Per-directory PTY snapshot preserved across project switches so PTYs survive navigation. */
export interface TerminalPtySnapshot {
  ptys: Array<Pick<LocalPTY, "id" | "ptyId" | "title" | "titleNumber">>
  root: PaneNode
  focusedPaneId: string
}

/** Entry for a single session's bottom + side PTY snapshots, with LRU metadata. */
interface SessionTerminalEntry {
  bottom: TerminalPtySnapshot | null
  side: TerminalPtySnapshot | null
  /** Monotonic counter used for LRU ordering — higher = more recently accessed. */
  lruTick: number
}

/**
 * Session-keyed terminal snapshot cache.
 * Key: ScopedKey.from(scope, dir, sessionKey) — scope + directory + session ID (or draft UUID).
 */
const sessionTerminalCache = new Map<string, SessionTerminalEntry>()

/**
 * Per-workspace discard helper registered by the mounted TerminalProvider.
 * Key: ScopedKey.from(scope, dir) — just scope + directory.
 * Used by clearWorkspaceTerminals to remove cached PTYs when no provider is mounted.
 */
const workspaceDiscardFn = new Map<string, (ptyId: string) => void>()

/** Max non-current session entries kept per {scope, directory} workspace. */
const MAX_CACHED_SESSION_ENTRIES = 5

let lruClock = 0
function nextLruTick(): number {
  return ++lruClock
}

/** Composite key for the whole workspace (scope + dir, no session). */
function workspaceScopeKey(scope: ServerScopeValue, dir: string): string {
  return ScopedKey.from(scope, dir)
}

/** Composite key for a specific session entry (scope + dir + sessionKey). */
function sessionEntryKey(scope: ServerScopeValue, dir: string, sessionKey: string): string {
  return ScopedKey.from(scope, dir, sessionKey)
}

/** Returns all cache entries whose key belongs to the given workspace. */
function getWorkspaceCacheEntries(scope: ServerScopeValue, dir: string): Array<[string, SessionTerminalEntry]> {
  const prefix = ScopedKey.prefix(scope, dir)
  const result: Array<[string, SessionTerminalEntry]> = []
  for (const [k, v] of sessionTerminalCache.entries()) {
    if (k.startsWith(prefix)) result.push([k, v])
  }
  return result
}

/**
 * Evict the least-recently-used non-current entries for a workspace so that at
 * most MAX_CACHED_SESSION_ENTRIES non-current entries remain.
 * Calls discardFn for each PTY ID of evicted entries.
 */
function evictLruEntries(
  scope: ServerScopeValue,
  dir: string,
  currentKey: string,
  discardFn: (ptyId: string) => void,
): void {
  const entries = getWorkspaceCacheEntries(scope, dir)
  const nonCurrent = entries.filter(([k]) => k !== currentKey)
  if (nonCurrent.length <= MAX_CACHED_SESSION_ENTRIES) return
  // Sort ascending: oldest (smallest lruTick) first
  nonCurrent.sort((a, b) => a[1].lruTick - b[1].lruTick)
  const toEvict = nonCurrent.slice(0, nonCurrent.length - MAX_CACHED_SESSION_ENTRIES)
  for (const [key, entry] of toEvict) {
    const ptyIds = [
      ...(entry.bottom?.ptys.map((p) => p.ptyId) ?? []),
      ...(entry.side?.ptys.map((p) => p.ptyId) ?? []),
    ]
    for (const ptyId of ptyIds) discardFn(ptyId)
    sessionTerminalCache.delete(key)
  }
}

/**
 * Invalidate all cached snapshots for the given server scope.
 * Called when the server restarts (runtimeId changes) — old PTY IDs are invalid.
 */
function invalidateScopeSnapshots(scope: ServerScopeValue): void {
  const prefix = scope + " "
  for (const key of sessionTerminalCache.keys()) {
    if (key.startsWith(prefix)) sessionTerminalCache.delete(key)
  }
}

export function clearWorkspaceTerminals(
  dir: string,
  sessionIDs?: string[],
  platform?: Platform,
  scope: ServerScopeValue = ServerScope.local,
) {
  // 1. Clear mounted sessions (calls pty.remove for their live PTYs).
  for (const entry of sessions) {
    if (entry.dir === dir && entry.scope === scope) entry.value.clear()
  }

  // 2. Clear cached session entries for this workspace.
  //    Use the registered discard fn if a provider is currently mounted; if none
  //    is mounted the server-side workspace teardown handles PTY cleanup.
  const wsKey = workspaceScopeKey(scope, dir)
  const discardFn = workspaceDiscardFn.get(wsKey)
  for (const [key, entry] of getWorkspaceCacheEntries(scope, dir)) {
    const ptyIds = [
      ...(entry.bottom?.ptys.map((p) => p.ptyId) ?? []),
      ...(entry.side?.ptys.map((p) => p.ptyId) ?? []),
    ]
    if (discardFn) {
      for (const ptyId of ptyIds) discardFn(ptyId)
    }
    sessionTerminalCache.delete(key)
  }

  if (platform) removeTerminalPersistence(dir, sessionIDs, platform, scope)
}

function createWorkspaceTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  runtime: { id: () => string | undefined; ensure: () => Promise<void> },
) {
  const rootId = uuid()
  const [store, setStore] = createStore({ all: [] as LocalPTY[] })
  // terminal.pty_create / terminal.websocket_ready telemetry:
  // Records the timestamp (performance.now()) when PTY create returns, keyed by server ptyId.
  // Consumed by setStatus when status transitions to "ready".
  const ptyCreateTimestamps = new Map<string, number>()
  // Distinguishes cold (first PTY in this session) from hot (subsequent) for telemetry.
  let ptyCreatedCount = 0
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
    // terminal.pty_create — start: about to call pty.create on the server
    const cold = ptyCreatedCount === 0
    const ptyCreateT0 = performance.now()
    try {
      // Race pty.create against a 10-second deadline.  Without this, a hung
      // server connection keeps pendingCreates non-empty forever and the UI
      // shows "正在启动终端..." indefinitely.
      const PTY_CREATE_TIMEOUT_MS = 10_000
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
          const err = new Error("Terminal creation timed out")
          ;(err as unknown as { cause: object }).cause = { status: 408, message: "pty.create timeout" }
          reject(err)
        }, PTY_CREATE_TIMEOUT_MS),
      )
      const result = await Promise.race([
        withServerAbortRetry(() => sdk.client.pty.create({ title: defaultTitle(number) })),
        timeoutPromise,
      ])
      const ptyId = result.data?.id
      if (!ptyId) throw new Error("Terminal creation returned no PTY id")
      // terminal.pty_create — end: server returned a PTY id
      const ptyCreateDurationMs = Math.round(performance.now() - ptyCreateT0)
      ptyCreatedCount++
      console.info("[startup] telemetry", {
        event: "terminal.pty_create",
        durationMs: ptyCreateDurationMs,
        ptyId,
        cold,
      })
      // Record the end of pty.create so setStatus can measure terminal.websocket_ready.
      ptyCreateTimestamps.set(ptyId, performance.now())
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
    snapshot(): TerminalPtySnapshot | null {
      if (store.all.length === 0) return null
      return {
        ptys: store.all.map((pty) => ({
          id: pty.id,
          ptyId: pty.ptyId,
          title: pty.title,
          titleNumber: pty.titleNumber,
        })),
        root: root(),
        focusedPaneId: focusedPaneId(),
      }
    },
    restore(snapshot: TerminalPtySnapshot) {
      batch(() => {
        setStore(
          "all",
          snapshot.ptys.map((p) => ({
            id: p.id,
            ptyId: p.ptyId,
            title: p.title,
            titleNumber: p.titleNumber,
            status: "connecting" as TerminalStatus,
            error: undefined,
            restored: true,
          })),
        )
        setRootSignal(clonePaneTree(snapshot.root))
        setFocusedPaneId(snapshot.focusedPaneId)
      })
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
      if (status === "ready") {
        // terminal.websocket_ready — end: WebSocket attached and terminal is ready
        const wsT0 = ptyCreateTimestamps.get(ptyId)
        if (wsT0 !== undefined) {
          console.info("[startup] telemetry", {
            event: "terminal.websocket_ready",
            durationMs: Math.round(performance.now() - wsT0),
            ptyId,
          })
          ptyCreateTimestamps.delete(ptyId)
        }
      }
      setStore("all", index, { status, error: status === "ready" ? undefined : error, ...(status === "ready" ? { restored: false } : {}) })
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

/** @internal */ export const TerminalTesting = {
  createWorkspaceTerminalSession,
  // Cache inspection helpers for unit tests
  sessionTerminalCache,
  sessionEntryKey,
  evictLruEntries,
  invalidateScopeSnapshots,
  workspaceDiscardFn,
  clearSessionCache() {
    sessionTerminalCache.clear()
    workspaceDiscardFn.clear()
  },
}

export type TerminalHostID = "bottom" | "side"

// Dual-host provider — creates independent bottom and side sessions sharing one PTY service.
// Session-scoped: the active bottom/side pair is selected by the current session key (URL
// params.id, or a stable per-tab draft UUID when no session has been created yet).
const { use: useTerminalDual, provider: TerminalProvider } = createSimpleContext({
  name: "TerminalDual",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const server = useServer()
    const platform = usePlatform()
    const params = useParams()
    const scope = server.scope()

    // Stable draft key for this provider-mount (per browser tab / per SessionRoute mount).
    // Used as the session key when the route has no session ID yet (/session without :id).
    const draftKey = uuid()

    // Reactive effective session key: real session ID when available, draft UUID otherwise.
    const effectiveSessionKey = createMemo(() => params.id ?? draftKey)

    let runtimeId: string | undefined
    let runtimeRequest: Promise<void> | undefined
    let bottomSession: TerminalSession | undefined
    let sideSession: TerminalSession | undefined

    // Shared PTY discard helper — used for LRU eviction and workspace clear.
    const discardPty = (ptyId: string): void => {
      void sdk.client.pty.remove({ ptyID: ptyId }, { throwOnError: false })
    }

    const ensureRuntime = (): Promise<void> => {
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
          // Invalidate all cached snapshots for this scope — old PTY IDs are dead.
          invalidateScopeSnapshots(scope)
          bottomSession?.resetRuntime()
          sideSession?.resetRuntime()
        })
        .catch((error) => {
          if (import.meta.env.DEV) console.debug("[terminal] runtime check failed", error)
        })
        .finally(() => {
          runtimeRequest = undefined
        })
      return runtimeRequest as Promise<void>
    }

    const runtime = { id: () => runtimeId, ensure: ensureRuntime }
    bottomSession = createWorkspaceTerminalSession(sdk, runtime)
    sideSession = createWorkspaceTerminalSession(sdk, runtime)

    // Restore the snapshot for the initial session key, if one exists in the cache.
    // This handles returning to a directory whose session terminals were saved on navigation.
    const initKey = sessionEntryKey(scope, sdk.directory, effectiveSessionKey())
    const initEntry = sessionTerminalCache.get(initKey)
    if (initEntry) {
      sessionTerminalCache.set(initKey, { ...initEntry, lruTick: nextLruTick() })
      if (initEntry.bottom) bottomSession.restore(initEntry.bottom)
      if (initEntry.side) sideSession.restore(initEntry.side)
    }

    // Register sessions in the global set so clearWorkspaceTerminals can reach them.
    const bottomReg = { dir: sdk.directory, scope, value: bottomSession }
    const sideReg = { dir: sdk.directory, scope, value: sideSession }
    sessions.add(bottomReg)
    sessions.add(sideReg)

    // Register the PTY discard helper so clearWorkspaceTerminals can evict cached PTYs.
    const wsKey = workspaceScopeKey(scope, sdk.directory)
    workspaceDiscardFn.set(wsKey, discardPty)

    removeTerminalPersistence(sdk.directory, undefined, platform, scope)

    // Track the previous session key so we can save/restore on switches.
    // Initialised to the current key so the first effect run is a no-op.
    let prevSessionKey = effectiveSessionKey()

    // Reactive session-switch: when the URL session key changes (session A → B, or
    // draft → real), save the current bottom/side state to the cache and restore
    // (or start fresh) for the new session key.
    createEffect(() => {
      const nextKey = effectiveSessionKey()
      const prevKey = prevSessionKey
      if (nextKey === prevKey) return

      const prevEntryKey = sessionEntryKey(scope, sdk.directory, prevKey)
      const nextEntryKey = sessionEntryKey(scope, sdk.directory, nextKey)

      // Snapshot the current sessions before switching away.
      const bottomSnap = bottomSession!.snapshot()
      const sideSnap = sideSession!.snapshot()

      // Draft → real-session migration: when the previous key was our draft UUID and
      // the target slot is empty, move the terminal state to the real session key so
      // the user keeps the same shell after the first message creates the session.
      const isDraftMigration = prevKey === draftKey && !sessionTerminalCache.has(nextEntryKey)
      if (isDraftMigration) {
        sessionTerminalCache.set(nextEntryKey, {
          bottom: bottomSnap,
          side: sideSnap,
          lruTick: nextLruTick(),
        })
        sessionTerminalCache.delete(prevEntryKey)
      } else {
        // Normal session switch: persist current state under the previous key.
        if (bottomSnap || sideSnap) {
          sessionTerminalCache.set(prevEntryKey, {
            bottom: bottomSnap,
            side: sideSnap,
            lruTick: nextLruTick(),
          })
        }
      }

      prevSessionKey = nextKey

      // Reset live sessions to empty state before restoring (or starting fresh).
      bottomSession!.resetRuntime()
      sideSession!.resetRuntime()

      // Restore from cache if an entry exists for the target session.
      const nextEntry = sessionTerminalCache.get(nextEntryKey)
      if (nextEntry) {
        // Touch LRU.
        sessionTerminalCache.set(nextEntryKey, { ...nextEntry, lruTick: nextLruTick() })
        if (nextEntry.bottom) bottomSession!.restore(nextEntry.bottom)
        if (nextEntry.side) sideSession!.restore(nextEntry.side)
      }

      // Evict least-recently-used entries beyond the per-workspace cap.
      evictLruEntries(scope, sdk.directory, nextEntryKey, discardPty)
    })

    onMount(() => {
      void ensureRuntime()
      const timer = setInterval(() => {
        if (bottomSession?.all().length || sideSession?.all().length) void ensureRuntime()
      }, RUNTIME_POLL_MS)
      onCleanup(() => clearInterval(timer))
    })

    onCleanup(() => {
      // Save PTY state for the current session so terminals survive navigation.
      // Do NOT call clear() here — that would DELETE PTYs on the server. PTYs keep
      // running and are reconnected when the user returns to this session.
      const currentKey = sessionEntryKey(scope, sdk.directory, effectiveSessionKey())
      const bottomSnap = bottomSession?.snapshot() ?? null
      const sideSnap = sideSession?.snapshot() ?? null
      if (bottomSnap || sideSnap) {
        sessionTerminalCache.set(currentKey, {
          bottom: bottomSnap,
          side: sideSnap,
          lruTick: nextLruTick(),
        })
      } else {
        // Remove a stale empty entry if nothing is alive.
        sessionTerminalCache.delete(currentKey)
      }
      sessions.delete(bottomReg)
      sessions.delete(sideReg)
      workspaceDiscardFn.delete(wsKey)
    })

    return { bottom: bottomSession, side: sideSession }
  },
})

// Re-export TerminalProvider for app.tsx
export { TerminalProvider }

// useTerminalHosts — returns { bottom, side } for callers that need to address a specific host.
export function useTerminalHosts() {
  return useTerminalDual()
}

// Per-render-tree host context — populated by BottomTerminalProvider / SideTerminalProvider.
// All components inside terminal-view.tsx (TerminalPanes, TerminalActions, …) consume this.
const TerminalHostContext = createContext<TerminalSession | undefined>(undefined)

export function useTerminal(): TerminalSession {
  const ctx = useContext(TerminalHostContext)
  if (!ctx) throw new Error("useTerminal must be called inside BottomTerminalProvider or SideTerminalProvider")
  return ctx
}

/** Wrap the bottom-dock rendering subtree so all terminal-view components target the bottom session. */
export function BottomTerminalProvider(props: ParentProps) {
  const hosts = useTerminalDual()
  return <TerminalHostContext.Provider value={hosts.bottom}>{props.children}</TerminalHostContext.Provider>
}

/** Wrap the side-panel rendering subtree so all terminal-view components target the side session. */
export function SideTerminalProvider(props: ParentProps) {
  const hosts = useTerminalDual()
  return <TerminalHostContext.Provider value={hosts.side}>{props.children}</TerminalHostContext.Provider>
}
