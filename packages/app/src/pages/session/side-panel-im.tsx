import { createEffect, createSignal, For, Show, type Component } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useLanguage } from "@/context/language"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { useIMClient } from "@/utils/im-client"
import type { IMGroup } from "@/components/im/types"
import { submitCreateGroup } from "@/pages/session/im-panel-helpers"

// IM as a right-side-panel tab. Mirrors the other side-panels (browser, subagents):
// owns a header + close button (calls onClose), fills the panel with `h-full`
// instead of the old full-screen `h-screen` route. Group creation uses an inline
// input — never window.prompt(), which throws in the Electron renderer.
export const SidePanelIM: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()

  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [loading, setLoading] = createSignal(true)
  const [selectedGroupID, setSelectedGroupID] = createSignal<string | null>(null)
  const [creatingName, setCreatingName] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const loadGroups = () => {
    setLoading(true)
    client
      .listGroups()
      .then((data) => {
        setGroups(data)
        setLoading(false)
      })
      .catch((error) => {
        console.error("Failed to load IM groups:", error)
        setLoading(false)
      })
  }

  createEffect(() => {
    loadGroups()
  })

  const startCreate = () => setCreatingName("")
  const cancelCreate = () => setCreatingName(null)

  const submitCreate = async () => {
    setBusy(true)
    const result = await submitCreateGroup(creatingName() ?? "", (payload) => client.createGroup(payload))
    setBusy(false)
    if ("skipped" in result) {
      cancelCreate()
      return
    }
    if ("error" in result) {
      console.error("Failed to create IM group:", result.error)
      const { showToast } = await import("@/utils/toast")
      showToast({
        variant: "error",
        title: language.t("im.group.create.failed"),
        description: result.error,
      })
      return
    }
    setGroups((prev) => [...prev, result.group])
    setSelectedGroupID(result.group.id)
    setCreatingName(null)
  }

  const backToList = () => setSelectedGroupID(null)

  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-base">
      <div class="sticky top-0 z-10 h-10 shrink-0 flex items-center justify-between gap-1 px-2 bg-background-base border-b border-border-weaker-base">
        <div class="flex items-center gap-1 min-w-0">
          <Show when={selectedGroupID()}>
            <IconButton
              icon="chevron-left"
              variant="ghost"
              class="h-7 w-7 rounded-md shrink-0"
              onClick={backToList}
              aria-label={language.t("common.goBack")}
            />
          </Show>
          <span class="text-13-medium text-text-strong truncate">{language.t("session.tab.im")}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <Show when={!selectedGroupID()}>
            <IconButton
              icon="plus-small"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              disabled={busy() || creatingName() !== null}
              onClick={startCreate}
              aria-label={language.t("im.group.create")}
            />
          </Show>
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-7 w-7 rounded-md"
            onClick={props.onClose}
            aria-label={language.t("common.close")}
          />
        </div>
      </div>

      <Show
        when={selectedGroupID()}
        fallback={
          <div class="flex-1 min-h-0 flex flex-col overflow-y-auto">
            <Show when={creatingName() !== null}>
              <div class="p-2 border-b border-border-weaker-base">
                <InlineInput
                  ref={(el: HTMLInputElement) => queueMicrotask(() => el.isConnected && el.focus())}
                  class="w-full rounded-md border border-border-weak-base bg-surface-panel px-2 py-1 text-13-regular outline-none"
                  value={creatingName() ?? ""}
                  placeholder={language.t("im.group.create.placeholder")}
                  disabled={busy()}
                  onInput={(event) => setCreatingName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === "Enter") void submitCreate()
                    else if (event.key === "Escape") cancelCreate()
                  }}
                  onBlur={() => {
                    if (!busy()) cancelCreate()
                  }}
                />
              </div>
            </Show>
            <Show
              when={!loading()}
              fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("im.loading")}</div>}
            >
              <Show
                when={groups().length > 0}
                fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("im.group.empty")}</div>}
              >
                <div class="flex flex-col gap-0.5 p-2">
                  <For each={groups()}>
                    {(group) => (
                      <button
                        type="button"
                        onClick={() => setSelectedGroupID(group.id)}
                        class="w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-raised-base-hover"
                      >
                        <div class="text-13-medium text-text-strong truncate">{group.name}</div>
                        <div class="text-11-regular text-text-weak truncate">{group.type}</div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        }
      >
        {(id) => (
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
            <GroupChatPanel groupID={id()} />
          </div>
        )}
      </Show>
    </div>
  )
}
