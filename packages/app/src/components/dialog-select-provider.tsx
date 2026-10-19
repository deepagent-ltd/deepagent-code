import { Component, Show } from "solid-js"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useProviders } from "@/hooks/use-providers"
import { Dialog } from "@deepagent-code/ui/dialog"
import { List } from "@deepagent-code/ui/list"
import { Tag } from "@deepagent-code/ui/tag"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { useLanguage } from "@/context/language"
import { DialogCustomProvider } from "./dialog-custom-provider"
import { PROVIDER_SUPPLIERS, providerSupplier } from "@deepagent-code/core/provider-presets"
import { DialogConnectSupplier } from "./dialog-connect-supplier"

const CUSTOM_ID = "_custom"

export const DialogSelectProvider: Component = () => {
  const dialog = useDialog()
  const providers = useProviders()
  const language = useLanguage()

  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const note = (id: string) => {
    if (id === "deepagent") return language.t("dialog.provider.deepagent.note")
    if (id === "anthropic") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id === "deepseek") return language.t("dialog.provider.deepseek.note")
  }

  return (
    <Dialog title={language.t("command.provider.connect")} transition>
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(x) => x ? `${x.supplier ? "supplier" : "provider"}:${x.id}` : CUSTOM_ID}
        items={() => {
          language.locale()
          return [
            { id: CUSTOM_ID, name: customLabel(), supplier: false, icon: "synthetic", keywords: "" },
            ...PROVIDER_SUPPLIERS.filter((supplier) => supplier.providers.some((id) => providers.all().has(id))).map(
              (supplier) => ({
                id: supplier.id,
                name:
                  supplier.id === "alibaba-cn"
                    ? language.t("settings.providers.supplier.alibabaChina")
                    : supplier.id === "alibaba"
                      ? language.t("settings.providers.supplier.alibabaInternational")
                      : supplier.name,
                supplier: true,
                icon: supplier.providers[0],
                keywords: supplier.providers.join(" "),
              }),
            ),
            ...Array.from(providers.all().values())
              .filter((provider) => !providerSupplier(provider.id))
              .map((provider) => ({
                id: provider.id,
                name: provider.name,
                supplier: false,
                icon: provider.id,
                keywords: "",
              })),
          ]
        }}
        filterKeys={["id", "name", "keywords"]}
        groupBy={(x) => (x.supplier ? popularGroup() : otherGroup())}
        sortBy={(a, b) => {
          if (a.id === CUSTOM_ID) return -1
          if (b.id === CUSTOM_ID) return 1
          if (a.supplier && b.supplier)
            return (
              PROVIDER_SUPPLIERS.findIndex((item) => item.id === a.id) -
              PROVIDER_SUPPLIERS.findIndex((item) => item.id === b.id)
            )
          return a.name.localeCompare(b.name)
        }}
        sortGroupsBy={(a, b) => {
          const popular = popularGroup()
          if (a.category === popular && b.category !== popular) return -1
          if (b.category === popular && a.category !== popular) return 1
          return 0
        }}
        onSelect={(x) => {
          if (!x) return
          if (x.id === CUSTOM_ID) {
            dialog.show(() => <DialogCustomProvider back="providers" />)
            return
          }
          if (x.supplier) {
            dialog.show(() => <DialogConnectSupplier supplier={x.id} />)
            return
          }
          dialog.show(() => <DialogConnectProvider provider={x.id} />)
        }}
      >
        {(i) => (
          <div class="px-1.25 w-full flex items-center gap-x-3">
            <ProviderIcon data-slot="list-item-extra-icon" id={i.icon} />
            <span>{i.name}</span>
            <Show when={i.id === CUSTOM_ID}>
              <Tag>{language.t("settings.providers.tag.custom")}</Tag>
            </Show>
            <Show when={note(i.id)}>{(value) => <div class="text-14-regular text-text-weak">{value()}</div>}</Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
