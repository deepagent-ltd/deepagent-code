import { Effect } from "effect"
import { Daemon } from "../../../services/daemon"
import type { createOpencodeClient } from "@deepagent-code/sdk/v2/client"

type Client = ReturnType<typeof createOpencodeClient>

// The SDK's generated client type doesn't expose `.client.request` — it's the
// raw HTTP escape hatch used by the GUI (see wiki.api.ts). Cast to access it.
type RawRequestClient = {
  client: {
    request<T>(options: { method: string; url: string; body?: unknown; headers?: Record<string, string> }): Promise<{ data?: T }>
  }
}

export const getClient = Effect.fn("cli.deepagent.client")(function* () {
  return (yield* (yield* Daemon.Service).client()) as Client & RawRequestClient
})

export const call = <A>(f: (c: Client) => Promise<A>) =>
  Effect.gen(function* () {
    const c = yield* getClient()
    return yield* Effect.tryPromise<A>(() => f(c))
  })

export const rawGet = <T>(url: string) =>
  Effect.gen(function* () {
    const c = yield* getClient()
    return yield* Effect.tryPromise<{ data?: T }>(() => c.client.request<T>({ method: "GET", url }))
  })

export const rawPost = <T>(url: string, body?: unknown) =>
  Effect.gen(function* () {
    const c = yield* getClient()
    return yield* Effect.tryPromise<{ data?: T }>(() =>
      c.client.request<T>({ method: "POST", url, body, headers: { "Content-Type": "application/json" } }),
    )
  })

type Capabilities = { features?: Record<string, boolean> }

export const requireCapability = (flag?: string) =>
  Effect.gen(function* () {
    if (!flag) return
    const result = yield* call((c) => c.global.capabilities())
    const features = (result.data as Capabilities | undefined)?.features
    if (!features?.[flag]) yield* Effect.fail(new Error(`Feature "${flag}" is not enabled on this server`))
  })
