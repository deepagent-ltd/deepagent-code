import { createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@deepagent-code/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: () => {
    const providers = useProviders()
    const serverSync = useServerSync()
    const language = useLanguage()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    // PARITY-004 / GUI 批 — 模型启停服务端真相源:可见性(启/停)的权威来源是服务端 config
    // `provider[pID].models[mID].disabled`(plugin/provider.ts 已映射 model.enabled=!disabled)。
    // localStorage(store.user)仅作迁移来源与乐观缓存,不再是真相。
    const serverDisabled = (model: ModelKey): boolean | undefined => {
      const provider = serverSync.data.config.provider?.[model.providerID]
      const disabled = provider?.models?.[model.modelID]?.disabled
      return typeof disabled === "boolean" ? disabled : undefined
    }

    const setServerDisabled = async (model: ModelKey, disabled: boolean) => {
      const config = serverSync.data.config
      const provider = config.provider?.[model.providerID]
      const current = provider?.models?.[model.modelID]
      await serverSync.updateConfig({
        ...config,
        provider: {
          ...config.provider,
          [model.providerID]: {
            ...provider,
            models: {
              ...provider?.models,
              [model.modelID]: { ...current, disabled },
            },
          },
        },
      })
    }

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      // localStorage 先铺底(迁移前的旧值)
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      // 服务端真相覆盖(权威)
      for (const model of available()) {
        const key = `${model.provider.id}:${model.id}`
        const disabled = serverDisabled({ providerID: model.provider.id, modelID: model.id })
        if (disabled === true) map.set(key, "hide")
        else if (disabled === false) map.set(key, "show")
      }
      return map
    })

    const duplicateModelIDs = createMemo(() => {
      const counts = available().reduce(
        (acc, model) => acc.set(model.id, (acc.get(model.id) ?? 0) + 1),
        new Map<string, number>(),
      )
      return new Set([...counts.entries()].filter((entry) => entry[1] > 1).map((entry) => entry[0]))
    })

    const list = createMemo(() =>
      available().map((m) => {
        const name = m.name.replace("(latest)", "").trim()
        return {
          ...m,
          name: duplicateModelIDs().has(m.id) ? `${name} (${m.provider.name})` : name,
          latest: m.name.includes("(latest)"),
        }
      }),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      // 乐观写 localStorage(即时 UI),真相异步写服务端 config。
      const key = modelKey(model)
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
      } else {
        setStore("user", store.user.length, { ...model, visibility: state })
      }
      void setServerDisabled(model, state === "hide").catch(() => {
        // 服务端写失败:回滚乐观态——移除该 model 的本地覆盖,visibility 回落到服务端真相/默认。
        setStore("user", (items) => items.filter((item) => modelKey(item) !== key))
        showToast({ title: language.t("common.requestFailed") })
      })
    }

    // 一次性迁移:把 localStorage 里的显式 show/hide 上收服务端,随后服务端即真相。
    onMount(() => {
      const pending = store.user.slice()
      if (pending.length === 0) return
      void (async () => {
        for (const item of pending) {
          if (serverDisabled({ providerID: item.providerID, modelID: item.modelID }) !== undefined) continue
          await setServerDisabled({ providerID: item.providerID, modelID: item.modelID }, item.visibility === "hide").catch(
            () => undefined,
          )
        }
        setStore("user", [])
      })()
    })

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
