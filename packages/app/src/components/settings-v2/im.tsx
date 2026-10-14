import { Show, createSignal } from "solid-js"
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

export function SettingsIMV2(props: { activation?: IMActivationClient }) {
  const language = useLanguage()
  const server = useServer()
  const sdk = useServerSDK()
  const sync = useServerSync()
  const models = useModels()
  const scope = sdk.scope
  const current = () => scope === server.scope() && scope === sdk.scope && ServerConnection.local(server.current)
  const activation = props.activation ?? createIMActivationClient({ client: sdk.client, scope: server.scope, current })
  const options = () =>
    models
      .list()
      .filter((model) => models.visible({ providerID: model.provider.id, modelID: model.id }))
      .map((model) => ({ value: `${model.provider.id}/${model.id}`, label: `${model.provider.name} / ${model.name}` }))
  const update = sync.updateConfig
  const [deviceAvailable, setDeviceAvailable] = createSignal(false)

  return (
    <div class="settings-v2-tab-body flex flex-col gap-6">
      <h2 class="settings-v2-tab-title">{language.t("settings.im.title")}</h2>
      <Show when={current()} fallback={<p role="status">{language.t("im.activation.localOnly")}</p>}>
        <IMDevicePanel
          client={sdk.client as unknown as IMDeviceClient.Transport}
          current={current}
          available={setDeviceAvailable}
        />
        <Show when={deviceAvailable()}>
          <IMActivationPanel
            client={activation}
            current={current}
            activated={() => {
              if (current()) sync.refreshProviders()
            }}
          />
        </Show>
        <SettingsIMModel
          options={options}
          value={() => sync.data.config.im?.model}
          current={current}
          save={(model) =>
            current() ? update({ im: { model } }) : Promise.reject(new Error("Retired settings scope"))
          }
        />
      </Show>
    </div>
  )
}
