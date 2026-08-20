import { createResource, createSignal, type Component, For, Show } from "solid-js"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Spinner } from "@deepagent-code/ui/spinner"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

// PARITY-004 / GUI 批 — Console 账号接线:消费 /experimental/console/orgs 与 /switch,
// 列出可切换的 Console 组织并切换活跃组织(server-side truth,见 worklist GUI 批)。
type Org = {
  accountID: string
  accountEmail: string
  accountUrl: string
  orgID: string
  orgName: string
  active: boolean
}

export const DialogConsoleAccount: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [switching, setSwitching] = createSignal<string | undefined>()

  const [orgs] = createResource(async () => {
    const result = await serverSDK.client.experimental.console.listOrgs(undefined, { throwOnError: true })
    return (result.data?.orgs ?? []) as Org[]
  })

  const switchOrg = async (org: Org) => {
    if (switching()) return
    setSwitching(`${org.accountID}:${org.orgID}`)
    await serverSDK.client.experimental.console
      .switchOrg({ accountID: org.accountID, orgID: org.orgID }, { throwOnError: true })
      .then(() => {
        serverSync.refreshProviders()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.providers.console.switch.toast.title"),
          description: language.t("settings.providers.console.switch.toast.description", { org: org.orgName }),
        })
        dialog.close()
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setSwitching(undefined))
  }

  return (
    <Dialog title={language.t("settings.providers.console.switchOrg")} transition>
      <Show
        when={!orgs.loading}
        fallback={
          <div class="flex items-center justify-center py-8">
            <Spinner />
          </div>
        }
      >
        <Show
          when={(orgs() ?? []).length > 0}
          fallback={
            <div class="px-4 py-6 text-14-regular text-text-weak">
              {language.t("settings.providers.console.empty")}
            </div>
          }
        >
          <div class="flex flex-col px-2 py-1">
            <For each={orgs() ?? []}>
              {(org) => {
                const key = `${org.accountID}:${org.orgID}`
                return (
                  <button
                    type="button"
                    disabled={!!switching()}
                    class="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-fill-weak-base disabled:opacity-60"
                    onClick={() => void switchOrg(org)}
                  >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate text-14-medium text-text-strong">{org.orgName}</span>
                      <span class="truncate text-12-regular text-text-weak">{org.accountEmail}</span>
                    </span>
                    <Show when={switching() === key}>
                      <Spinner />
                    </Show>
                    <Show when={org.active && switching() !== key}>
                      <span class="text-12-medium text-text-interactive-base">
                        {language.t("common.active")}
                      </span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </Dialog>
  )
}
