export * as ProcessLifecycle from "./process-lifecycle"

type Cleanup = () => void | Promise<void>

const MAX_PROCESS_RESOURCES = 64

export function make(maxResources = MAX_PROCESS_RESOURCES) {
  const resources = new Map<string, Cleanup>()
  let shutdown: Promise<void> | undefined

  const register = (name: string, cleanup: Cleanup) => {
    if (shutdown) throw new Error(`Cannot register process resource after shutdown started: ${name}`)
    if (resources.has(name)) throw new Error(`Duplicate process resource registration: ${name}`)
    if (resources.size >= maxResources) throw new Error(`Process resource registry exceeded ${maxResources} entries`)
    resources.set(name, cleanup)
    return () => {
      if (resources.get(name) === cleanup) resources.delete(name)
    }
  }

  const disposeAll = () => {
    if (shutdown) return shutdown
    const current = [...resources.entries()].reverse()
    resources.clear()
    shutdown = Promise.allSettled(current.map(([, cleanup]) => Promise.resolve().then(cleanup))).then((results) => {
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length > 0) throw new AggregateError(failures, "Process resource cleanup failed")
    })
    return shutdown
  }

  return { register, disposeAll }
}

const lifecycle = make()

export const register = lifecycle.register
export const disposeAll = lifecycle.disposeAll
