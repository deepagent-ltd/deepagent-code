import { createEffect, createResource, createSignal, For, Show, type Component } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { MessageSearch } from "@/components/im/message-search"
import { fetchIMCapabilities } from "@/components/im/capabilities"
import { useIMClient } from "@/utils/im-client"
import type { IMGroup } from "@/components/im/types"
import { submitCreateDirect, submitCreateGroup } from "@/pages/session/im-panel-helpers"

// IM as a right-side-panel tab. Mirrors the other side-panels (browser, subagents):
// owns a header + close button (calls onClose), fills the panel with `h-full`
// instead of the old full-screen `h-screen` route. Group creation uses an inline
// input — never window.prompt(), which throws in the Electron renderer.
export const SidePanelIM: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const sdk = useSDK()

  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [loading, setLoading] = createSignal(true)
  const [selectedGroupID, setSelectedGroupID] = createSignal<string | null>(null)
  const [creatingName, setCreatingName] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  // §B3 direct message — the inline counterparty editor state (null = closed).
  const [directTarget, setDirectTarget] = createSignal<string | null>(null)

  // §B3/§H3 capability gate — thread view + file upload only where the server's flags are ON.
  const [capabilities] = createResource(() =>
    fetchIMCapabilities(sdk.client as unknown as Parameters<typeof fetchIMCapabilities>[0]),
  )
  const threadsEnabled = () => capabilities()?.v4ThreadEnabled ?? false
  const fileUploadEnabled = () => capabilities()?.v4FileUploadEnabled ?? false

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

  const startDirect = () => setDirectTarget("")
  const cancelDirect = () => setDirectTarget(null)

  const submitDirect = async () => {
    const target = directTarget()?.trim() ?? ""
    if (!target) {
      cancelDirect()
      return
    }
    // A leading "@" marks an agent counterparty; otherwise a user id.
    const isAgent = target.startsWith("@")
    const memberID = isAgent ? target.slice(1) : target
    setBusy(true)
    const result = await submitCreateDirect(
      memberID,
      { memberID, memberType: isAgent ? "agent" : "user" },
      (payload) => client.createGroup(payload),
    )
    setBusy(false)
    if ("skipped" in result) {
      cancelDirect()
      return
    }
    if ("error" in result) {
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
    setDirectTarget(null)
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
              icon="magnifying-glass"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              classList={{ "bg-surface-raised-base-active": searching() }}
              onClick={() => setSearching((v) => !v)}
              aria-label="Search messages"
            />
            <IconButton
              icon="bubble-5"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              disabled={busy() || directTarget() !== null}
              onClick={startDirect}
              aria-label="New direct message"
            />
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
            {/* §B3 search — opens a message search over the caller's group memberships. Selecting a
                result jumps to its group. */}
            <Show when={searching()}>
              <div class="border-b border-border-weaker-base">
                <MessageSearch
                  onSelect={({ groupID }) => {
                    setSearching(false)
                    setSelectedGroupID(groupID)
                  }}
                />
              </div>
            </Show>
            {/* §B3 direct message — inline counterparty editor. Prefix "@" for an agent. */}
            <Show when={directTarget() !== null}>
              <div class="p-2 border-b border-border-weaker-base">
                <InlineInput
                  ref={(el: HTMLInputElement) => queueMicrotask(() => el.isConnected && el.focus())}
                  class="w-full rounded-md border border-border-weak-base bg-surface-panel px-2 py-1 text-13-regular outline-none"
                  value={directTarget() ?? ""}
                  placeholder="User id, or @agent-id"
                  disabled={busy()}
                  onInput={(event) => setDirectTarget(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === "Enter") void submitDirect()
                    else if (event.key === "Escape") cancelDirect()
                  }}
                  onBlur={() => {
                    if (!busy()) cancelDirect()
                  }}
                />
              </div>
            </Show>
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
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden relative">
            <GroupChatPanel
              groupID={id()}
              threadsEnabled={threadsEnabled()}
              fileUploadEnabled={fileUploadEnabled()}
            />
          </div>
        )}
      </Show>
    </div>
  )
}
