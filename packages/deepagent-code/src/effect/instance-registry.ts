import type { InstanceContext } from "@/project/instance-context"

const disposers = new Set<(directory: string) => Promise<void>>()
const initializers = new Set<(context: InstanceContext) => Promise<void>>()

export function registerInitializer(initializer: (context: InstanceContext) => Promise<void>) {
  initializers.add(initializer)
  return () => {
    initializers.delete(initializer)
  }
}

export async function initializeInstance(context: InstanceContext) {
  const results = await Promise.allSettled([...initializers].map((initializer) => initializer(context)))
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed.length > 0)
    throw new AggregateError(
      failed.map((result) => result.reason),
      "Instance initialization failed",
    )
}

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}
