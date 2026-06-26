import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo } from "solid-js"

export const popularProviders = [
  "openai",
  "deepseek",
  "anthropic",
  "zhipuai",
]
const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = serverSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return serverSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    errors: () => providers().errors ?? [],
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [...Iterable.filter(providers().all, ([id]) => connected.has(id))]
    },
  }
}
