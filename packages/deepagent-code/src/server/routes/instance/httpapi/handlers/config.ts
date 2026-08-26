import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ServerCapabilities } from "@deepagent-code/core/server-capabilities"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      // Admin-controlled ServerCapabilities gate. `Config.update` is generic, so we
      // only gate writes that touch provider config (capability providerConfigEditable
      // → action provider.config.write). No core Policy service in this runtime, so we
      // evaluate the injected capability set directly from the env (deny-only,
      // fail-open-when-unset). See server-capabilities.ts / docs runtime §3.1.
      if (
        "provider" in ctx.payload &&
        !ServerCapabilities.isAllowed(ServerCapabilities.Actions.providerConfigWrite)
      )
        return yield* new HttpApiError.BadRequest({})
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
