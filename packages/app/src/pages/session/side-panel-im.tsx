import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Component,
} from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSDK } from "@/context/sdk"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { createComposerDrafts } from "@/components/im/composer-draft"
import { MessageSearch } from "@/components/im/message-search"
import { fetchIMCapabilities } from "@/components/im/capabilities"
import { IMFacadeRequestError, useIMClient, type IMClient, type IMFacadeStatus } from "@/utils/im-client"
import type { IMGroup } from "@/components/im/types"
import { submitCreateDirect, submitCreateGroup, submitFacadeName } from "@/pages/session/im-panel-helpers"
import { facadeFailureText, type FacadeFailureLike } from "@/components/im/facade-errors"
import { ActivationCard, BlockedCard, IdentityCard } from "@/components/im/facade-cards"
import { KernelGroupDialog } from "@/components/im/facade-dialogs"
import { Dialog } from "@deepagent-code/ui/dialog"
import { PersonalCommandFlow } from "@/components/im/personal-command-flow"
import { createDacDrafts, type DacDraft } from "@/components/im/personal-command"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { useLocation, useNavigate } from "@solidjs/router"
import { ServerConnection, useServer } from "@/context/server"

type ReturnBookmark = {
  from: ServerConnection.Key
  fromHTTP: ServerConnection.HttpBase
  directory: string
  workspace?: string
  path: string
  groupID: string
  drafts: { groupID: string; threadID?: string; value: ReturnType<ReturnType<typeof createComposerDrafts>>["state"] }[]
  personal: [string, DacDraft["state"]][]
  scroll: number
  to: ServerConnection.Key
  toHTTP: ServerConnection.HttpBase
  targetPath: string
  returning: boolean
}
// This single in-memory bookmark preserves UI text and position across SDK owners.
// It grants no access and never retains setters from the disposed A owner.
const [returnBookmark, setReturnBookmark] = createSignal<ReturnBookmark>()
const sameConnection = (left: ServerConnection.HttpBase, right: ServerConnection.HttpBase) =>
  left.url === right.url &&
  left.username === right.username &&
  left.password === right.password &&
  left.bearer === right.bearer

// IM as a right-side-panel tab. Mirrors the other side-panels (browser, subagents):
// owns a header + close button (calls onClose), fills the panel with `h-full`
// instead of the old full-screen `h-screen` route. Group creation uses an inline
// input — never window.prompt(), which throws in the Electron renderer.
//
// Only a missing status endpoint permits legacy mode; transient failures must not enable local-only creation.
// active ⇒ 顶部身份卡 + 群徽标（全员群/内核群）+ 私聊/建群/邀请走门面端点（按名字，不按裸 id）；
// claim_required and activation_required open explicit IM settings; other blocked states retain connection recovery.
export const SidePanelIM: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const command = useCommand()
  const client = useIMClient()
  const sdk = useSDK()
  const server = useServer()
  const location = useLocation()
  const navigate = useNavigate()
  const dialog = useDialog()
  const restore = returnBookmark()
  const restoring =
    restore &&
    ServerConnection.local(server.current) &&
    [restore.path, restore.targetPath].includes(location.pathname) &&
    server.key === restore.from &&
    sdk.directory === restore.directory &&
    client.scope().workspace === restore.workspace &&
    server.current &&
    sameConnection(server.current.http, restore.fromHTTP)
      ? restore
      : undefined
  const factory = createComposerDrafts()
  const observedDrafts = new Map<
    string,
    { groupID: string; threadID?: string; value: ReturnType<ReturnType<typeof createComposerDrafts>> }
  >()
  const drafts = (groupID: string, threadID?: string) => {
    const key = JSON.stringify([groupID, threadID ?? null])
    const existing = observedDrafts.get(key)
    if (existing) return existing.value
    const draft = factory(groupID, threadID)
    const original = restoring?.drafts.find((item) => item.groupID === groupID && item.threadID === threadID)
    if (original) draft.setState({ ...original.value })
    observedDrafts.set(key, { groupID, threadID, value: draft })
    return draft
  }
  let panel: HTMLDivElement | undefined
  const [taskMessage, setTaskMessage] = createSignal<LocalMessage>()
  const personalDrafts = createDacDrafts(restoring?.personal)
  const personalScope = client.scope()
  const [personalFlow, setPersonalFlow] = createStore({
    groupID: "",
    draft: undefined as DacDraft | undefined,
    autoSubmit: false,
    invocation: 0,
    error: "",
  })
  const beginPersonal = (text: string, message?: LocalMessage, delivery: "queue" | "steer" = "queue") => {
    const groupID = selectedGroupID()
    if (!groupID || refresh.disposed || !selectedGroup() || client.scope() !== personalScope) return false
    if (!ServerConnection.local(server.current)) {
      setPersonalFlow("error", "localOnly")
      return false
    }
    const draft = personalDrafts(groupID)
    if (!draft) {
      setPersonalFlow("error", "error.capacity")
      return false
    }
    if (!draft.state.pending)
      draft.setState({
        text: text || draft.state.text,
        delivery,
        reference: message ? { id: message.id, content: message.content } : text ? undefined : draft.state.reference,
      })
    setPersonalFlow({
      groupID,
      draft,
      autoSubmit: !!text.trim() && !draft.state.pending,
      invocation: personalFlow.invocation + 1,
      error: "",
    })
    return !text.trim() || !draft.state.pending
  }

  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [loading, setLoading] = createSignal(true)
  const [selectedGroupID, setSelectedGroupID] = createSignal<string | null>(null)
  const [selectedDetail, setSelectedDetail] = createSignal<IMGroup>()
  const [selectedReadyID, setSelectedReadyID] = createSignal<string>()
  const [paging, setPaging] = createStore({
    ordinary: { cursor: null as string | null, more: false, busy: false, failed: false, appended: false },
    protected: { cursor: null as string | null, more: false, busy: false, failed: false, appended: false },
  })
  const observations = {
    ordinary: { generation: 0 },
    protected: { generation: 0 },
    detail: { generation: 0, active: false },
    deadline: Infinity,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    detailTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
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
  const [availability, setAvailability] = createStore({
    statusFailed: false,
    groupsFailed: false,
    statusLoading: false,
    readerUnavailable: false,
    invalidation: 0,
  })
  const refresh = {
    generation: 0,
    active: false,
    pending: false,
    disposed: false,
    abort: new AbortController(),
    nextAt: 0,
    direct: true,
    trailing: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const clearTrailing = () => {
    if (refresh.trailing !== undefined) clearTimeout(refresh.trailing)
    refresh.trailing = undefined
  }
  const trail = () => {
    if (refresh.disposed || refresh.active || refresh.trailing !== undefined || document.visibilityState === "hidden")
      return
    const generation = refresh.generation
    const scope = client.scope()
    refresh.trailing = setTimeout(
      () => {
        refresh.trailing = undefined
        if (refresh.disposed || generation !== refresh.generation || scope !== client.scope() || !refresh.pending)
          return
        void loadGroups(true, false)
      },
      Math.ceil(Math.max(0, refresh.nextAt - performance.now())),
    )
  }
  const protectedGroup = (group: IMGroup) => !!group.reader || !!group.kernelConvID
  const clearProtected = (supersede = true) => {
    if (supersede) {
      clearTrailing()
      refresh.generation++
      refresh.abort.abort()
      refresh.abort = new AbortController()
      refresh.active = false
      refresh.pending = false
      observations.ordinary.generation++
      setPaging("ordinary", "busy", false)
    }
    observations.protected.generation++
    observations.detail.generation++
    observations.detail.active = false
    observations.deadline = Infinity
    if (observations.timer) clearTimeout(observations.timer)
    setPaging("protected", { cursor: null, more: false, busy: false, failed: false, appended: false })
    setGroups((rows) => rows.filter((row) => !protectedGroup(row)))
    if (selectedDetail() && protectedGroup(selectedDetail()!)) setSelectedDetail(undefined)
    setInvitingGroupID(null)
    setAvailability("readerUnavailable", true)
    setAvailability("invalidation", (value) => value + 1)
  }

  const disabledFacadeStatus: IMFacadeStatus = {
    facade: "disabled",
    identity: null,
    blocked: null,
    kernel: null,
    keyOrigin: "none",
  }
  const [facadeStatus, setFacadeStatus] = createSignal<IMFacadeStatus>()
  const facadeState = () => facadeStatus()?.facade
  const facadeActive = () => facadeState() === "active"
  const canCreate = () =>
    !availability.statusLoading && !availability.statusFailed && (facadeActive() || facadeState() === "disabled")
  const identity = () => facadeStatus()?.identity ?? null

  /** k:2:<orgAllGroupID> ⇒ 全员群；其余 k:2: ⇒ 内核群；k:1:/null 不挂徽标（direct/本地语义自明）。 */
  const kernelBadge = (group: IMGroup): "orgAll" | "kernel" | null => {
    const conv = group.kernelConvID
    if (group.reader && group.type !== "direct") return "kernel"
    if (!conv?.startsWith("k:2:")) return null
    const orgAll = identity()?.orgAllGroupID
    return orgAll && conv === `k:2:${orgAll}` ? "orgAll" : "kernel"
  }

  /** 群视图 header 的邀请入口只对内核群（k:2: 绑定）开放。 */
  const selectedGroup = () => (selectedDetail()?.id === selectedGroupID() ? selectedDetail() : undefined)
  command.register("im.personal", () => [
    {
      id: "im.dac",
      title: language.t("im.dac.title"),
      description: language.t("im.dac.activate"),
      slash: "dac",
      disabled:
        !selectedGroupID() ||
        !selectedGroup() ||
        client.scope() !== personalScope ||
        !ServerConnection.local(server.current),
      onSelect: () => beginPersonal(""),
    },
  ])
  const inviteable = () =>
    facadeActive() &&
    (selectedGroup()?.kernelConvID?.startsWith("k:2:") ||
      (!!selectedGroup()?.reader && selectedGroup()?.type !== "direct"))
  const senderNames = createMemo(() => {
    const group = selectedGroup()
    if (group?.type !== "direct" || !group.name.trim()) return undefined
    const peer = group.reader?.peerID ? ["", group.reader.peerID] : /^k:1:([^:]+)$/.exec(group.kernelConvID ?? "")
    if (!peer) return undefined
    // The facade resolves this peer name and ID together; inbound discovery
    // verifies the same direct conversation. Group names prove no sender name.
    return new Map([[peer[1], group.name]])
  })

  // §B3/§H3 capability gate — thread view + file upload only where the server's flags are ON.
  const [capabilities] = createResource(() =>
    fetchIMCapabilities(sdk.client as unknown as Parameters<typeof fetchIMCapabilities>[0]),
  )
  const threadsEnabled = () => capabilities()?.v4ThreadEnabled ?? false
  const fileUploadEnabled = () => capabilities()?.v4FileUploadEnabled ?? false

  const loadLane = async (lane: "ordinary" | "protected", append = false) => {
    if (refresh.disposed || paging[lane].busy || (append && !paging[lane].more)) return
    const generation = refresh.generation
    const laneGeneration = observations[lane].generation
    const scope = client.scope()
    const cursor = append ? (paging[lane].cursor ?? undefined) : undefined
    const current = () =>
      !refresh.disposed &&
      refresh.generation === generation &&
      observations[lane].generation === laneGeneration &&
      client.scope() === scope
    setPaging(lane, "busy", true)
    const started = performance.now()
    try {
      const page = await client.listGroupPage(
        lane,
        cursor,
        AbortSignal.any([refresh.abort.signal, AbortSignal.timeout(10_000)]),
      )
      if (!current()) return
      if (page.lane !== lane || page.hasMore !== (page.nextCursor !== null) || (cursor && page.nextCursor === cursor))
        throw new Error("Invalid conversation page")
      if (
        page.reader &&
        facadeStatus()?.reader?.displayEpoch &&
        page.reader.displayEpoch !== facadeStatus()?.reader?.displayEpoch
      )
        throw new Error("Conversation scope changed")
      if (lane === "protected" && page.reader?.nextExpiryAt !== null && page.reader?.nextExpiryAt !== undefined) {
        if (
          !Number.isSafeInteger(page.reader.nextExpiryAt) ||
          !Number.isSafeInteger(page.reader.validatedServerNow) ||
          page.reader.nextExpiryAt <= page.reader.validatedServerNow!
        )
          throw new Error("Unverified conversation expiry")
        const deadline = started + page.reader.nextExpiryAt - page.reader.validatedServerNow!
        observations.deadline = Math.min(observations.deadline, deadline)
        if (observations.timer) clearTimeout(observations.timer)
        observations.timer = setTimeout(() => clearProtected(), Math.max(0, observations.deadline - performance.now()))
      }
      setGroups((prior) => [...new Map([...prior, ...page.groups].map((row) => [row.id, row])).values()])
      if (
        lane === "protected" &&
        !selectedGroupID() &&
        facadeStatus()?.reader?.state === "ready" &&
        page.reader?.displayEpoch === facadeStatus()?.reader?.displayEpoch
      )
        setAvailability("readerUnavailable", false)
      if (append || !paging[lane].appended) setPaging(lane, { cursor: page.nextCursor, more: page.hasMore })
      setPaging(lane, { failed: false, ...(append ? { appended: true } : {}) })
    } catch {
      if (!current()) return
      if (lane === "protected") {
        setGroups((rows) => rows.filter((row) => !protectedGroup(row)))
      }
      setPaging(lane, "failed", true)
      setAvailability("groupsFailed", true)
    } finally {
      if (current()) setPaging(lane, "busy", false)
    }
  }
  const loadSelected = async () => {
    const id = selectedGroupID()
    if (!id || refresh.disposed || observations.detail.active) return
    const generation = observations.detail.generation
    const rootGeneration = refresh.generation
    const scope = client.scope()
    const current = () =>
      !refresh.disposed &&
      observations.detail.generation === generation &&
      refresh.generation === rootGeneration &&
      selectedGroupID() === id &&
      client.scope() === scope
    observations.detail.active = true
    const started = performance.now()
    try {
      const detail = await client.getGroup(id, AbortSignal.any([refresh.abort.signal, AbortSignal.timeout(10_000)]))
      if (!current()) return
      if (
        detail.group.id !== id ||
        (detail.reader &&
          facadeStatus()?.reader?.displayEpoch &&
          detail.reader.displayEpoch !== facadeStatus()?.reader?.displayEpoch)
      )
        throw new Error("Conversation scope changed")
      if (observations.detailTimer) clearTimeout(observations.detailTimer)
      if (detail.reader?.nextExpiryAt !== null && detail.reader?.nextExpiryAt !== undefined) {
        if (
          !Number.isSafeInteger(detail.reader.nextExpiryAt) ||
          !Number.isSafeInteger(detail.reader.validatedServerNow) ||
          detail.reader.nextExpiryAt <= detail.reader.validatedServerNow!
        )
          throw new Error("Unverified conversation expiry")
        observations.detailTimer = setTimeout(
          () => {
            if (!current()) return
            setSelectedDetail(undefined)
            setAvailability("readerUnavailable", true)
          },
          Math.max(0, started + detail.reader.nextExpiryAt - detail.reader.validatedServerNow! - performance.now()),
        )
      }
      setSelectedDetail(detail.group)
      setGroups((rows) => rows.map((group) => (group.id === id ? detail.group : group)))
      setSelectedReadyID(id)
      setAvailability("readerUnavailable", false)
    } catch {
      if (current()) {
        setSelectedDetail(undefined)
        setAvailability("readerUnavailable", true)
      }
    } finally {
      if (current()) observations.detail.active = false
    }
  }
  const loadGroups = async (background = false, allowSuccessor = true) => {
    if (refresh.disposed) return
    if (background && document.visibilityState === "hidden") {
      clearTrailing()
      refresh.pending = true
      return
    }
    if (refresh.active) {
      refresh.pending = true
      return
    }
    if (background && (refresh.trailing !== undefined || (performance.now() < refresh.nextAt && !refresh.direct))) {
      refresh.pending = true
      trail()
      return
    }
    if (!background) clearTrailing()
    // One immediate successor is allowed; the rest of a burst keeps one timed dirty refresh.
    refresh.direct = allowSuccessor && performance.now() >= refresh.nextAt
    refresh.nextAt = performance.now() + 1000
    refresh.active = true
    refresh.pending = false
    if (!background) for (const lane of ["ordinary", "protected"] as const) setPaging(lane, "appended", false)
    const generation = refresh.generation
    const scope = client.scope()
    const current = () => !refresh.disposed && refresh.generation === generation && client.scope() === scope
    if (!background) setLoading(true)
    setAvailability("statusLoading", true)
    const signal = AbortSignal.any([refresh.abort.signal, AbortSignal.timeout(10_000)])
    const status = client
      .facadeStatus(signal)
      .catch((error: unknown) => {
        if (error instanceof IMFacadeRequestError && error.status === 404) return disabledFacadeStatus
        throw error
      })
      .then((snapshot) => {
        if (!current()) return
        if (
          facadeStatus()?.reader?.displayEpoch &&
          facadeStatus()?.reader?.displayEpoch !== snapshot.reader?.displayEpoch
        )
          clearProtected(false)
        const unavailable =
          snapshot.reader?.state === "unavailable" || (!!snapshot.reader && snapshot.kernel !== "connected")
        if (unavailable) clearProtected(false)
        setFacadeStatus(snapshot)
        setAvailability("statusFailed", false)
        return snapshot
      })
      .catch(() => {
        if (current()) {
          clearProtected(false)
          setFacadeStatus(undefined)
          setAvailability("statusFailed", true)
        }
      })
    try {
      await Promise.all([
        status,
        loadLane("ordinary"),
        status.then((snapshot) => {
          if (!current()) return
          // An explicitly disabled facade has no protected reader to query.
          if (snapshot?.facade === "disabled" && snapshot.reader === null) {
            clearProtected(false)
            setAvailability("readerUnavailable", false)
            return
          }
          return loadLane("protected")
        }),
        loadSelected(),
      ])
      if (current()) setAvailability("groupsFailed", paging.ordinary.failed || paging.protected.failed)
    } finally {
      if (current()) {
        refresh.active = false
        setLoading(false)
        setAvailability("statusLoading", false)
        if (!refresh.pending) return
        if (availability.statusFailed || availability.groupsFailed) {
          refresh.pending = false
          clearTrailing()
          return
        }
        if (allowSuccessor && refresh.direct) void loadGroups(true, false)
        else trail()
      }
    }
  }
  createEffect(() => {
    selectedGroupID()
    setTaskMessage(undefined)
    setSelectedReadyID(undefined)
    observations.detail.generation++
    observations.detail.active = false
    if (observations.detailTimer) clearTimeout(observations.detailTimer)
    setSelectedDetail(undefined)
    untrack(() => {
      if (selectedGroupID()) void loadSelected()
    })
  })
  const scopeReset = { initial: true }
  createEffect(() => {
    client.scope()
    const initialRestore = scopeReset.initial ? restoring : undefined
    scopeReset.initial = false
    if (!initialRestore) setPersonalFlow({ groupID: "", draft: undefined, autoSubmit: false, error: "" })
    setTaskMessage(undefined)
    refresh.generation++
    clearTrailing()
    refresh.abort.abort()
    refresh.abort = new AbortController()
    refresh.active = false
    refresh.pending = false
    setGroups([])
    for (const lane of ["ordinary", "protected"] as const) {
      observations[lane].generation++
      setPaging(lane, { cursor: null, more: false, busy: false, failed: false, appended: false })
    }
    observations.deadline = Infinity
    if (observations.timer) clearTimeout(observations.timer)
    setBusy(false)
    setFacadeStatus(undefined)
    setSelectedGroupID(initialRestore?.groupID ?? null)
    setSearching(false)
    void untrack(() => loadGroups())
  })
  const refreshTimer = setInterval(() => {
    if (document.visibilityState !== "hidden") void loadGroups(true)
  }, 30_000)
  const page = { hidden: document.visibilityState === "hidden" }
  const visible = () => {
    if (document.visibilityState === "hidden") {
      page.hidden = true
      clearTrailing()
      return
    }
    if (page.hidden) {
      refresh.nextAt = 0
      refresh.direct = true
    }
    page.hidden = false
    void loadGroups(true)
  }
  document.addEventListener("visibilitychange", visible)
  onCleanup(() => {
    refresh.disposed = true
    refresh.abort.abort()
    clearTrailing()
    clearInterval(refreshTimer)
    document.removeEventListener("visibilitychange", visible)
    if (observations.timer) clearTimeout(observations.timer)
    if (observations.detailTimer) clearTimeout(observations.detailTimer)
  })

  const openActivation = async () => {
    const scope = client.scope()
    const { DialogSettings } = await import("@/components/settings-v2/dialog-settings-v2")
    if (refresh.disposed || client.scope() !== scope) return
    dialog.show(() => <DialogSettings initialTab="im" />)
  }

  /** Refresh the identity card and groups after a connection or identity change. */
  const refreshFacade = () => {
    void loadGroups()
  }

  const toastError = async (title: string, description: string) => {
    const { showToast } = await import("@/utils/toast")
    showToast({ variant: "error", title, description })
  }

  const startCreate = () => {
    if (!canCreate()) return
    setInlineFailure(null)
    if (facadeActive()) {
      const generation = refresh.generation
      const scope = client.scope()
      // 门面模式：建群即建内核群（群名 + 成员名 chips 对话框）。
      dialog.show(() => (
        <KernelGroupDialog
          onCreated={(group) => {
            if (refresh.disposed || generation !== refresh.generation || client.scope() !== scope) return
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
    const generation = refresh.generation
    const scope = client.scope()
    const result = await submitCreateGroup(creatingName() ?? "", (payload) => client.createGroup(payload))
    if (refresh.disposed || generation !== refresh.generation || client.scope() !== scope) return
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
    const generation = refresh.generation
    const scope = client.scope()
    const current = () => !refresh.disposed && generation === refresh.generation && client.scope() === scope
    if (facadeActive()) {
      // 门面模式：按通讯录名字发起私聊（resolve + 本地 direct 群幂等复用 + k:1: 绑定，服务端一次完成）。
      const result = await submitFacadeName(target, (name) => client.facadeOpenDirect(name))
      if (!current()) return
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
    if (!current()) return
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
    const generation = refresh.generation
    const scope = client.scope()
    const result = await submitFacadeName(inviteName(), (name) => client.facadeInvite(groupID, name))
    if (refresh.disposed || generation !== refresh.generation || client.scope() !== scope) return
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
  createEffect(() => {
    if (!restoring?.returning || selectedReadyID() !== restoring.groupID) return
    const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
    const apply = (attempt: number) => {
      if (refresh.disposed || client.scope().directory !== restoring.directory) return
      const log = panel?.querySelector<HTMLElement>('[role="log"]')
      if (log) {
        log.scrollTop = restoring.scroll
        setReturnBookmark(undefined)
        return
      }
      if (attempt < 20) timer.value = setTimeout(() => apply(attempt + 1), 20)
    }
    queueMicrotask(() => apply(0))
    onCleanup(() => {
      if (timer.value) clearTimeout(timer.value)
    })
  })
  const canReturn = () => {
    const saved = returnBookmark()
    if (
      !saved ||
      saved.returning ||
      !ServerConnection.local(server.current) ||
      server.key !== saved.to ||
      !server.current ||
      !sameConnection(server.current.http, saved.toHTTP) ||
      location.pathname !== saved.targetPath
    )
      return
    const original = server.list.find((connection) => ServerConnection.key(connection) === saved.from)
    if (
      !original ||
      !sameConnection(original.http, saved.fromHTTP) ||
      !server.projects
        .forServer(saved.from)
        .list()
        .some((project) => project.worktree === saved.directory)
    )
      return
    return saved
  }

  return (
    <div ref={panel} class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-base">
      <Show when={canReturn()}>
        {(saved) => (
          <Button
            variant="secondary"
            onClick={() => {
              const original = canReturn()
              if (!original) return
              setReturnBookmark({ ...original, returning: true })
              server.setActive(original.from)
              navigate(original.path)
            }}
          >
            {language.t("im.taskResult.return")}
          </Button>
        )}
      </Show>
      <Show
        when={
          returnBookmark() &&
          !returnBookmark()?.returning &&
          server.key === returnBookmark()?.to &&
          location.pathname === returnBookmark()?.targetPath &&
          !canReturn()
        }
      >
        <p role="alert">{language.t("im.taskResult.scopeChanged")}</p>
      </Show>
      <Show when={taskMessage()} keyed>
        {(message) => (
          <TaskHistoryFlow
            message={message}
            client={client}
            active={() => !refresh.disposed && selectedGroupID() === message.groupID}
            onClose={() => setTaskMessage(undefined)}
          />
        )}
      </Show>
      <Show when={personalFlow.draft && { draft: personalFlow.draft, invocation: personalFlow.invocation }} keyed>
        {(entry) => (
          <PersonalCommandFlow
            client={client}
            groupID={personalFlow.groupID}
            draft={entry.draft}
            autoSubmit={personalFlow.autoSubmit}
            bookmark={(targetPath) => {
              const original = server.current
              if (!ServerConnection.local(original) || !original || !server.key) return
              setReturnBookmark({
                from: server.key,
                fromHTTP: { ...original.http },
                directory: sdk.directory,
                workspace: client.scope().workspace,
                path: location.pathname,
                groupID: personalFlow.groupID,
                drafts: [...observedDrafts.values()].map((value) => ({
                  groupID: value.groupID,
                  threadID: value.threadID,
                  value: structuredClone(unwrap(value.value.state)),
                })),
                personal: personalDrafts
                  .entries()
                  .map<[string, DacDraft["state"]]>(([id, value]) => [id, structuredClone(unwrap(value.state))]),
                scroll: panel?.querySelector('[role="log"]')?.scrollTop ?? 0,
                to: server.key,
                toHTTP: { ...original.http },
                targetPath,
                returning: false,
              })
            }}
            active={() =>
              !refresh.disposed &&
              client.scope() === personalScope &&
              selectedGroupID() === personalFlow.groupID &&
              ServerConnection.local(server.current)
            }
            onClose={() => setPersonalFlow({ groupID: "", draft: undefined, autoSubmit: false })}
          />
        )}
      </Show>
      <Show when={personalFlow.error}>
        <p role="alert" class="px-3 py-2 text-12-regular text-text-critical">
          {language.t(personalFlow.error === "localOnly" ? "im.dac.localOnly" : "im.dac.error.capacity")}
        </p>
      </Show>
      <Show when={selectedGroupID() ? personalDrafts.find(selectedGroupID()!)?.state.command : undefined}>
        {(value) => (
          <div class="px-3 py-2 text-12-regular border-b border-border-weaker-base flex gap-2 items-center">
            <span>
              {language.t(
                value().replyStatus === "delivered"
                  ? "im.dac.reply.delivered"
                  : value().replyStatus === "dead"
                    ? "im.dac.reply.dead"
                    : `im.dac.state.${value().state}`,
              )}
            </span>
            <Button size="small" variant="secondary" onClick={() => beginPersonal("")}>
              {language.t("im.dac.open")}
            </Button>
          </div>
        )}
      </Show>
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
          <h2 class="text-13-medium text-text-strong truncate" title={selectedGroup()?.name}>
            {selectedGroup()?.name ?? language.t("session.tab.im")}
          </h2>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <Show when={!selectedGroupID()}>
            <IconButton
              icon="history"
              variant="ghost"
              class="h-7 w-7 rounded-md"
              disabled={loading() || availability.statusLoading}
              onClick={() => void loadGroups()}
              aria-label={language.t("im.transport.refresh")}
              title={language.t("im.transport.refresh")}
            />
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
        keyed
        fallback={
          <div class="flex-1 min-h-0 flex flex-col overflow-y-auto">
            <Show when={availability.readerUnavailable}>
              <p role="status" class="px-3 py-2 text-12-regular text-text-weak">
                {language.t("im.reader.unavailable")}
              </p>
            </Show>
            <Show when={availability.statusFailed}>
              <div class="m-3 flex flex-col gap-2 rounded-md border border-border-weaker-base p-3" role="alert">
                <p class="text-12-regular text-text-critical">{language.t("im.facade.status.failed")}</p>
                <Button size="small" variant="secondary" disabled={availability.statusLoading} onClick={refreshFacade}>
                  {language.t("im.facade.retry")}
                </Button>
              </div>
            </Show>
            <Show when={facadeState() === "claim_required"}>
              <ActivationCard onActivate={() => void openActivation()} />
            </Show>
            <Show when={facadeState() === "blocked" && facadeStatus()?.blocked}>
              {(blocked) => (
                <BlockedCard blocked={blocked()} onRecovered={refreshFacade} onActivate={() => void openActivation()} />
              )}
            </Show>
            <Show when={facadeActive() && facadeStatus()}>
              {(status) => <IdentityCard status={status()} onChanged={refreshFacade} />}
            </Show>
            {/* §B3 search — opens a message search over the caller's group memberships. Selecting a
                result jumps to its group. */}
            <Show when={searching()}>
              <div class="border-b border-border-weaker-base">
                <MessageSearch
                  localGroupIDs={groups()
                    .filter((group) => !protectedGroup(group))
                    .map((group) => group.id)}
                  displayEpoch={facadeStatus()?.reader?.displayEpoch}
                  invalidation={availability.invalidation}
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
              <p class="px-3 text-11-regular text-text-weak">{language.t("im.reader.listObserved")}</p>
              <For each={["ordinary", "protected"] as const}>
                {(lane) => (
                  <Show when={paging[lane].more}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={paging[lane].busy}
                      onClick={() => void loadLane(lane, true)}
                    >
                      {language.t(lane === "ordinary" ? "im.reader.moreOrdinary" : "im.reader.moreProtected")}
                    </Button>
                  </Show>
                )}
              </For>
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
                        <div class="text-11-regular text-text-weak truncate">
                          {group.type}
                          <Show when={group.reader}>
                            {" "}
                            ·{" "}
                            {group.reader?.state === "pending"
                              ? language.t("im.reader.pending")
                              : `${language.t("im.reader.unread")}: ${group.reader?.liveUnread ?? "—"}`}
                          </Show>
                        </div>
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
            <Show
              when={selectedReadyID() === id}
              fallback={
                <div class="p-3 text-12-regular text-text-weak">
                  {language.t(availability.readerUnavailable ? "im.reader.unavailable" : "im.loading")}
                </div>
              }
            >
              <GroupChatPanel
                onMetadataRefreshed={loadSelected}
                onUseDac={
                  ServerConnection.local(server.current)
                    ? (message) => {
                        if (message.groupID !== selectedGroupID() || message.senderType !== "user") return
                        setTaskMessage(undefined)
                        beginPersonal("", message)
                      }
                    : undefined
                }
                onDac={
                  ServerConnection.local(server.current)
                    ? (text, delivery) => beginPersonal(text, undefined, delivery)
                    : undefined
                }
                onOpenConversationSession={ServerConnection.local(server.current) ? () => beginPersonal("") : undefined}
                headerOwned
                onOpenTaskResult={(message) => {
                  if (!refresh.disposed && message.groupID === selectedGroupID()) {
                    setTaskMessage(message)
                  }
                }}
                drafts={drafts}
                groupID={id}
                protected={
                  !selectedGroup() ||
                  !!selectedGroup()?.kernelConvID ||
                  !!selectedGroup()?.reader ||
                  id.startsWith("img_kr_")
                }
                reader={selectedGroup()?.reader}
                displayEpoch={facadeStatus()?.reader?.displayEpoch}
                readerUnavailable={availability.readerUnavailable}
                onReaderInvalidated={(reason) => {
                  // A failed history query clears its body in GroupConversation.
                  // Only source loss withdraws the separately verified sender.
                  if (reason === "source") clearProtected()
                  void loadGroups(true)
                }}
                name={selectedGroup()?.name}
                selfMemberIDs={[
                  facadeStatus()?.viewer?.memberID ?? "server",
                  ...(identity() ? [identity()!.uuid] : []),
                ]}
                senderNames={senderNames()}
                threadsEnabled={threadsEnabled()}
                fileUploadEnabled={fileUploadEnabled() && !!selectedGroup()}
              />
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

function TaskHistoryFlow(props: {
  message: LocalMessage
  client: IMClient
  active: () => boolean
  onClose: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const scope = props.client.scope()
  const requests = new AbortController()
  const owner = { active: true }
  const [state, setState] = createStore({ loading: true, value: "" })
  const current = () => owner.active && props.active() && scope === props.client.scope()
  onCleanup(() => {
    owner.active = false
    requests.abort()
  })
  onMount(() => {
    dialog.show(
      () => (
        <Dialog title={language.t("im.taskResult.title")}>
          <div class="flex flex-col gap-3 px-4 pb-4">
            <p>{language.t("im.dac.historyOnly")}</p>
            <Show when={state.loading}>
              <p role="status">{language.t("im.taskResult.loading")}</p>
            </Show>
            <p class="text-12-regular whitespace-pre-wrap break-words">{props.message.content}</p>
            <Show when={state.value}>
              <p role="status">{state.value}</p>
            </Show>
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.close")}
            </Button>
          </div>
        </Dialog>
      ),
      props.onClose,
    )
    const signal = AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)])
    const read =
      props.message.metadata?.type === "task_status_notice"
        ? props.client.getTaskStatus(props.message.id, signal).then((value) => value.state)
        : props.client.getTaskResult(props.message.id, signal).then((value) => value.state)
    void read
      .then((value) => {
        if (current()) setState({ loading: false, value })
      })
      .catch(() => {
        if (current()) setState({ loading: false, value: language.t("im.dac.error.unavailable") })
      })
  })
  return null
}
