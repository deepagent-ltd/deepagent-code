type Definition = {
  [method: string]: (input: never) => unknown
}

type Endpoint = {
  postMessage: (data: string) => void | null
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null
}

type ClientOptions = {
  timeoutMs?: number
  maxPending?: number
  maxListeners?: number
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_PENDING = 128
const MAX_LISTENERS = 128

function decode(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "string") return
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    return parsed as Record<string, unknown>
  } catch {
    return
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function listen(rpc: Definition) {
  onmessage = async (event) => {
    const parsed = decode(event.data)
    if (parsed?.type !== "rpc.request" || typeof parsed.id !== "number" || typeof parsed.method !== "string") return

    const method = rpc[parsed.method]
    if (!method) {
      postMessage(JSON.stringify({ type: "rpc.result", error: `Unknown RPC method: ${parsed.method}`, id: parsed.id }))
      return
    }

    try {
      const result = await method(parsed.input as never)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    } catch (error) {
      postMessage(JSON.stringify({ type: "rpc.result", error: message(error), id: parsed.id }))
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: Endpoint, options: ClientOptions = {}) {
  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const previous = target.onmessage
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const maxPending = options.maxPending ?? MAX_PENDING
  const maxListeners = options.maxListeners ?? MAX_LISTENERS
  let listenerCount = 0
  let id = 0
  let closed = false

  const handle = (event: MessageEvent<unknown>) => {
    const parsed = decode(event.data)
    if (parsed?.type === "rpc.result" && typeof parsed.id === "number") {
      const entry = pending.get(parsed.id)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(parsed.id)
      if (typeof parsed.error === "string") {
        entry.reject(new Error(parsed.error))
        return
      }
      entry.resolve(parsed.result)
      return
    }
    if (parsed?.type !== "rpc.event" || typeof parsed.event !== "string") return
    const handlers = listeners.get(parsed.event)
    if (!handlers) return
    for (const handler of [...handlers]) handler(parsed.data)
  }
  target.onmessage = handle

  const close = (error: Error = new Error("RPC client closed")) => {
    if (closed) return
    closed = true
    if (target.onmessage === handle) target.onmessage = previous
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    listeners.clear()
    listenerCount = 0
  }

  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<Awaited<ReturnType<T[Method]>>> {
      if (closed) return Promise.reject(new Error("RPC client closed"))
      if (pending.size >= maxPending) return Promise.reject(new Error(`RPC pending request limit exceeded (${maxPending})`))

      const requestId = id++
      return new Promise<Awaited<ReturnType<T[Method]>>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`RPC request "${String(method)}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
        pending.set(requestId, {
          resolve: (result) => resolve(result as Awaited<ReturnType<T[Method]>>),
          reject,
          timer,
        })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      if (closed) throw new Error("RPC client closed")
      if (listenerCount >= maxListeners) throw new Error(`RPC listener limit exceeded (${maxListeners})`)

      const current = listeners.get(event)
      const handlers = current ?? new Set<(data: unknown) => void>()
      if (!current) listeners.set(event, handlers)
      const wrapped = handler as (data: unknown) => void
      handlers.add(wrapped)
      listenerCount++
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        handlers.delete(wrapped)
        listenerCount--
        if (handlers.size === 0 && listeners.get(event) === handlers) listeners.delete(event)
      }
    },
    close,
  }
}

export * as Rpc from "./rpc"
