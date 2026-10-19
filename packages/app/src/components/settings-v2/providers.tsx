import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { Tag } from "@deepagent-code/ui/v2/badge-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { useProviders } from "@/hooks/use-providers"
import { createMemo, type Component, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider } from "../dialog-connect-provider"
import { DialogConnectSupplier } from "../dialog-connect-supplier"
import { DialogSelectProvider } from "../dialog-select-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { canRefreshProviderModels } from "../provider-model-refresh"
import "./settings-v2.css"
import { SettingsPage } from "./parts/page"
import { PROVIDER_SUPPLIERS, providerPreset, providerSupplier } from "@deepagent-code/core/provider-presets"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders()
  const [refreshing, setRefreshing] = createStore<Record<string, boolean>>({})

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync.data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const connected = createMemo(() => providers.connected())

  const configErrors = createMemo(() => providers.errors())

  const errorKindLabel = (kind: string) =>
    kind === "json" ? language.t("settings.providers.error.json") : language.t("settings.providers.error.schema")

  const connectedSuppliers = createMemo(() => {
    const key = (providerID: string) => {
      const supplier = providerSupplier(providerID)
      return supplier ? `supplier:${supplier.id}` : `provider:${providerID}`
    }
    return [...new Set(connected().map((item) => key(item.id)))].map((identity) => {
      const id = identity.slice(identity.indexOf(":") + 1)
      const supplier = identity.startsWith("supplier:") ? PROVIDER_SUPPLIERS.find((item) => item.id === id) : undefined
      const items = connected().filter((item) => key(item.id) === identity)
      return { id, name: supplier?.name ?? items[0].name, supplier, items }
    })
  })
  const popular = createMemo(() => {
    const present = new Set(connectedSuppliers().flatMap((item) => (item.supplier ? [item.supplier.id] : [])))
    return PROVIDER_SUPPLIERS.filter(
      (item) => !present.has(item.id) && item.providers.some((id) => providers.all().has(id)),
    )
  })
  const supplierName = (id: string, name: string) => {
    if (id === "alibaba-cn") return language.t("settings.providers.supplier.alibabaChina")
    if (id === "alibaba") return language.t("settings.providers.supplier.alibabaInternational")
    return name
  }
  const productDescription = (ids: readonly string[]) =>
    [
      ...new Set(
        ids.flatMap((id) => {
          const preset = providerPreset(id)
          return preset ? [language.t(`settings.providers.billing.${preset.billing}`)] : []
        }),
      ),
    ].join(" · ")

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"

  const canRefresh = (providerID: string) =>
    canRefreshProviderModels(providerID, serverSync.data.config.provider?.[providerID])

  const refreshModels = async (providerID: string, name: string) => {
    if (refreshing[providerID]) return
    setRefreshing(providerID, true)
    await serverSdk.client.provider.models
      .refresh({ providerID }, { throwOnError: true })
      .then((result) => {
        serverSync.refreshProviders()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.models.refresh.toast.title", { provider: name }),
          description: language.t("provider.models.refresh.toast.description", {
            count: Object.keys(result.data?.models ?? {}).length,
          }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setRefreshing(providerID, false))
  }

  const disableProvider = async (providerID: string, name: string) => {
    const before = serverSync.data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    serverSync.set("config", "disabled_providers", next)

    await serverSync
      .updateConfig({ disabled_providers: next })
      .then(async () => {
        // updateConfig only forks the backend instance rebuild (fire-and-forget), so the provider
        // list the immediate refresh reads back can still include the just-disabled provider. Await an
        // explicit dispose so the rebuild completes before refreshing — otherwise the row lingers in
        // the connected list even though the toast reports success.
        await serverSdk.client.global.dispose().catch(() => undefined)
        serverSync.refreshProviders()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        serverSync.set("config", "disabled_providers", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    // Any config-defined third-party provider — including discovery-mode ones whose config has no
    // models (isConfigCustom misses those, so before this they fell through to the standard branch,
    // which only clears a keystore credential the provider doesn't use and left it in the config →
    // it reappeared on every restart). Route them through disableProvider, which writes
    // `disabled_providers`; isProviderAllowed then filters the provider out and it stays gone across
    // restarts.
    if (isCustomProvider(providerID)) {
      await serverSdk.client.auth.remove({ providerID }).catch(() => undefined)
      await disableProvider(providerID, name)
      return
    }
    await serverSdk.client.auth
      .remove({ providerID })
      .then(async () => {
        await serverSdk.client.global.dispose()
        // global.dispose() rebuilds backend state but does not touch the frontend provider cache,
        // so the connected list must be refreshed explicitly or the row won't disappear.
        serverSync.refreshProviders()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  // A third-party provider defined via config (including discovery-mode providers whose config has no
  // models). These open the custom-provider dialog in edit mode so the user can adjust auto-filled
  // specs; official/api/env providers use the standard connect dialog.
  const isCustomProvider = (providerID: string) => {
    const cfg = serverSync.data.config.provider?.[providerID]
    if (!cfg) return false
    const resolvedSource = serverSync.data.provider.all.get(providerID)?.source
    return resolvedSource === "custom" || isConfigCustom(providerID)
  }

  const openProviderConfig = (providerID: string) => {
    if (isCustomProvider(providerID)) {
      dialog.push(() => <DialogCustomProvider edit={providerID} back="close" />)
      return
    }
    dialog.push(() => <DialogConnectProvider provider={providerID} />)
  }

  return (
    <SettingsPage
      title={language.t("settings.providers.title")}
      description={language.t("settings.providers.description")}
      class="settings-v2-providers"
    >
      <section class="settings-v2-section" data-component="connected-providers-section">
        <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
        <div class="settings-v2-provider-cards">
          <Show
            when={connected().length > 0 || configErrors().length > 0}
            fallback={<div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>}
          >
            <For each={configErrors()}>
              {(error) => (
                <article class="settings-v2-provider-card" data-component="provider-config-error">
                  <strong>{error.source}</strong>
                  <p class="settings-v2-provider-description">
                    {errorKindLabel(error.kind)}: {error.message}
                  </p>
                </article>
              )}
            </For>
            <For each={connectedSuppliers()}>
              {(group) => (
                <article
                  class="settings-v2-provider-card"
                  data-supplier={group.supplier?.id}
                  data-provider-card={group.supplier ? undefined : group.id}
                >
                  <div class="settings-v2-provider-card-header">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={group.items[0].id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <span class="settings-v2-provider-name">{supplierName(group.id, group.name)}</span>
                    </div>
                    <ButtonV2
                      variant="neutral"
                      onClick={() =>
                        group.supplier
                          ? dialog.push(() => <DialogConnectSupplier supplier={group.id} />)
                          : openProviderConfig(group.items[0].id)
                      }
                    >
                      {language.t("settings.providers.manage")}
                    </ButtonV2>
                  </div>
                  <div class="settings-v2-provider-card-body">
                    <For each={group.items}>
                      {(item) => (
                        <div class="settings-v2-provider-row" data-provider={item.id}>
                          <div class="settings-v2-provider-copy">
                            <div class="settings-v2-provider-main">
                              <span>{productDescription([item.id]) || item.name}</span>
                              <Tag>{type(item)}</Tag>
                            </div>
                            <Show when={source(item) === "env"}>
                              <p class="settings-v2-provider-description">
                                {language.t("settings.providers.connected.environmentDescription")} ·{" "}
                                {item.env.join(", ")}
                              </p>
                            </Show>
                          </div>
                          <div class="settings-v2-provider-actions">
                            <Show when={canRefresh(item.id)}>
                              <ButtonV2
                                variant="ghost-muted"
                                disabled={refreshing[item.id]}
                                onClick={() => void refreshModels(item.id, item.name)}
                              >
                                {refreshing[item.id]
                                  ? language.t("provider.models.refresh.refreshing")
                                  : language.t("common.refresh")}
                              </ButtonV2>
                            </Show>
                            <Show when={canDisconnect(item)}>
                              <ButtonV2 variant="ghost-muted" onClick={() => void disconnect(item.id, item.name)}>
                                {language.t("common.disconnect")}
                              </ButtonV2>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </article>
              )}
            </For>
          </Show>
        </div>
      </section>
      <section class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
        <div class="settings-v2-provider-cards">
          <For each={popular()}>
            {(supplier) => (
              <article class="settings-v2-provider-card" data-supplier={supplier.id}>
                <div class="settings-v2-provider-card-header">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={supplier.providers[0]}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <span class="settings-v2-provider-name">{supplierName(supplier.id, supplier.name)}</span>
                      <p class="settings-v2-provider-description">{productDescription(supplier.providers)}</p>
                    </div>
                  </div>
                  <ButtonV2
                    variant="neutral"
                    icon="plus"
                    onClick={() => dialog.push(() => <DialogConnectSupplier supplier={supplier.id} />)}
                  >
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              </article>
            )}
          </For>
          <article class="settings-v2-provider-card" data-component="custom-provider-section">
            <div class="settings-v2-provider-card-header">
              <div class="settings-v2-provider-copy">
                <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                <p class="settings-v2-provider-description">{language.t("settings.providers.custom.description")}</p>
              </div>
              <ButtonV2
                variant="neutral"
                icon="plus"
                onClick={() => dialog.push(() => <DialogCustomProvider back="close" />)}
              >
                {language.t("common.connect")}
              </ButtonV2>
            </div>
          </article>
        </div>
        <ButtonV2 variant="ghost" onClick={() => dialog.push(() => <DialogSelectProvider />)}>
          {language.t("dialog.provider.viewAll")}
        </ButtonV2>
      </section>
    </SettingsPage>
  )
}
