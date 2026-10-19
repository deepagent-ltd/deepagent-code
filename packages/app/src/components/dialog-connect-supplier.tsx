import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { PROVIDER_SUPPLIERS, providerPreset } from "@deepagent-code/core/provider-presets"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { DialogConnectProvider } from "./dialog-connect-provider"

export function DialogConnectSupplier(props: { supplier: string; provider?: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const providers = useProviders()
  const supplier = () => PROVIDER_SUPPLIERS.find((item) => item.id === props.supplier)
  const products = createMemo(() =>
    (supplier()?.providers ?? []).flatMap((id) => {
      const provider = providers.all().get(id)
      const preset = providerPreset(id)
      return provider && preset ? [{ provider, preset }] : []
    }),
  )
  const [state, setState] = createStore({ provider: props.provider })
  const selected = createMemo(() => {
    if (state.provider) return products().find((item) => item.provider.id === state.provider)?.provider.id
    if (products().length === 1) return products()[0].provider.id
    return undefined
  })
  const back = () => {
    if (products().length > 1) {
      setState("provider", undefined)
      return
    }
    void import("./dialog-select-provider").then((module) => dialog.show(() => <module.DialogSelectProvider />))
  }

  return (
    <Show
      when={selected()}
      keyed
      fallback={
        <Dialog
          class="provider-connect-dialog"
          title={language.t("provider.connect.supplier.title", { supplier: supplier()?.name ?? props.supplier })}
        >
          <div class="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
            <p class="text-12-regular text-text-weak">{language.t("provider.connect.supplier.description")}</p>
            <Show when={products().length > 0} fallback={<p>{language.t("dialog.provider.empty")}</p>}>
              <div class="flex min-w-0 flex-col gap-2">
                <For each={products()}>
                  {(item) => (
                    <Button
                      class="h-auto min-h-12 w-full min-w-0 justify-start gap-3 whitespace-normal py-3"
                      variant="secondary"
                      onClick={() => setState("provider", item.provider.id)}
                    >
                      <ProviderIcon id={item.provider.id} class="size-5 shrink-0" />
                      <span class="flex min-w-0 flex-col items-start gap-1 break-words text-left">
                        <span>{item.provider.name}</span>
                        <span class="text-11-regular text-text-weak">
                          {language.t(`settings.providers.billing.${item.preset.billing}`)} ·{" "}
                          {language.t(`settings.providers.region.${item.preset.region}`)}
                        </span>
                      </span>
                    </Button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Dialog>
      }
    >
      {(provider) => <DialogConnectProvider provider={provider} onBack={back} />}
    </Show>
  )
}
