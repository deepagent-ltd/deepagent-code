import { MessageChannel } from "node:worker_threads"
import type { MessagePort } from "node:worker_threads"
import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"

/** Parent transport, not a mint. Only the actual worker parentPort listener can
 * create private Access. A missing response keeps its owned slot until settlement. */
export async function createGoalPlanBridge(worker: Worker, directory: string) {
  type Pending = {
    resolve(value: unknown): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
    mutation: boolean
    response?: { data: unknown } | { error: Error }
    settled: Promise<void>
    settle(): void
  }
  const state: { port?: MessagePort; closed: boolean; sequence: number } = { closed: false, sequence: 0 }
  const pending = new Map<number, Pending>()
  const failure = (mutation = true) =>
    new GoalPlanClient.RequestError("CONNECTION_UNKNOWN", "Private Goal operation has no confirmed response", mutation)
  const whenSettled = () => Promise.all([...pending.values()].map((entry) => entry.settled)).then(() => undefined)
  function finish(id: number) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (entry.response && "data" in entry.response) entry.resolve(entry.response.data)
    else entry.reject(entry.response && "error" in entry.response ? entry.response.error : failure(entry.mutation))
    entry.settle()
  }
  function close() {
    if (state.closed) return
    state.closed = true
    // Do not drop owned slots or close the only settlement channel. The worker
    // invalidates all Access first, interrupts the fibers and acknowledges finally.
    try {
      state.port?.postMessage({ kind: "close" })
    } catch {
      /* Actual exit is still a settlement barrier. */
    }
    for (const entry of pending.values()) entry.reject(failure(entry.mutation))
  }
  worker.addEventListener("close", () => {
    state.closed = true
    for (const id of pending.keys()) finish(id)
  })
  async function connect() {
    const channel = new MessageChannel()
    state.closed = false
    state.port = channel.port1
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.port === channel.port1) close()
        reject(failure())
      }, 5000)
      channel.port1.on("close", () => {
        clearTimeout(timer)
        if (state.port !== channel.port1) return
        state.closed = true
        // A transport close alone proves neither cleanup nor a stopped file writer.
        for (const entry of pending.values()) entry.reject(failure(entry.mutation))
        reject(failure())
      })
      channel.port1.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || state.port !== channel.port1) return
        if ("ready" in message && message.ready === true) {
          clearTimeout(timer)
          if (!("directory" in message) || message.directory !== directory) {
            close()
            reject(failure())
            return
          }
          resolve()
          return
        }
        if ("closed" in message && message.closed === true) {
          // Worker sends this only after every request's finally has completed.
          state.closed = true
          for (const id of pending.keys()) finish(id)
          channel.port1.close()
          return
        }
        if (!("id" in message) || typeof message.id !== "number") return
        const entry = pending.get(message.id)
        if (!entry) return
        if ("settled" in message && message.settled === true) {
          finish(message.id)
          return
        }
        if ("error" in message && message.error && typeof message.error === "object") {
          const error = message.error
          entry.response = {
            error: new GoalPlanClient.RequestError(
              "code" in error && typeof error.code === "string" ? error.code : "UNAVAILABLE",
              "message" in error && typeof error.message === "string" ? error.message : "Private Goal request failed",
              entry.mutation && (!("code" in error) || error.code === "UNAVAILABLE"),
            ),
          }
          return
        }
        if ("data" in message) entry.response = { data: message.data }
      })
      channel.port1.start()
      worker.postMessage({ kind: "goal-plan-bootstrap-v1", port: channel.port2 }, [channel.port2])
    })
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("message", ready)
      reject(failure())
    }, 10000)
    function ready(event: MessageEvent<unknown>) {
      const message = event.data
      if (
        !message ||
        typeof message !== "object" ||
        !("kind" in message) ||
        message.kind !== "goal-plan-bootstrap-ready-v1"
      )
        return
      clearTimeout(timer)
      worker.removeEventListener("message", ready)
      resolve()
    }
    worker.addEventListener("message", ready)
  })
  await connect()
  let reconnecting: Promise<void> | undefined
  function call(action: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
    if (state.closed || !state.port || pending.size >= 8 || signal?.aborted)
      return Promise.reject(failure(action !== "get"))
    const port = state.port
    const id = state.sequence++
    const deadlineAt = Date.now() + 30000
    const completion: { resolve?: () => void } = {}
    const settled = new Promise<void>((resolve) => {
      completion.resolve = resolve
    })
    return new Promise((resolve, reject) => {
      const done = () => signal?.removeEventListener("abort", abort)
      const abort = () => {
        const entry = pending.get(id)
        if (!entry) return
        try {
          port.postMessage({ kind: "revoke", id })
        } catch {
          /* Native expiry independently fences Access. */
        }
        clearTimeout(entry.timer)
        done()
        // Unknown is observable promptly. It does not release native ownership or
        // the UI's remote-command guard; those await the finally acknowledgement.
        reject(failure(action !== "get"))
      }
      const timer = setTimeout(abort, 30000)
      pending.set(id, {
        resolve: (value) => {
          done()
          resolve(value)
        },
        reject: (error) => {
          done()
          reject(error)
        },
        timer,
        mutation: action !== "get",
        settled,
        settle: () => completion.resolve?.(),
      })
      signal?.addEventListener("abort", abort, { once: true })
      try {
        port.postMessage({ id, action, request, deadlineAt })
      } catch {
        abort()
      }
    })
  }
  return {
    transport: {
      send: (command: GoalPlanClient.Command) => call(command.action, command.request),
      get: (query: GoalPlanClient.Query, signal?: AbortSignal) => call("get", query, signal),
      whenSettled,
    } satisfies GoalPlanClient.Transport,
    close,
    reconnect() {
      if (reconnecting) return reconnecting
      if (pending.size)
        return Promise.reject(
          new GoalPlanClient.RequestError(
            "CONNECTION_UNKNOWN",
            "Previous private Goal request still needs settlement",
            true,
          ),
        )
      state.port?.close()
      const operation = connect()
      reconnecting = operation
      void operation
        .finally(() => {
          if (reconnecting === operation) reconnecting = undefined
        })
        .catch(() => undefined)
      return operation
    },
  }
}
