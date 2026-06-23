import { Effect } from "effect"
import { PluginV2 } from "../../plugin"
import { ProviderV2 } from "../../provider"

const DEEPAGENT_CODE_API_KEY = "DEEPAGENT_CODE_API_KEY"

export const OpencodePlugin = PluginV2.define({
  id: PluginV2.ID.make("deepagent-code"),
  effect: Effect.gen(function* () {
    let hasKey = false
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        const item = evt.provider.get(ProviderV2.ID.make("deepagent-code"))
        if (!item) return
        hasKey = Boolean(
          process.env[DEEPAGENT_CODE_API_KEY] ||
            item.provider.env.some((env) => process.env[env]) ||
            item.provider.request.body.apiKey ||
            (item.provider.enabled && item.provider.enabled.via === "account"),
        )
        evt.provider.update(item.provider.id, (provider) => {
          if (!hasKey) provider.request.body.apiKey = "public"
        })
        if (hasKey) return
        for (const model of item.models.values()) {
          if (!model.cost.some((cost) => cost.input > 0)) continue
          evt.model.update(item.provider.id, model.id, (draft) => {
            draft.enabled = false
          })
        }
      }),
    }
  }),
})
