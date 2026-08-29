import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@deepagent-code/core/util/binary"
import { retry } from "@deepagent-code/core/util/retry"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  SESSION_MESSAGE_PAGE_LIMIT,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import type { Message, Part } from "@deepagent-code/sdk/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import {
  compareMessages,
  compareParts,
  findMessageIndex,
  locateMessage,
  locatePart,
} from "@/utils/message-order"
import { createServerSdkContext, useServerSDK } from "./server-sdk"
import { type createServerSyncContextInner } from "./server-sync"
import { promptAdmissionClientMessageID } from "./global-sync/prompt-admission"
import { mergeMessage } from "./global-sync/event-reducer"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
type ActivityProgress = NonNullable<Extract<Message, { role: "assistant" }>["activityProgress"]>

// provider lifecycle root cause B: ID order is not chronological order across the 6-byte ID time wrap;
// parts sort by (time.start, id), messages by (time.created, id). See utils/message-order.ts.
function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => compareParts(a, b))
}

export async function runInflight(
  map: Map<string, Promise<void>>,
  trailing: Set<string>,
  key: string,
  force: boolean,
  task: () => Promise<void>,
): Promise<void> {
  const pending = map.get(key)
  if (pending) {
    if (!force) return pending
    trailing.add(key)
    await pending.catch(() => {})
    if (!trailing.delete(key)) return
    return runInflight(map, trailing, key, true, task)
  }
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const isNotFound = (error: unknown) =>
  error instanceof Error &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { status?: unknown }).status === 404

function mergePageMessages(
  base: readonly Message[],
  incoming: readonly Message[],
  previous: readonly Message[],
  baseline: ReadonlyMap<string, ActivityProgress | undefined>,
  authoritative: boolean,
) {
  const messages = new Map(base.map((item) => [item.id, item] as const))
  const previousByID = new Map(previous.map((item) => [item.id, item] as const))
  if (authoritative) {
    for (const item of previous) {
      if (!baseline.has(item.id) || !sameActivityProgress(item, baseline.get(item.id))) messages.set(item.id, item)
    }
  }
  let conflict = false
  for (const item of incoming) {
    if (authoritative && baseline.has(item.id) && !previousByID.has(item.id)) continue
    const current = previousByID.get(item.id) ?? messages.get(item.id)
    if (!current) {
      messages.set(item.id, item)
      continue
    }
    if (authoritative && sameActivityProgress(current, baseline.get(item.id))) {
      messages.set(item.id, item)
      continue
    }
    const result = mergeMessage(current, item)
    messages.set(item.id, result.message)
    conflict ||= result.conflict
  }
  return {
    messages: [...messages.values()].sort((a, b) => compareMessages(a, b)),
    conflict,
  }
}

function activityProgress(message: Message): ActivityProgress | undefined {
  if (message.role !== "assistant" || !message.activityProgress) return
  return { ...message.activityProgress }
}

function sameActivityProgress(message: Message, baseline: ActivityProgress | undefined) {
  const marker = activityProgress(message)
  return (
    marker?.activityID === baseline?.activityID &&
    marker?.revision === baseline?.revision &&
    marker?.state === baseline?.state &&
    marker?.terminalReason === baseline?.terminalReason
  )
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type OptimisticResolution = {
  pending: OptimisticItem[]
  canonical: Message[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => locatePart(parts, part).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = locatePart(next, part)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

const hasCanonicalPromptAdmission = (messages: Message[] | undefined, clientMessageID: string) =>
  messages?.some((message) => promptAdmissionClientMessageID(message) === clientMessageID) ?? false

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []
  const correlated = new Set(
    page.session
      .map(promptAdmissionClientMessageID)
      .filter((messageID): messageID is string => messageID !== undefined),
  )

  for (const item of items) {
    if (correlated.has(item.message.id)) {
      confirmed.push(item.message.id)
      part.delete(item.message.id)
      continue
    }
    const result = locateMessage(session, item.message)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (hasCanonicalPromptAdmission(messages, input.message.id)) {
    delete draft.part[input.message.id]
    return
  }
  if (messages) {
    const result = locateMessage(messages, input.message)
    if (result.found) messages[result.index] = input.message
    else messages.splice(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const index = findMessageIndex(messages, input.messageID)
    if (index !== -1) messages.splice(index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = locateMessage(messages, input.message)
    const next = [...messages]
    if (result.found) next[result.index] = input.message
    else next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const index = findMessageIndex(messages, input.messageID)
    if (index === -1) return messages
    const next = [...messages]
    next.splice(index, 1)
    return next
  })
  setStore("part", input.messageID, undefined)
}

export const createDirSyncContext = (
  directory: string,
  serverSync: ReturnType<typeof createServerSyncContextInner>,
  serverSDK: ReturnType<typeof createServerSdkContext> = useServerSDK(),
) => {
  const client = serverSDK.createClient({ directory, throwOnError: true })

  type Child = ReturnType<(typeof serverSync)["child"]>
  type Setter = Child[1]

  const current = createMemo(() => serverSync.child(directory, { mcp: true }))
  const target = (targetDirectory?: string) => {
    if (!targetDirectory || targetDirectory === directory) return current()
    return serverSync.child(targetDirectory)
  }
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const initialMessagePageSize = 80
  const historyMessagePageSize = SESSION_MESSAGE_PAGE_LIMIT
  const inflight = new Map<string, Promise<void>>()
  const trailing = new Set<string>()
  const inflightMessages = new Map<string, Promise<void>>()
  const trailingMessages = new Set<string>()
  const inflightDiff = new Map<string, Promise<void>>()
  const trailingDiff = new Set<string>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const maxDirs = 30
  const seen = new Map<string, Set<string>>()
  let requestSessionSync: ((sessionID: string) => void) | undefined
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean>,
    loading: {} as Record<string, boolean>,
  })

  const getSession = (sessionID: string) => {
    const store = current()[0]
    const match = Binary.search(store.session, sessionID, (s) => s.id)
    if (match.found) return store.session[match.index]
    return undefined
  }

  const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
    const key = keyFor(directory, sessionID)
    const list = optimistic.get(key)
    if (list) {
      list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
      return
    }
    optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
  }

  const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
    const key = keyFor(directory, sessionID)
    if (!messageID) {
      optimistic.delete(key)
      return
    }

    const list = optimistic.get(key)
    if (!list) return
    list.delete(messageID)
    if (list.size === 0) optimistic.delete(key)
  }

  const getOptimistic = (directory: string, sessionID: string): OptimisticResolution => {
    const messages = serverSync.child(directory, { bootstrap: false })[0].message[sessionID]
    const items = [...(optimistic.get(keyFor(directory, sessionID))?.values() ?? [])]
    const clientMessageIDs = new Set(items.map((item) => item.message.id))
    const canonical = (messages ?? []).filter((message) => {
      const clientMessageID = promptAdmissionClientMessageID(message)
      return clientMessageID !== undefined && clientMessageIDs.has(clientMessageID)
    })
    const confirmed = new Set(canonical.map((message) => promptAdmissionClientMessageID(message)))
    for (const messageID of confirmed) {
      if (messageID) clearOptimistic(directory, sessionID, messageID)
    }
    return {
      pending: items.filter((item) => !confirmed.has(item.message.id)),
      canonical,
    }
  }

  const seenFor = (directory: string) => {
    const existing = seen.get(directory)
    if (existing) {
      seen.delete(directory)
      seen.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.set(directory, created)
    while (seen.size > maxDirs) {
      const first = seen.keys().next().value
      if (!first) break
      const stale = [...(seen.get(first) ?? [])]
      seen.delete(first)
      const [, setStore] = serverSync.child(first, { bootstrap: false })
      evict(first, setStore, stale)
    }
    return created
  }

  const clearMeta = (directory: string, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    for (const sessionID of sessionIDs) {
      clearOptimistic(directory, sessionID)
    }
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          const key = keyFor(directory, sessionID)
          delete draft.limit[key]
          delete draft.cursor[key]
          delete draft.complete[key]
          delete draft.loading[key]
        }
      }),
    )
  }

  const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    clearSessionPrefetch(serverSDK.scope, directory, sessionIDs)
    setStore(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    clearMeta(directory, sessionIDs)
  }

  const touch = (directory: string, setStore: Setter, sessionID: string) => {
    const stale = pickSessionCacheEvictions({
      seen: seenFor(directory),
      keep: sessionID,
      limit: SESSION_CACHE_LIMIT,
    })
    evict(directory, setStore, stale)
  }

  const fetchMessages = async (input: { client: typeof client; sessionID: string; limit: number; before?: string }) => {
    const messages = await retry(() =>
      input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
    )
    const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
    // The server page is already in (time_created, id) order; re-sort with the same compound
    // comparator so a wrapped `msg_00...` tail is never reordered ahead of `msg_ff...` history.
    const session = items.map((x) => clean(x.info)).sort((a, b) => compareMessages(a, b))
    const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
    const cursor = messages.response?.headers.get("x-next-cursor") ?? undefined
    return {
      session,
      part,
      cursor,
      complete: !cursor,
    }
  }

  const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

  const loadMessages = async (input: {
    directory: string
    client: typeof client
    setStore: Setter
    sessionID: string
    limit: number
    before?: string
    mode?: "replace" | "prepend"
    force?: boolean
    authoritative?: boolean
    refetchOnConflict?: boolean
  }) => {
    const key = keyFor(input.directory, input.sessionID)
    return runInflight(inflightMessages, trailingMessages, key, input.force === true, async () => {
      const baseline = new Map(
        (serverSync.child(input.directory, { bootstrap: false })[0].message[input.sessionID] ?? []).map((message) => [
          message.id,
          activityProgress(message),
        ]),
      )
      let conflict = false
      setMeta("loading", key, true)
      await fetchMessages(input)
        .then((page) => {
          if (!tracked(input.directory, input.sessionID)) return
          const optimistic = getOptimistic(input.directory, input.sessionID)
          const next = mergeOptimisticPage(page, optimistic.pending)
          for (const messageID of next.confirmed) {
            clearOptimistic(input.directory, input.sessionID, messageID)
          }
          const [store] = serverSync.child(input.directory, { bootstrap: false })
          const previous = store.message[input.sessionID] ?? []
          const cached = input.mode === "prepend" ? previous : optimistic.canonical
          const merged = mergePageMessages(cached, next.session, previous, baseline, input.authoritative === true)
          conflict = merged.conflict
          if (conflict)
            console.error("Conflicting activity progress page", {
              sessionID: input.sessionID,
              mode: input.mode ?? "replace",
              refetchOnConflict: input.refetchOnConflict !== false,
            })
          const message = merged.messages
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
            for (const p of next.part) {
              const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
              if (filtered.length) input.setStore("part", p.id, filtered)
            }
            setMeta("limit", key, message.length)
            setMeta("cursor", key, next.cursor)
            setMeta("complete", key, next.complete)
            setSessionPrefetch({
              scope: serverSDK.scope,
              directory: input.directory,
              sessionID: input.sessionID,
              limit: message.length,
              cursor: next.cursor,
              complete: next.complete,
            })
          })
        })
        .catch((error) => {
          if (isNotFound(error) && !tracked(input.directory, input.sessionID)) return
          throw error
        })
        .finally(() => {
          setMeta(
            produce((draft) => {
              if (!tracked(input.directory, input.sessionID)) {
                delete draft.loading[key]
                return
              }
              draft.loading[key] = false
            }),
          )
          if (conflict && input.refetchOnConflict !== false) {
            // BUG-005 residual: degrade conflict recovery from a FULL-session force reload
            // (requestSessionSync) to an authoritative TAIL refetch. An activityProgress conflict
            // only means the recent markers diverged; refetching the newest small page
            // authoritatively reconciles them in place (mergePageMessages keys by id, so untouched
            // messages are preserved) instead of refetching and re-rendering the whole session.
            // force:true queues behind the in-flight page; refetchOnConflict:false bounds recursion.
            void loadMessages({
              directory: input.directory,
              client: input.client,
              setStore: input.setStore,
              sessionID: input.sessionID,
              limit: Math.min(input.limit, initialMessagePageSize),
              force: true,
              authoritative: true,
              refetchOnConflict: false,
            }).catch(() => {})
          }
        })
    })
  }

  const loadPlan = (sessionID: string) => serverSync.plan.sync(directory, sessionID)

  const result = {
    get data() {
      return current()[0]
    },
    get set(): Setter {
      return current()[1]
    },
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      const store = current()[0]
      const match = Binary.search(serverSync.data.project, store.project, (p) => p.id)
      if (match.found) return serverSync.data.project[match.index]
      return undefined
    },
    session: {
      get: getSession,
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          const _directory = input.directory ?? directory
          const [store, setStore] = target(input.directory)
          if (hasCanonicalPromptAdmission(store.message[input.sessionID], input.message.id)) {
            clearOptimistic(_directory, input.sessionID, input.message.id)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, {
              sessionID: input.sessionID,
              messageID: input.message.id,
            })
            return
          }
          setOptimistic(_directory, input.sessionID, { message: input.message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          clearOptimistic(_directory, input.sessionID, input.messageID)
          setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
        },
      },
      addOptimisticMessage(input: {
        sessionID: string
        messageID: string
        parts: Part[]
        agent: string
        model: { providerID: string; modelID: string }
        variant?: string
      }) {
        const message: Message = {
          id: input.messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent,
          model: { ...input.model, variant: input.variant },
        }
        const [store, setStore] = target()
        if (hasCanonicalPromptAdmission(store.message[input.sessionID], message.id)) {
          clearOptimistic(directory, input.sessionID, message.id)
          setOptimisticRemove(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            messageID: message.id,
          })
          return
        }
        setOptimistic(directory, input.sessionID, { message, parts: input.parts })
        setOptimisticAdd(setStore as (...args: unknown[]) => void, {
          sessionID: input.sessionID,
          message,
          parts: input.parts,
        })
      },
      async sync(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        const key = keyFor(directory, sessionID)

        touch(directory, setStore, sessionID)
        const planReq = loadPlan(sessionID)

        const seeded = getSessionPrefetch(serverSDK.scope, directory, sessionID)
        if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
          batch(() => {
            setMeta("limit", key, seeded.limit)
            setMeta("cursor", key, seeded.cursor)
            setMeta("complete", key, seeded.complete)
            setMeta("loading", key, false)
          })
        }

        return runInflight(inflight, trailing, key, opts?.force === true, async () => {
          const pending = getSessionPrefetchPromise(serverSDK.scope, directory, sessionID)
          if (pending) {
            await pending
            const seeded = getSessionPrefetch(serverSDK.scope, directory, sessionID)
            if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
              batch(() => {
                setMeta("limit", key, seeded.limit)
                setMeta("cursor", key, seeded.cursor)
                setMeta("complete", key, seeded.complete)
                setMeta("loading", key, false)
              })
            }
          }

          const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
          const cachedMessages = store.message[sessionID]
          const cached = cachedMessages !== undefined && meta.limit[key] !== undefined
          if (cached && hasSession && !opts?.force && cachedMessages.length > 0) {
            await planReq
            return
          }

          const limit = meta.limit[key] ?? initialMessagePageSize
          const sessionReq =
            hasSession && !opts?.force
              ? Promise.resolve()
              : retry(() => client.session.get({ sessionID }))
                  .then((session) => {
                    if (!tracked(directory, sessionID)) return
                    const data = session.data
                    if (!data) return
                    setStore(
                      "session",
                      produce((draft) => {
                        const match = Binary.search(draft, sessionID, (s) => s.id)
                        if (match.found) {
                          draft[match.index] = data
                          return
                        }
                        draft.splice(match.index, 0, data)
                      }),
                    )
                  })
                  .catch((error) => {
                    if (isNotFound(error) && !tracked(directory, sessionID)) return
                    throw error
                  })

          const messagesReq =
            cached && !opts?.force
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  setStore,
                  sessionID,
                  limit,
                  force: opts?.force === true,
                  authoritative: opts?.force === true,
                  refetchOnConflict: opts?.force !== true,
                })

          await Promise.all([sessionReq, messagesReq, planReq])
        })
      },
      async diff(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        touch(directory, setStore, sessionID)
        if (store.session_diff[sessionID] !== undefined && !opts?.force) return

        const key = keyFor(directory, sessionID)
        return runInflight(inflightDiff, trailingDiff, key, opts?.force === true, () =>
          retry(() => client.session.diff({ sessionID })).then((diff) => {
            if (!tracked(directory, sessionID)) return
            setStore("session_diff", sessionID, reconcile(list(diff.data), { key: "file" }))
          }),
        )
      },
      history: {
        more(sessionID: string) {
          const store = current()[0]
          const key = keyFor(directory, sessionID)
          if (store.message[sessionID] === undefined) return false
          if (meta.limit[key] === undefined) return false
          if (meta.complete[key]) return false
          return !!meta.cursor[key]
        },
        loading(sessionID: string) {
          const key = keyFor(directory, sessionID)
          return meta.loading[key] ?? false
        },
        async loadMore(sessionID: string, count?: number) {
          const [, setStore] = serverSync.child(directory)
          touch(directory, setStore, sessionID)
          const key = keyFor(directory, sessionID)
          const step = Math.min(count ?? historyMessagePageSize, SESSION_MESSAGE_PAGE_LIMIT)
          if (meta.loading[key]) return
          if (meta.complete[key]) return
          const before = meta.cursor[key]
          if (!before) return

          await loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit: step,
            before,
            mode: "prepend",
          })
        },
      },
      evict(sessionID: string, _directory = directory) {
        const [, setStore] = serverSync.child(_directory)
        seenFor(_directory).delete(sessionID)
        evict(_directory, setStore, [sessionID])
      },
      fetch: async (count = 10) => {
        const [store, setStore] = serverSync.child(directory)
        setStore("limit", (x) => x + count)
        await client.session.list().then((x) => {
          const sessions = (x.data ?? [])
            .filter((s) => !!s?.id)
            .sort((a, b) => cmp(a.id, b.id))
            .slice(0, store.limit)
          setStore("session", reconcile(sessions, { key: "id" }))
        })
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      archive: async (sessionID: string) => {
        const [, setStore] = serverSync.child(directory)
        await client.session.update({ sessionID, time: { archived: Date.now() } })
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
      },
    },
    mcp: {
      toggle: (name: string) => serverSync.mcp.toggle(directory, name),
      add: (input: Parameters<typeof serverSync.mcp.add>[1]) => serverSync.mcp.add(directory, input),
      update: (input: Parameters<typeof serverSync.mcp.update>[1]) => serverSync.mcp.update(directory, input),
      remove: (name: string) => serverSync.mcp.remove(directory, name),
      catalog: () => serverSync.mcp.catalog(directory),
      catalogEnable: (input: Parameters<typeof serverSync.mcp.catalogEnable>[1]) =>
        serverSync.mcp.catalogEnable(directory, input),
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }

  requestSessionSync = (sessionID) => {
    void result.session.sync(sessionID, { force: true }).catch((error) => {
      console.error("Failed to reload session after an activity progress conflict", error)
    })
  }
  serverSync.registerSessionReloader?.(directory, (sessionID) =>
    result.session.sync(sessionID, { force: true }),
  )
  return result
}
