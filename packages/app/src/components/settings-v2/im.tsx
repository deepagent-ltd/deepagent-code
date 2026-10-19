import { Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueryClient } from "@tanstack/solid-query"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { IMDevicePanel } from "../im/device-panel"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"
import { IMActivationPanel } from "../im/activation-panel"
import type { IMActivationClient } from "../im/activation-controller"
import { createIMActivationClient } from "@/utils/im-activation-client"
import { SettingsIMModel } from "./im-model"
import { SettingsIMService } from "./im-service"
import type { IMFacadeStatus } from "@/utils/im-client"
import { SettingsPage } from "./parts/page"

export function SettingsIMV2(props: { activation?: IMActivationClient }) {
  const language = useLanguage()
  const server = useServer()
  const sdk = useServerSDK()
  const sync = useServerSync()
  const models = useModels()
  const queryClient = useQueryClient()
  const owner = new AbortController()
  const scope = sdk.scope
  const current = () =>
    !owner.signal.aborted && scope === server.scope() && scope === sdk.scope && ServerConnection.local(server.current)
  const options = () =>
    models
      .list()
      .filter((model) => models.visible({ providerID: model.provider.id, modelID: model.id }))
      .map((model) => ({ value: `${model.provider.id}/${model.id}`, label: `${model.provider.name} / ${model.name}` }))
  const update = sync.updateConfig
  const [modelBusy, setModelBusy] = createSignal(false)
  const [deviceAvailable, setDeviceAvailable] = createSignal(false)
  const [deviceRequested, setDeviceRequested] = createSignal(false)
  const [service, setService] = createStore({
    info: undefined as IMFacadeStatus["service"],
    busy: false,
    loading: false,
    failed: false,
  })
  const observation = { generation: 0, abort: new AbortController() }
  const retire = () => {
    observation.generation++
    observation.abort.abort()
    observation.abort = new AbortController()
    setService({ info: undefined, loading: false, failed: false })
    setDeviceAvailable(false)
    setDeviceRequested(false)
  }
  const signal = () => AbortSignal.any([owner.signal, observation.abort.signal, AbortSignal.timeout(10_000)])
  const loadService = async () => {
    if (!current() || modelBusy() || service.loading) return
    const generation = ++observation.generation
    setService("loading", true)
    return sdk.client.im.facade
      .status(undefined, { signal: signal(), throwOnError: true })
      .then(
        (result) => {
          if (current() && generation === observation.generation)
            setService({ info: result.data?.service, failed: !result.data?.service })
        },
        (error: unknown) => {
          if (current() && generation === observation.generation) setService({ info: undefined, failed: true })
          throw error
        },
      )
      .finally(() => {
        if (current() && generation === observation.generation) setService("loading", false)
      })
  }
  createEffect(
    on(current, (active) => {
      retire()
      if (!active || service.busy || modelBusy()) return
      void loadService().catch(() => {})
    }),
  )
  createEffect(
    on(
      () => sync.data.config.im?.url,
      () => {
        if (!current() || service.busy) return
        retire()
        void loadService().catch(() => {})
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    owner.abort()
    observation.abort.abort()
  })

  return (
    <SettingsPage title={language.t("settings.im.title")} description={language.t("settings.im.description")}>
      <Show when={current()} fallback={<p role="status">{language.t("im.activation.localOnly")}</p>}>
        <div class="settings-v2-section" data-slot="settings-im-service-group">
          <SettingsIMService
            configured={() => sync.data.config.im?.url}
            service={() => service.info}
            current={() => current() && !modelBusy()}
            save={async (url) => {
              if (!current() || service.busy || modelBusy()) throw new Error("Retired settings scope")
              retire()
              setService({ busy: true, failed: false })
              try {
                await update({ im: { ...sync.data.config.im, url } })
                if (!current()) throw new Error("Retired settings scope")
                const observed = await sdk.client.global.config.get({ signal: signal(), throwOnError: true })
                if (!current() || observed.data?.im?.url !== url) throw new Error("Service setting changed")
                queryClient.setQueryData(sync.queryOptions.globalConfig().queryKey, observed.data)
                await loadService()
              } finally {
                if (!owner.signal.aborted) setService("busy", false)
              }
            }}
          />
          <Show when={service.failed}>
            <p role="alert">{language.t("settings.im.service.loadFailed")}</p>
          </Show>
          <Show when={service.failed || !service.info}>
            <ButtonV2
              variant="neutral"
              class="self-start"
              disabled={!current() || service.busy || service.loading || modelBusy()}
              onClick={() => {
                if (!current() || service.busy || service.loading || modelBusy()) return
                void loadService().catch(() => {})
              }}
            >
              {language.t(service.loading ? "common.loading" : "common.retry")}
            </ButtonV2>
          </Show>
        </div>
        <section class="settings-v2-section" data-slot="settings-im-device-group">
          <h3 class="settings-v2-section-title">{language.t("settings.im.deviceGroup")}</h3>
          <p class="text-12-regular text-text-weak">{language.t("settings.im.deviceGroup.description")}</p>
          <Show when={!service.busy && service.info?.url && !deviceRequested()}>
            <ButtonV2
              variant="neutral"
              class="self-start"
              onClick={() => {
                if (current()) setDeviceRequested(true)
              }}
            >
              {language.t("settings.im.service.checkDevice")}
            </ButtonV2>
          </Show>
          <Show when={!service.busy && deviceRequested() && service.info?.url} keyed>
            {(url) => {
              const selected = () => current() && !service.busy && service.info?.url === url
              const activation =
                props.activation ??
                createIMActivationClient({ client: sdk.client, scope: server.scope, current: selected })
              return (
                <>
                  <IMDevicePanel
                    client={sdk.client as unknown as IMDeviceClient.Transport}
                    current={selected}
                    available={setDeviceAvailable}
                  />
                  <Show when={deviceAvailable()}>
                    <IMActivationPanel
                      client={activation}
                      current={selected}
                      activated={() => {
                        if (selected()) sync.refreshProviders()
                      }}
                    />
                  </Show>
                </>
              )
            }}
          </Show>
        </section>
        <section class="settings-v2-section" data-slot="settings-im-model-group">
          <SettingsIMModel
            options={options}
            value={() => sync.data.config.im?.model}
            current={() => current() && !service.busy && !service.loading && !!service.info}
            save={async (model) => {
              if (!current() || service.busy || !service.info) throw new Error("Retired settings scope")
              setModelBusy(true)
              try {
                await update({ im: { ...sync.data.config.im, model } })
              } finally {
                if (!owner.signal.aborted) setModelBusy(false)
              }
            }}
          />
        </section>
      </Show>
    </SettingsPage>
  )
}
