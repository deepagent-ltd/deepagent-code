import { createEffect, createResource, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { MessageSearch } from "@/components/im/message-search"
import { fetchIMCapabilities } from "@/components/im/capabilities"
import { IMFacadeRequestError, useIMClient, type IMFacadeStatus } from "@/utils/im-client"
import type { IMGroup } from "@/components/im/types"
import { submitCreateDirect, submitCreateGroup, submitFacadeName } from "@/pages/session/im-panel-helpers"
import { facadeFailureText, type FacadeFailureLike } from "@/components/im/facade-errors"
import { BlockedCard, ClaimCard, IdentityCard } from "@/components/im/facade-cards"
import { KernelGroupDialog } from "@/components/im/facade-dialogs"

// IM as a right-side-panel tab. Mirrors the other side-panels (browser, subagents):
// owns a header + close button (calls onClose), fills the panel with `h-full`
// instead of the old full-screen `h-screen` route. Group creation uses an inline
// input — never window.prompt(), which throws in the Electron renderer.
//
// Only a missing status endpoint permits legacy mode; transient failures must not enable local-only creation.
// active ⇒ 顶部身份卡 + 群徽标（全员群/内核群）+ 私聊/建群/邀请走门面端点（按名字，不按裸 id）；
// claim_required ⇒ 认领卡；blocked ⇒ 逐码错误卡（重试 + 可找回码的 rebind 入口）。
export const SidePanelIM: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const sdk = useSDK()
  const dialog = useDialog()

  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [loading, setLoading] = createSignal(true)
  const [selectedGroupID, setSelectedGroupID] = createSignal<string | null>(null)
  const [creatingName, setCreatingName] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  // §B3 direct message — the inline counterparty editor state (null = closed). Facade 模式下
  // 同一个输入框承载"通讯录名字"（而不是裸 user id / @agent-id）。
  const [directTarget, setDirectTarget] = createSignal<string | null>(null)
  // 门面操作的行内错误（direct/invite），逐码呈现。
  const [inlineFailure, setInlineFailure] = createSignal<FacadeFailureLike | null>(null)
  // 邀请入口（群视图 header）：邀请中的群 id（null = 关闭）。
  const [invitingGroupID, setInvitingGroupID] = createSignal<string | null>(null)
  const [inviteName, setInviteName] = createSignal("")
  const [availability, setAvailability] = createStore({ statusFailed: false, groupsFailed: false })

  const disabledFacadeStatus: IMFacadeStatus = {
    facade: "disabled",
    identity: null,
    blocked: null,
    kernel: null,
    keyOrigin: "none",
  }
  const [facadeStatus, { refetch: refetchFacade }] = createResource(async () => {
    const result = await client.facadeStatus().catch((error: unknown) => {
      if (error instanceof IMFacadeRequestError && error.status === 404) return disabledFacadeStatus
      return undefined
    })
    setAvailability("statusFailed", !result)
    return result
  })
  const facadeState = () => facadeStatus()?.facade
  const facadeActive = () => facadeState() === "active"
  const canCreate = () =>
    !facadeStatus.loading && !availability.statusFailed && (facadeActive() || facadeState() === "disabled")
  const identity = () => facadeStatus()?.identity ?? null

  /** k:2:<orgAllGroupID> ⇒ 全员群；其余 k:2: ⇒ 内核群；k:1:/null 不挂徽标（direct/本地语义自明）。 */
  const kernelBadge = (group: IMGroup): "orgAll" | "kernel" | null => {
    const conv = group.kernelConvID
    if (!conv?.startsWith("k:2:")) return null
    const orgAll = identity()?.orgAllGroupID
    return orgAll && conv === `k:2:${orgAll}` ? "orgAll" : "kernel"
  }

  /** 群视图 header 的邀请入口只对内核群（k:2: 绑定）开放。 */
  const selectedGroup = () => groups().find((g) => g.id === selectedGroupID())
  const inviteable = () => facadeActive() && selectedGroup()?.kernelConvID?.startsWith("k:2:")

  // §B3/§H3 capability gate — thread view + file upload only where the server's flags are ON.
  const [capabilities] = createResource(() =>
    fetchIMCapabilities(sdk.client as unknown as Parameters<typeof fetchIMCapabilities>[0]),
  )
  const threadsEnabled = () => capabilities()?.v4ThreadEnabled ?? false
  const fileUploadEnabled = () => capabilities()?.v4FileUploadEnabled ?? false

  const loadGroups = (background = false) => {
    if (!background) setLoading(true)
    client
      .listGroups()
      .then((data) => {
        setGroups(data)
        setAvailability("groupsFailed", false)
        setLoading(false)
      })
      .catch(() => {
        setAvailability("groupsFailed", true)
        setLoading(false)
      })
  }

  createEffect(() => {
    loadGroups()
  })
  const refreshTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return
    void refetchFacade()
    loadGroups(true)
  }, 15_000)
  onCleanup(() => clearInterval(refreshTimer))

  /** 门面状态变化（claim/rename/rebind/retry 成功）后的统一刷新：状态卡 + 群列表。 */
  const refreshFacade = () => {
    void refetchFacade()
    loadGroups()
  }

  const toastError = async (title: string, description: string) => {
    const { showToast } = await import("@/utils/toast")
    showToast({ variant: "error", title, description })
  }

  const startCreate = () => {
    if (!canCreate()) return
    setInlineFailure(null)
    if (facadeActive()) {
      // 门面模式：建群即建内核群（群名 + 成员名 chips 对话框）。
      dialog.show(() => (
        <KernelGroupDialog
          onCreated={(group) => {
            setGroups((prev) => (prev.some((g) => g.id === group.id) ? prev : [...prev, group]))
            setSelectedGroupID(group.id)
          }}
        />
      ))
      return
    }
    setCreatingName("")
  }
  const cancelCreate = () => setCreatingName(null)

  const submitCreate = async () => {
    if (busy() || !canCreate()) return
    setBusy(true)
    const result = await submitCreateGroup(creatingName() ?? "", (payload) => client.createGroup(payload))
    setBusy(false)
    if ("skipped" in result) {
      cancelCreate()
      return
    }
    if ("error" in result) {
      console.error("Failed to create IM group:", result.error)
      void toastError(language.t("im.group.create.failed"), result.error)
      return
    }
    setGroups((prev) => [...prev, result.group])
    setSelectedGroupID(result.group.id)
    setCreatingName(null)
  }

  const startDirect = () => {
    if (!canCreate()) return
    setInlineFailure(null)
    setDirectTarget("")
  }
  const cancelDirect = () => setDirectTarget(null)

  const submitDirect = async () => {
    if (busy() || !canCreate()) return
    const target = directTarget()?.trim() ?? ""
    if (!target) {
      cancelDirect()
      return
    }
    setBusy(true)
    if (facadeActive()) {
      // 门面模式：按通讯录名字发起私聊（resolve + 本地 direct 群幂等复用 + k:1: 绑定，服务端一次完成）。
      const result = await submitFacadeName(target, (name) => client.facadeOpenDirect(name))
      setBusy(false)
      if ("skipped" in result) {
        cancelDirect()
        return
      }
      if ("errorCode" in result) {
        setInlineFailure(result)
        return
      }
      const group = result.value
      setGroups((prev) => (prev.some((g) => g.id === group.id) ? prev : [...prev, group]))
      setSelectedGroupID(group.id)
      setDirectTarget(null)
      return
    }
    // 单用户（legacy）路径：裸 user id，或前缀 "@" 的 agent id。
    const isAgent = target.startsWith("@")
    const memberID = isAgent ? target.slice(1) : target
    const result = await submitCreateDirect(memberID, { memberID, memberType: isAgent ? "agent" : "user" }, (payload) =>
      client.createGroup(payload),
    )
    setBusy(false)
    if ("skipped" in result) {
      cancelDirect()
      return
    }
    if ("error" in result) {
      void toastError(language.t("im.group.create.failed"), result.error)
      return
    }
    setGroups((prev) => [...prev, result.group])
    setSelectedGroupID(result.group.id)
    setDirectTarget(null)
  }

  const submitInvite = async () => {
    if (busy() || !facadeActive()) return
    const groupID = invitingGroupID()
    if (!groupID) return
    setBusy(true)
    setInlineFailure(null)
    const result = await submitFacadeName(inviteName(), (name) => client.facadeInvite(groupID, name))
    setBusy(false)
    if ("skipped" in result) return
    if ("errorCode" in result) {
      setInlineFailure(result)
      return
    }
    const invited = inviteName().trim()
    setInvitingGroupID(null)
    setInviteName("")
    const { showToast } = await import("@/utils/toast")
    showToast({ variant: "success", title: language.t("im.facade.invite.success", { name: invited }) })
  }

  const backToList = () => {
    setSelectedGroupID(null)
    setInvitingGroupID(null)
    setInlineFailure(null)
  }

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
              aria-label={language.t("im.search.messages")}
            />
            <IconButton
              icon="bubble-5"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              disabled={busy() || !canCreate() || directTarget() !== null}
              onClick={startDirect}
              aria-label={language.t("im.direct.create")}
            />
            <IconButton
              icon="plus-small"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              disabled={busy() || !canCreate() || creatingName() !== null}
              onClick={startCreate}
              aria-label={language.t("im.group.create")}
            />
          </Show>
          {/* 邀请入口：群视图 + 内核群（k:2: 绑定）+ 门面 active */}
          <Show when={inviteable()}>
            <IconButton
              icon="plus-small"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              classList={{ "bg-surface-raised-base-active": invitingGroupID() !== null }}
              disabled={busy()}
              onClick={() => {
                setInlineFailure(null)
                setInviteName("")
                setInvitingGroupID((current) => (current === null ? selectedGroupID() : null))
              }}
              aria-label={language.t("im.facade.invite")}
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
            <Show when={availability.statusFailed}>
              <div class="m-3 flex flex-col gap-2 rounded-md border border-border-weaker-base p-3" role="alert">
                <p class="text-12-regular text-text-critical">{language.t("im.facade.status.failed")}</p>
                <Button size="small" variant="secondary" disabled={facadeStatus.loading} onClick={refreshFacade}>
                  {language.t("im.facade.retry")}
                </Button>
              </div>
            </Show>
            {/* B2 门面状态卡：claim_required ⇒ 认领引导；blocked ⇒ 逐码错误 + 重试/找回。 */}
            <Show when={facadeState() === "claim_required"}>
              <ClaimCard onClaimed={refreshFacade} />
            </Show>
            <Show when={facadeState() === "blocked" && facadeStatus()?.blocked}>
              {(blocked) => <BlockedCard blocked={blocked()} onRecovered={refreshFacade} />}
            </Show>
            {/* B2 门面身份卡（active）：name + uuid 短码 + 内核连接态 + rename/rebind 入口。 */}
            <Show when={facadeActive() && facadeStatus()}>
              {(status) => <IdentityCard status={status()} onChanged={refreshFacade} />}
            </Show>
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
            {/* §B3 direct message — inline counterparty editor. Facade 模式下按通讯录名字；
                legacy 模式前缀 "@" for an agent、否则裸 user id。 */}
            <Show when={directTarget() !== null}>
              <div class="p-2 border-b border-border-weaker-base flex flex-col gap-1">
                <InlineInput
                  ref={(el: HTMLInputElement) => queueMicrotask(() => el.isConnected && el.focus())}
                  class="w-full rounded-md border border-border-weak-base bg-surface-panel px-2 py-1 text-13-regular outline-none"
                  value={directTarget() ?? ""}
                  placeholder={facadeActive() ? language.t("im.facade.direct.placeholder") : "User id, or @agent-id"}
                  disabled={busy()}
                  onInput={(event) => setDirectTarget(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.isComposing || event.keyCode === 229 || busy()) return
                    if (event.key === "Enter") void submitDirect()
                    else if (event.key === "Escape") cancelDirect()
                  }}
                />
                <div class="flex gap-2">
                  <Button
                    size="small"
                    variant="primary"
                    disabled={busy() || !canCreate() || !directTarget()?.trim()}
                    onClick={() => void submitDirect()}
                  >
                    {language.t("im.direct.create")}
                  </Button>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={cancelDirect}>
                    {language.t("common.cancel")}
                  </Button>
                </div>
                <Show when={inlineFailure()}>
                  {(f) => (
                    <div class="text-12-regular text-text-critical px-1">{facadeFailureText(language.t, f())}</div>
                  )}
                </Show>
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
                    if (event.isComposing || event.keyCode === 229 || busy()) return
                    if (event.key === "Enter") void submitCreate()
                    else if (event.key === "Escape") cancelCreate()
                  }}
                />
                <div class="flex gap-2 mt-2">
                  <Button
                    size="small"
                    variant="primary"
                    disabled={busy() || !canCreate() || !creatingName()?.trim()}
                    onClick={() => void submitCreate()}
                  >
                    {language.t("im.group.create")}
                  </Button>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={cancelCreate}>
                    {language.t("common.cancel")}
                  </Button>
                </div>
              </div>
            </Show>
            <Show when={availability.groupsFailed}>
              <div class="m-3 flex flex-col gap-2" role="alert">
                <p class="text-12-regular text-text-critical">{language.t("im.group.load.failed")}</p>
                <Button size="small" variant="secondary" disabled={loading()} onClick={() => loadGroups()}>
                  {language.t("im.facade.retry")}
                </Button>
              </div>
            </Show>
            <Show
              when={!loading()}
              fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("im.loading")}</div>}
            >
              <Show
                when={groups().length > 0}
                fallback={
                  <Show when={!availability.groupsFailed}>
                    <div class="p-4 text-13-regular text-text-weak">{language.t("im.group.empty")}</div>
                  </Show>
                }
              >
                <div class="flex flex-col gap-0.5 p-2">
                  <For each={groups()}>
                    {(group) => (
                      <button
                        type="button"
                        onClick={() => setSelectedGroupID(group.id)}
                        class="w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-raised-base-hover"
                      >
                        <div class="flex items-center gap-1.5 min-w-0">
                          <div class="text-13-medium text-text-strong truncate">{group.name}</div>
                          <Show when={kernelBadge(group)}>
                            {(badge) => (
                              <span class="shrink-0 rounded-sm bg-surface-raised-base px-1 py-px text-10-medium text-text-weak">
                                {language.t(badge() === "orgAll" ? "im.facade.badge.orgAll" : "im.facade.badge.kernel")}
                              </span>
                            )}
                          </Show>
                        </div>
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
            {/* 邀请行内编辑（群视图）：按通讯录名字邀请进当前内核群。 */}
            <Show when={invitingGroupID() !== null}>
              <div class="p-2 border-b border-border-weaker-base flex flex-col gap-1">
                <InlineInput
                  ref={(el: HTMLInputElement) => queueMicrotask(() => el.isConnected && el.focus())}
                  class="w-full rounded-md border border-border-weak-base bg-surface-panel px-2 py-1 text-13-regular outline-none"
                  value={inviteName()}
                  placeholder={language.t("im.facade.invite.placeholder")}
                  disabled={busy()}
                  onInput={(event) => setInviteName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.isComposing || event.keyCode === 229 || busy()) return
                    if (event.key === "Enter") void submitInvite()
                    else if (event.key === "Escape") setInvitingGroupID(null)
                  }}
                />
                <div class="flex gap-2">
                  <Button
                    size="small"
                    variant="primary"
                    disabled={busy() || !facadeActive() || !inviteName().trim()}
                    onClick={() => void submitInvite()}
                  >
                    {language.t("im.facade.invite")}
                  </Button>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={() => setInvitingGroupID(null)}>
                    {language.t("common.cancel")}
                  </Button>
                </div>
                <Show when={inlineFailure()}>
                  {(f) => (
                    <div class="text-12-regular text-text-critical px-1">{facadeFailureText(language.t, f())}</div>
                  )}
                </Show>
              </div>
            </Show>
            <GroupChatPanel groupID={id()} threadsEnabled={threadsEnabled()} fileUploadEnabled={fileUploadEnabled()} />
          </div>
        )}
      </Show>
    </div>
  )
}
