import { ScopedKey, type ServerScope } from "@/utils/server-scope"

const key = (scope: ServerScope, directory: string, sessionID: string) => ScopedKey.from(scope, directory, sessionID)

export const SESSION_PREFETCH_TTL = 15_000

// Keep every client page request within the server's bounded MessageV2 contract.
export const SESSION_MESSAGE_PAGE_LIMIT = 100
export const SESSION_PREFETCH_CACHE_LIMIT = 256

type Meta = {
  limit: number
  cursor?: string
  complete: boolean
  at: number
}

export function shouldSkipSessionPrefetch(input: { message: boolean; info?: Meta; chunk: number; now?: number }) {
  if (input.message) {
    if (!input.info) return true
    if (input.info.complete) return true
    if (input.info.limit > input.chunk) return true
  } else {
    if (!input.info) return false
  }

  return (input.now ?? Date.now()) - input.info.at < SESSION_PREFETCH_TTL
}

const cache = new Map<string, Meta>()
const inflight = new Map<string, Promise<Meta | undefined>>()
const rev = new Map<string, number>()
let nextRevision = 0

const version = (id: string) => {
  const current = rev.get(id)
  if (current !== undefined) return current
  const next = ++nextRevision
  rev.set(id, next)
  return next
}

const invalidate = (id: string) => {
  const active = inflight.get(id)
  const invalidated = ++nextRevision
  rev.set(id, invalidated)
  cache.delete(id)
  inflight.delete(id)
  if (!active) {
    rev.delete(id)
    return
  }
  void active
    .finally(() => {
      if (!inflight.has(id) && rev.get(id) === invalidated) rev.delete(id)
    })
    .catch(() => {})
}

export function getSessionPrefetch(scope: ServerScope, directory: string, sessionID: string) {
  return cache.get(key(scope, directory, sessionID))
}

export function getSessionPrefetchPromise(scope: ServerScope, directory: string, sessionID: string) {
  return inflight.get(key(scope, directory, sessionID))
}

export function clearSessionPrefetchInflight(scope: ServerScope) {
  const prefix = ScopedKey.prefix(scope)
  for (const id of inflight.keys()) {
    if (id.startsWith(prefix)) invalidate(id)
  }
}

export function isSessionPrefetchCurrent(scope: ServerScope, directory: string, sessionID: string, value: number) {
  return rev.get(key(scope, directory, sessionID)) === value
}

export function runSessionPrefetch(input: {
  directory: string
  scope: ServerScope
  sessionID: string
  task: (value: number) => Promise<Meta | undefined>
}) {
  const id = key(input.scope, input.directory, input.sessionID)
  const pending = inflight.get(id)
  if (pending) return pending
  if (inflight.size >= SESSION_PREFETCH_CACHE_LIMIT) return Promise.resolve(undefined)

  const value = version(id)

  const promise = input.task(value).finally(() => {
    if (inflight.get(id) === promise) inflight.delete(id)
    if (!inflight.has(id) && rev.get(id) === value) rev.delete(id)
  })

  inflight.set(id, promise)
  return promise
}

export function setSessionPrefetch(input: {
  directory: string
  scope: ServerScope
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
}) {
  const id = key(input.scope, input.directory, input.sessionID)
  if (!cache.has(id) && cache.size >= SESSION_PREFETCH_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
}

export function clearSessionPrefetch(scope: ServerScope, directory: string, sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = key(scope, directory, sessionID)
    invalidate(id)
  }
}

export function clearSessionPrefetchDirectory(scope: ServerScope, directory: string) {
  const prefix = ScopedKey.prefix(scope, directory)
  const keys = new Set([...cache.keys(), ...inflight.keys(), ...rev.keys()])
  for (const id of keys) {
    if (!id.startsWith(prefix)) continue
    invalidate(id)
  }
}
