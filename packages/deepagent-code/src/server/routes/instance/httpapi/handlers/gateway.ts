import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { GatewayHttpApi } from "../groups/gateway"
import { ProxyTenantContext } from "../middleware/proxy-authorization"
import { chat } from "./gateway-chat"

export const gatewayHandlers = HttpApiBuilder.group(GatewayHttpApi, "gateway", (handlers) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service
    const chatHandler = yield* chat

    return handlers.handle("models", () =>
      Effect.gen(function* () {
        const tenant = yield* ProxyTenantContext
        const instance = yield* store.load({ directory: tenant.directory })
        const catalog = yield* provider.list().pipe(Effect.provideService(InstanceRef, instance))
        return {
          object: "list" as const,
          data: Object.values(catalog)
            .flatMap((entry) =>
              Object.values(entry.models)
                .filter((model) => tenant.model_allowlist.includes(`${entry.id}/${model.id}`))
                .map((model) => ({
                  id: model.id,
                  object: "model" as const,
                  created: Math.floor(Date.parse(model.release_date) / 1000) || 0,
                  owned_by: entry.id,
                })),
            )
            .sort((a, b) => a.id.localeCompare(b.id)),
        }
      }),
    ).handleRaw("chat", chatHandler)
  }),
)
