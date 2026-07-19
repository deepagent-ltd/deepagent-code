import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { Tag } from "@deepagent-code/ui/v2/badge-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { createMemo, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider } from "../dialog-connect-provider"
import { DialogSelectProvider } from "../dialog-select-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]
const DEEPAGENT_PROVIDER_ID = "deepagent"

const PROVIDER_NOTES = [
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "deepseek", key: "dialog.provider.deepseek.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "xai", key: "dialog.provider.xai.note" },
  { match: (id: string) => id === "zhipuai", key: "dialog.provider.zhipuai.note" },
  { match: (id: string) => id === "zhipuai-coding-plan", key: "dialog.provider.zhipuai-coding-plan.note" },
  { match: (id: string) => id === "zai", key: "dialog.provider.zai.note" },
  { match: (id: string) => id === "zai-coding-plan", key: "dialog.provider.zai-coding-plan.note" },
  { match: (id: string) => id === "kimi-for-coding", key: "dialog.provider.kimi-for-coding.note" },
  { match: (id: string) => id === "moonshotai-cn", key: "dialog.provider.moonshotai-cn.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders()

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync.data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const connected = createMemo(() => {
    return providers.connected().filter((p) => p.id !== DEEPAGENT_PROVIDER_ID)
  })

  const configErrors = createMemo(() => providers.errors())

  const errorKindLabel = (kind: string) =>
    kind === "json" ? language.t("settings.providers.error.json") : language.t("settings.providers.error.schema")

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

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

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

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
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0 || configErrors().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={configErrors()}>
                {(error) => (
                  <div class="settings-v2-provider-row" data-component="provider-config-error">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id="synthetic"
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-copy">
                        <div class="settings-v2-provider-main">
                          <span class="settings-v2-provider-name truncate">{error.source}</span>
                          <Tag class="settings-v2-provider-error-tag">
                            {language.t("settings.providers.tag.configError")}
                          </Tag>
                        </div>
                        <p class="settings-v2-provider-description">
                          {errorKindLabel(error.kind)}: {error.message}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </For>
              <For each={connected()}>
                {(item) => (
                  <div
                    class="settings-v2-provider-row group cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => openProviderConfig(item.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      openProviderConfig(item.id)
                    }}
                  >
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={item.id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name truncate">{item.name}</span>
                        <Tag>{type(item)}</Tag>
                      </div>
                    </div>
                    <Show
                      when={canDisconnect(item)}
                      fallback={
                        <span class="settings-v2-provider-env-hint">
                          {language.t("settings.providers.connected.environmentDescription")}
                        </span>
                      }
                    >
                      <ButtonV2
                        size="normal"
                        variant="ghost-muted"
                        onClick={(event: MouseEvent) => {
                          event.stopPropagation()
                          void disconnect(item.id, item.name)
                        }}
                      >
                        {language.t("common.disconnect")}
                      </ButtonV2>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={popular()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    icon="plus"
                    onClick={() => {
                      dialog.show(() => <DialogConnectProvider provider={item.id} />)
                    }}
                  >
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <div class="settings-v2-provider-row" data-component="custom-provider-section">
              <div class="settings-v2-provider-lead">
                <ProviderIcon
                  id="synthetic"
                  width={PROVIDER_ICON_SIZE}
                  height={PROVIDER_ICON_SIZE}
                  class="settings-v2-provider-icon shrink-0"
                />
                <div class="settings-v2-provider-copy">
                  <div class="settings-v2-provider-main">
                    <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                    <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                  </div>
                  <p class="settings-v2-provider-description">{language.t("settings.providers.custom.description")}</p>
                </div>
              </div>
              <ButtonV2
                size="normal"
                variant="neutral"
                icon="plus"
                onClick={() => {
                  dialog.show(() => <DialogCustomProvider back="close" />)
                }}
              >
                {language.t("common.connect")}
              </ButtonV2>
            </div>
          </SettingsListV2>

          <button
            type="button"
            class="settings-v2-providers-view-all"
            onClick={() => {
              dialog.show(() => <DialogSelectProvider />)
            }}
          >
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}
