import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  on,
  Show,
  untrack,
  type Component,
} from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { DropdownMenu } from "@deepagent-code/ui/dropdown-menu"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSDK } from "@/context/sdk"
import { IMContactsPage } from "@/components/im/contacts-page"
import { IMUserSettingsPage } from "@/components/im/user-settings-page"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { createComposerDrafts } from "@/components/im/composer-draft"
import { MessageSearch } from "@/components/im/message-search"
import { fetchIMCapabilities } from "@/components/im/capabilities"
import { IMFacadeRequestError, useIMClient, type IMClient, type IMFacadeStatus } from "@/utils/im-client"
import type { IMGroup } from "@/components/im/types"
import { submitCreateDirect, submitCreateGroup, submitFacadeName } from "@/pages/session/im-panel-helpers"
import { facadeFailureText, type FacadeFailureLike } from "@/components/im/facade-errors"
import { ActivationCard, BlockedCard } from "@/components/im/facade-cards"
import { KernelGroupDialog } from "@/components/im/facade-dialogs"
import { PersonalCommandFlow } from "@/components/im/personal-command-flow"
import { imCommunicationState, publishIMNavigation, retireIMNavigation } from "@/components/im/navigation-state"
import { imSummaryOwner } from "@/components/im/summary-owner"
import { createDacDrafts, type DacDraft } from "@/components/im/personal-command"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { useLocation, useNavigate } from "@solidjs/router"
import { ServerConnection, useServer } from "@/context/server"
import "./im-sidebar.css"

type ReturnBookmark = {
  from: ServerConnection.Key
  fromHTTP: ServerConnection.HttpBase
  directory: string
  workspace?: string
  path: string
  groupID: string
  accountID: string | undefined
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

// IM owns the three-page content and contextual actions; the enclosing side-panel
// owns its close button. Group creation remains inline because window.prompt()
// throws in the Electron renderer.
//
// Only a missing status endpoint permits legacy mode; transient failures must not enable local-only creation.
// active ⇒ 群徽标（全员群/内核群）+ 私聊/建群/邀请走门面端点（按名字，不按裸 id）；
// claim_required and activation_required open explicit IM settings; other blocked states retain connection recovery.
export const SidePanelIM: Component<{
  onClose: () => void
  chromeOwned?: boolean
  onManageIM?: () => void
}> = (props) => {
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
  const fallbackDrafts = createComposerDrafts()
  const fallbackPersonal = createDacDrafts()
  const navigationOwner = {}
  function communication() {
    const status = facadeStatus()
    const identity = status?.identity?.uuid ?? (status?.facade === "disabled" ? "local" : undefined)
    const accountID = identity && status?.service ? JSON.stringify([status.service.url, identity]) : identity
    const connection = server.current?.http
    return accountID && connection ? imCommunicationState(server.scope(), connection, accountID) : undefined
  }
  const factory = (groupID: string, threadID?: string) => (communication()?.drafts ?? fallbackDrafts)(groupID, threadID)
  const personalForPlacement = () => {
    const state = communication()
    if (!state) return fallbackPersonal
    const placement = JSON.stringify([sdk.directory, client.scope().workspace ?? null])
    const existing = state.personal.get(placement)
    if (existing) return existing
    const drafts = createDacDrafts(restoring?.accountID === state.accountID ? restoring.personal : undefined)
    state.personal.set(placement, drafts)
    return drafts
  }
  const observedDrafts = new Map<
    string,
    { groupID: string; threadID?: string; value: ReturnType<ReturnType<typeof createComposerDrafts>> }
  >()
  let observedOwner: ReturnType<typeof communication>
  const drafts = (groupID: string, threadID?: string) => {
    const owner = communication()
    if (observedOwner !== owner) {
      observedDrafts.clear()
      observedOwner = owner
    }
    const key = JSON.stringify([groupID, threadID ?? null])
    const existing = observedDrafts.get(key)
    if (existing) return existing.value
    const draft = factory(groupID, threadID)
    const original =
      owner && restoring?.accountID === owner.accountID
        ? restoring.drafts.find((item) => item.groupID === groupID && item.threadID === threadID)
        : undefined
    if (original) draft.setState({ ...original.value })
    observedDrafts.set(key, { groupID, threadID, value: draft })
    return draft
  }
  let panel: HTMLDivElement | undefined
  const personalDrafts = Object.assign((groupID: string) => personalForPlacement()(groupID), {
    find: (groupID: string) => personalForPlacement().find(groupID),
    entries: () => personalForPlacement().entries(),
  })
  // Store proxies must not change the raw scope identity captured by each invocation.
  const personalScope = { current: undefined as ReturnType<IMClient["scope"]> | undefined }
  const [personalFlow, setPersonalFlow] = createStore({
    groupID: "",
    draft: undefined as DacDraft | undefined,
    autoSubmit: false,
    invocation: 0,
    error: "",
  })
  const beginPersonal = (text: string, message?: LocalMessage, delivery: "queue" | "steer" = "queue") => {
    const groupID = selectedGroupID()
    if (!groupID || refresh.disposed || !selectedGroup()) return false
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
    personalScope.current = client.scope()
    setPersonalFlow({
      groupID,
      draft,
      autoSubmit: !!text.trim() && !draft.state.pending,
      invocation: personalFlow.invocation + 1,
      error: "",
    })
    return !text.trim() || !draft.state.pending
  }

  const [workspace, setWorkspace] = createStore({
    page: "messages" as "messages" | "contacts" | "settings",
    visited: { contacts: false, settings: false },
    filter: "",
    searchRequest: 0,
    searchGroup: undefined as string | undefined,
    refreshRequest: 0,
    lookupRequest: 0,
    renameRequest: 0,
    copyResult: "" as "" | "copied" | "copyFailed",
  })
  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const visibleGroups = createMemo(() =>
    groups().filter((group) => group.name.toLocaleLowerCase().includes(workspace.filter.trim().toLocaleLowerCase())),
  )
  const [loading, setLoading] = createSignal(true)
  const [messageLocation, setMessageLocation] = createSignal<{
    groupID: string
    messageID: string
    scope: ReturnType<IMClient["scope"]>
    epoch?: string
  }>()
  const [selectedGroupID, setSelectedGroup] = createSignal<string | null>(null)
  const scrollPositions = new Map<string, number>()
  const setSelectedGroupID = (groupID: string | null, remember = true) => {
    const previous = untrack(selectedGroupID)
    const log = panel?.querySelector<HTMLElement>('[role="log"]')
    if (remember && previous && log) scrollPositions.set(previous, log.scrollTop)
    setMessageLocation(undefined)
    return setSelectedGroup(groupID)
  }
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
    statusBackground: false,
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
  const selectedMessageLocation = createMemo(() => {
    const location = messageLocation()
    if (
      location?.groupID !== selectedGroupID() ||
      location?.scope !== client.scope() ||
      location?.epoch !== facadeStatus()?.reader?.displayEpoch
    )
      return undefined
    return location
  })
  const communicationOwner = createMemo(communication)
  let personalOwner: ReturnType<typeof communication>
  createEffect(
    on(communicationOwner, (value) => {
      if (observedOwner !== value) {
        observedDrafts.clear()
        observedOwner = value
      }
      if (personalOwner !== value) {
        scrollPositions.clear()
        setWorkspace({ filter: "", searchGroup: undefined, copyResult: "" })
        setSearching(false)
        setPersonalFlow({ groupID: "", draft: undefined, autoSubmit: false, error: "" })
        personalOwner = value
      }
      if (value)
        setSelectedGroupID(
          value.selected ?? (restoring?.accountID === value.accountID ? restoring.groupID : null),
          false,
        )
    }),
  )
  createEffect(
    on(selectedGroupID, (selected) => {
      // Account hydration restores its own selection before user selection changes persist.
      const value = communication()
      if (value) value.selected = selected
    }),
  )
  createEffect(() => {
    const value = communication()
    const connection = server.current?.http
    const status = facadeStatus()
    if (!value || !connection || !status) return
    const unread = groups().some((group) => {
      const count = group.reader?.liveUnread
      return typeof count === "number" ? count > 0 : typeof count === "string" && /^[1-9][0-9]*$/.test(count)
    })
    publishIMNavigation({
      scope: server.scope(),
      connection: { ...connection },
      accountID: value.accountID,
      owner: navigationOwner,
      connected: status.kernel === "connected",
      unread,
      current:
        !availability.readerUnavailable &&
        !availability.statusFailed &&
        !availability.groupsFailed &&
        (unread || (!paging.ordinary.more && !paging.protected.more)),
    })
  })
  onCleanup(() => retireIMNavigation(navigationOwner))
  const facadeState = () => facadeStatus()?.facade
  const facadeActive = () => facadeState() === "active"
  createEffect(
    on([selectedGroupID, () => facadeActive()], ([groupID, active]) => {
      if (!groupID || !active) return
      const scope = client.scope()
      const lifetime = new AbortController()
      void client.dacBinding(groupID, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])).then(
        (binding) => {
          if (
            lifetime.signal.aborted ||
            client.scope() !== scope ||
            selectedGroupID() !== groupID ||
            binding.directory !== sdk.directory ||
            binding.workspaceID !== (scope.workspace ?? null)
          )
            return
          const draft = personalDrafts(groupID)
          if (!draft || draft.state.pending) return
          const command = binding.recentCommands?.[0]
          if (command && (!draft.state.command || draft.state.command.commandID === command.commandID))
            draft.setState("command", command)
        },
        () => {},
      )
      onCleanup(() => lifetime.abort())
    }),
  )
  // Opening an editor grants nothing; submission still waits for the current status request.
  const canOpen = () =>
    !availability.statusFailed &&
    (!availability.statusLoading || availability.statusBackground) &&
    (facadeActive() || facadeState() === "disabled")
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
      disabled: !selectedGroupID() || !selectedGroup() || refresh.disposed || !ServerConnection.local(server.current),
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
    setAvailability({ statusLoading: true, statusBackground: background })
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
        setAvailability({ statusLoading: false, statusBackground: false })
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
  const currentScope = createMemo(() => client.scope())
  createEffect(() => {
    currentScope()
    const initialRestore = scopeReset.initial ? restoring : undefined
    scopeReset.initial = false
    personalScope.current = undefined
    if (!initialRestore) setPersonalFlow({ groupID: "", draft: undefined, autoSubmit: false, error: "" })
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
    setSelectedGroupID(null)
    setSearching(false)
    void untrack(() => loadGroups())
  })
  createEffect(
    on(currentScope, () => {
      const connection = server.current?.http
      if (!connection) return
      const detach = imSummaryOwner.attach({
        scope: server.scope(),
        connection: { ...connection },
        client,
        reader: { owner: navigationOwner, refresh: () => loadGroups(true) },
      })
      onCleanup(detach)
    }),
  )
  onCleanup(() => {
    refresh.disposed = true
    refresh.abort.abort()
    clearTrailing()
    if (observations.timer) clearTimeout(observations.timer)
    if (observations.detailTimer) clearTimeout(observations.detailTimer)
  })

  /** Refresh the identity card and groups after a connection or identity change. */
  const refreshFacade = () => {
    void loadGroups()
  }

  const toastError = async (title: string, description: string) => {
    const { showToast } = await import("@/utils/toast")
    showToast({ variant: "error", title, description })
  }

  const startCreate = () => {
    if (!canOpen()) return
    setWorkspace("page", "messages")
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
    if (!canOpen()) return
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

  const openContactDirect = async (name: string) => {
    if (busy() || !canCreate() || !facadeActive()) return false
    const generation = refresh.generation
    const scope = client.scope()
    const account = identity()?.uuid
    setBusy(true)
    try {
      const group = await client.facadeOpenDirect(name)
      if (
        refresh.disposed ||
        generation !== refresh.generation ||
        client.scope() !== scope ||
        identity()?.uuid !== account
      )
        return false
      setGroups((rows) => (rows.some((row) => row.id === group.id) ? rows : [...rows, group]))
      setSelectedGroupID(group.id)
      setWorkspace("page", "messages")
      return true
    } finally {
      if (!refresh.disposed && generation === refresh.generation && client.scope() === scope) setBusy(false)
    }
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
    const scoped = workspace.searchGroup !== undefined
    setSelectedGroupID(null)
    setInvitingGroupID(null)
    setInlineFailure(null)
    setWorkspace("searchGroup", undefined)
    setSearching(!scoped && !!workspace.filter.trim() && workspace.searchRequest > 0)
  }
  createEffect(
    on([selectedReadyID, communicationOwner, selectedMessageLocation], ([id, owner, location]) => {
      if (!id || location || !scrollPositions.has(id)) return
      const scope = client.scope()
      const observer = new MutationObserver(() => apply())
      const apply = () => {
        if (refresh.disposed || communication() !== owner || client.scope() !== scope || selectedGroupID() !== id)
          return
        const log = panel?.querySelector<HTMLElement>('[role="log"]')
        if (!log) return
        log.scrollTop = scrollPositions.get(id) ?? 0
        observer.disconnect()
      }
      if (panel) observer.observe(panel, { childList: true, subtree: true })
      queueMicrotask(apply)
      onCleanup(() => observer.disconnect())
    }),
  )
  const manageIM = async () => {
    if (props.onManageIM) return props.onManageIM()
    const scope = client.scope()
    const { DialogSettings } = await import("@/components/settings-v2/dialog-settings-v2")
    if (refresh.disposed || client.scope() !== scope) return
    dialog.show(() => <DialogSettings initialTab="im" />)
  }
  const copyIdentity = async () => {
    const self = identity()
    const scope = client.scope()
    if (!self || !facadeActive() || availability.statusFailed || facadeStatus()?.service?.reconnectRequired) return
    const copied = await navigator.clipboard?.writeText(self.uuid).then(
      () => true,
      () => false,
    )
    if (refresh.disposed || client.scope() !== scope || identity()?.uuid !== self.uuid) return
    setWorkspace("copyResult", copied ? "copied" : "copyFailed")
  }
  let searchInput: HTMLInputElement | undefined
  const searchRecords = () => {
    if (!workspace.filter.trim() || availability.statusFailed) return
    batch(() => {
      setSearching(true)
      setWorkspace("searchRequest", (value) => value + 1)
    })
  }
  const showSearch = () => {
    setWorkspace("searchGroup", selectedGroupID() ?? undefined)
    setSearching(true)
    queueMicrotask(() => searchInput?.isConnected && searchInput.focus())
  }
  const shortFlow = () => directTarget() !== null || creatingName() !== null
  const rootPage = () => workspace.page !== "messages" || (!selectedGroupID() && !shortFlow())
  createEffect(() => {
    if (
      !restoring?.returning ||
      communication()?.accountID !== restoring.accountID ||
      selectedReadyID() !== restoring.groupID
    )
      return
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
    <div ref={panel} class="im-sidebar h-full w-full min-w-0 flex flex-col overflow-hidden" data-slot="im-workspace">
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
            {language.t("im.dac.returnToChat")}
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
        <p role="alert">{language.t("im.dac.scopeChanged")}</p>
      </Show>
      <Show
        when={
          personalFlow.draft &&
          personalScope.current && {
            draft: personalFlow.draft,
            invocation: personalFlow.invocation,
            scope: personalScope.current,
          }
        }
        keyed
      >
        {(entry) => (
          <PersonalCommandFlow
            client={client}
            groupID={personalFlow.groupID}
            draft={entry.draft}
            autoSubmit={personalFlow.autoSubmit}
            showReturn={false}
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
                accountID: communication()?.accountID,
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
              client.scope() === entry.scope &&
              selectedGroupID() === personalFlow.groupID &&
              ServerConnection.local(server.current)
            }
            onClose={() => {
              if (personalFlow.invocation !== entry.invocation) return
              setPersonalFlow({ groupID: "", draft: undefined, autoSubmit: false })
            }}
          />
        )}
      </Show>
      <Show when={personalFlow.error}>
        <p role="alert" class="px-3 py-2 text-12-regular text-text-critical">
          {language.t(personalFlow.error === "localOnly" ? "im.dac.localOnly" : "im.dac.error.capacity")}
        </p>
      </Show>
      <Show
        when={
          workspace.page === "messages" && selectedGroupID()
            ? personalDrafts.find(selectedGroupID()!)?.state.command
            : undefined
        }
      >
        {(value) => (
          <div class="mx-3 my-2 rounded-lg bg-surface-raised-base px-3 py-2 text-12-regular" data-slot="im-dac-status">
            <p class="text-12-medium">
              {language.t(
                value().replyStatus ? `im.dac.reply.${value().replyStatus}` : `im.dac.state.${value().state}`,
              )}
            </p>
            <p class="mt-1 truncate text-11-regular text-text-weak" title={value().directory}>
              {language.t("im.dac.project")}: {value().directory}
            </p>
            <Show when={value().sessionID}>
              <p class="mt-1 truncate text-11-regular text-text-weak">{value().sessionID}</p>
            </Show>
            <Button size="small" variant="ghost" class="mt-2" onClick={() => beginPersonal("")}>
              {language.t("im.dac.open")}
            </Button>
          </div>
        )}
      </Show>
      <header class="im-sidebar-header">
        <div class="im-sidebar-heading">
          <Show when={workspace.page === "messages" && (selectedGroupID() || shortFlow())}>
            <IconButton
              icon="chevron-left"
              variant="ghost"
              class="im-sidebar-action"
              onClick={() => {
                if (searching() && selectedGroupID()) return setSearching(false)
                if (directTarget() !== null) return cancelDirect()
                if (creatingName() !== null) return cancelCreate()
                backToList()
              }}
              aria-label={language.t("common.goBack")}
            />
          </Show>
          <div class="im-sidebar-title-copy">
            <h2 title={selectedGroup()?.name}>
              {workspace.page === "settings"
                ? language.t("im.workspace.settings")
                : workspace.page === "contacts"
                  ? language.t("im.workspace.contacts")
                  : selectedGroupID()
                    ? (selectedGroup()?.name ??
                      groups().find((group) => group.id === selectedGroupID())?.name ??
                      language.t("im.loading"))
                    : shortFlow()
                      ? language.t(directTarget() !== null ? "im.direct.create" : "im.group.create")
                      : language.t("im.workspace.messages")}
            </h2>
            <Show when={facadeActive() && facadeStatus()?.kernel}>
              <p>
                {language.t(
                  facadeStatus()?.kernel === "connected" ? "im.connection.live" : "im.connection.reconnecting",
                )}
              </p>
            </Show>
          </div>
        </div>
        <DropdownMenu placement="bottom-end" gutter={8} modal={false}>
          <DropdownMenu.Trigger class="im-sidebar-action" aria-label={language.t("im.sidebar.actions")}>
            <Icon name="plus-small" size="medium" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="im-sidebar-menu">
              <Show when={workspace.page === "settings"}>
                <DropdownMenu.Item
                  disabled={!facadeActive() || !identity() || availability.statusFailed}
                  onSelect={() => setWorkspace("renameRequest", (value) => value + 1)}
                >
                  <Icon name="pencil-line" size="small" />
                  <DropdownMenu.ItemLabel>{language.t("im.facade.identity.rename")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={!facadeActive() || !identity() || availability.statusFailed}
                  onSelect={() => void copyIdentity()}
                >
                  <Icon name="copy" size="small" />
                  <DropdownMenu.ItemLabel>{language.t("im.sidebar.copyID")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <Show when={workspace.page === "contacts" || (workspace.page === "messages" && !selectedGroupID())}>
                <DropdownMenu.Item
                  disabled={
                    busy() ||
                    !canOpen() ||
                    directTarget() !== null ||
                    (workspace.page === "contacts" && !facadeActive())
                  }
                  onSelect={() => {
                    if (workspace.page === "contacts") return setWorkspace("lookupRequest", (value) => value + 1)
                    startDirect()
                  }}
                >
                  <Icon name="bubble-5" size="small" />
                  <DropdownMenu.ItemLabel>{language.t("im.direct.create")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={busy() || !canOpen() || creatingName() !== null} onSelect={startCreate}>
                  <Icon name="plus-small" size="small" />
                  <DropdownMenu.ItemLabel>{language.t("im.group.create")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <Show when={workspace.page === "messages" && selectedGroupID()}>
                <Show when={inviteable()}>
                  <DropdownMenu.Item
                    disabled={busy()}
                    onSelect={() => {
                      setInlineFailure(null)
                      setInviteName("")
                      setInvitingGroupID(selectedGroupID())
                    }}
                  >
                    <Icon name="plus-small" size="small" />
                    <DropdownMenu.ItemLabel>{language.t("im.facade.invite")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </Show>
                <DropdownMenu.Item
                  disabled={availability.statusFailed || capabilities()?.im === false}
                  onSelect={showSearch}
                >
                  <Icon name="magnifying-glass" size="small" />
                  <DropdownMenu.ItemLabel>{language.t("im.search.messages")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item
                disabled={
                  availability.statusLoading ||
                  (workspace.page === "messages" && selectedGroupID()
                    ? selectedReadyID() !== selectedGroupID()
                    : loading())
                }
                onSelect={() => {
                  if (workspace.page === "messages" && selectedGroupID())
                    return setWorkspace("refreshRequest", (value) => value + 1)
                  refreshFacade()
                }}
              >
                <Icon name="history" size="small" />
                <DropdownMenu.ItemLabel>{language.t("im.transport.refresh")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </header>
      <Show when={workspace.page === "settings" && workspace.copyResult}>
        <p role="status" class="im-sidebar-feedback">
          {language.t(workspace.copyResult === "copied" ? "im.sidebar.copied" : "im.sidebar.copyFailed")}
        </p>
      </Show>

      <div
        class="im-sidebar-page min-h-0 flex-1 flex-col"
        classList={{ flex: workspace.page === "messages", hidden: workspace.page !== "messages" }}
        aria-hidden={workspace.page !== "messages"}
      >
        <div class="im-sidebar-stack flex min-h-0 flex-1 flex-col">
          <div
            class="im-sidebar-discovery min-h-0 flex-1 flex-col overflow-y-auto"
            classList={{ flex: !selectedGroupID() || searching(), hidden: !!selectedGroupID() && !searching() }}
          >
            <Show when={!shortFlow()}>
              <label class="im-sidebar-search">
                <span class="sr-only">{language.t("im.workspace.filter")}</span>
                <Icon name="magnifying-glass" size="small" />
                <input
                  ref={searchInput}
                  value={workspace.filter}
                  placeholder={language.t(selectedGroupID() ? "im.search.messages" : "im.workspace.filter")}
                  onInput={(event) => setWorkspace("filter", event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
                    event.preventDefault()
                    searchRecords()
                  }}
                />
                <Show when={workspace.filter}>
                  <button
                    type="button"
                    class="im-sidebar-clear"
                    aria-label={language.t("im.sidebar.clearSearch")}
                    onClick={() => {
                      setWorkspace({ filter: "", searchGroup: undefined })
                      setSearching(false)
                      searchInput?.focus()
                    }}
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </Show>
              </label>
              <Show when={workspace.filter.trim() && !searching()}>
                <Button
                  variant="ghost"
                  class="im-sidebar-search-records"
                  disabled={availability.statusFailed || capabilities()?.im === false}
                  onClick={searchRecords}
                >
                  {language.t("im.sidebar.searchRecords")}
                </Button>
              </Show>
            </Show>
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
              <ActivationCard onActivate={() => void manageIM()} />
            </Show>
            <Show when={facadeState() === "blocked" && facadeStatus()?.blocked}>
              {(blocked) => (
                <BlockedCard blocked={blocked()} onRecovered={refreshFacade} onActivate={() => void manageIM()} />
              )}
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
            <Show when={!selectedGroupID() && !shortFlow()}>
              <Show when={workspace.filter.trim()}>
                <h3 class="im-sidebar-section-label">{language.t("im.sidebar.conversations")}</h3>
              </Show>
              <Show
                when={!loading()}
                fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("im.loading")}</div>}
              >
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
                    <For
                      each={visibleGroups()}
                      fallback={
                        <p role="status" class="p-4 text-center text-12-regular text-text-weak">
                          {language.t("im.workspace.noMatches")}
                        </p>
                      }
                    >
                      {(group) => (
                        <button
                          type="button"
                          onClick={() => setSelectedGroupID(group.id)}
                          class="flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-surface-raised-base-hover"
                          classList={{ "bg-surface-raised-base-active": selectedGroupID() === group.id }}
                          aria-pressed={selectedGroupID() === group.id}
                        >
                          <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised-base text-14-medium text-text-weak"
                            aria-hidden="true"
                          >
                            {Array.from(group.name)[0] ?? "?"}
                          </span>
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-1.5 min-w-0">
                              <span class="text-13-medium text-text-strong truncate">{group.name}</span>
                              <Show when={kernelBadge(group)}>
                                {(badge) => (
                                  <span class="shrink-0 rounded-sm bg-surface-raised-base px-1 py-px text-10-medium text-text-weak">
                                    {language.t(
                                      badge() === "orgAll" ? "im.facade.badge.orgAll" : "im.facade.badge.kernel",
                                    )}
                                  </span>
                                )}
                              </Show>
                            </span>
                            <span class="mt-1 block truncate text-11-regular text-text-weak">
                              {language.t(group.type === "direct" ? "im.workspace.direct" : "im.workspace.group")}
                              <Show when={group.reader}>
                                {" "}
                                ·{" "}
                                {group.reader?.state === "pending"
                                  ? language.t("im.reader.pending")
                                  : `${language.t("im.reader.unread")}: ${group.reader?.liveUnread ?? "—"}`}
                              </Show>
                            </span>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
            <div classList={{ hidden: !searching() || !workspace.filter.trim() }} data-slot="im-message-search-results">
              <h3 class="im-sidebar-section-label">{language.t("im.sidebar.records")}</h3>
              <MessageSearch
                hideInput
                query={workspace.filter}
                submitRequest={workspace.searchRequest}
                groupID={workspace.searchGroup}
                active={workspace.page === "messages" && searching()}
                localGroupIDs={groups()
                  .filter((group) => !protectedGroup(group))
                  .map((group) => group.id)}
                displayEpoch={facadeStatus()?.reader?.displayEpoch}
                invalidation={availability.invalidation}
                onSelect={({ groupID, messageID }) => {
                  setSearching(false)
                  setSelectedGroupID(groupID)
                  setMessageLocation({
                    groupID,
                    messageID,
                    scope: client.scope(),
                    epoch: facadeStatus()?.reader?.displayEpoch,
                  })
                }}
              />
            </div>
          </div>
          <Show when={selectedGroupID()} keyed>
            {(id) => (
              <div
                class="im-sidebar-conversation flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden relative"
                style={{ display: searching() ? "none" : undefined }}
              >
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
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy()}
                        onClick={() => setInvitingGroupID(null)}
                      >
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
                    messageLocation={selectedMessageLocation()}
                    onExitLocation={() => setMessageLocation(undefined)}
                    onMetadataRefreshed={loadSelected}
                    onUseDac={
                      ServerConnection.local(server.current)
                        ? (message) => {
                            if (message.groupID !== selectedGroupID() || message.senderType !== "user") return
                            beginPersonal("", message)
                          }
                        : undefined
                    }
                    onDac={
                      ServerConnection.local(server.current)
                        ? (text, delivery) => beginPersonal(text, undefined, delivery)
                        : undefined
                    }
                    onOpenConversationSession={
                      ServerConnection.local(server.current) ? () => beginPersonal("") : undefined
                    }
                    headerOwned
                    refreshRequest={workspace.refreshRequest}
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
      </div>
      <div
        class="im-sidebar-page min-h-0 flex-1 flex-col"
        classList={{ flex: workspace.page === "contacts", hidden: workspace.page !== "contacts" }}
        aria-hidden={workspace.page !== "contacts"}
      >
        <Show when={workspace.visited.contacts}>
          <IMContactsPage
            active={workspace.page === "contacts"}
            available={facadeActive() && !availability.statusFailed && !availability.readerUnavailable}
            account={communication()?.accountID}
            groups={groups()}
            lookupRequest={workspace.lookupRequest}
            openDirect={openContactDirect}
            openGroup={(id) => {
              setSelectedGroupID(id)
              setWorkspace("page", "messages")
            }}
          />
        </Show>
      </div>
      <div
        class="im-sidebar-page min-h-0 flex-1 flex-col"
        classList={{ flex: workspace.page === "settings", hidden: workspace.page !== "settings" }}
        aria-hidden={workspace.page !== "settings"}
      >
        <Show when={workspace.visited.settings}>
          <IMUserSettingsPage
            status={facadeStatus()}
            statusFailed={availability.statusFailed}
            current={() => !refresh.disposed}
            localAvailable={ServerConnection.local(server.current)}
            onManageIM={() => void manageIM()}
            onChanged={refreshFacade}
            renameRequest={workspace.renameRequest}
          />
        </Show>
      </div>
      <Show when={rootPage()}>
        <nav class="im-sidebar-navigation" aria-label={language.t("im.workspace.navigation")}>
          <For each={["messages", "contacts", "settings"] as const}>
            {(page) => (
              <button
                type="button"
                aria-current={workspace.page === page ? "page" : undefined}
                onClick={() =>
                  batch(() => {
                    if (page !== "messages") setWorkspace("visited", page, true)
                    setWorkspace("page", page)
                  })
                }
              >
                <Icon
                  name={page === "messages" ? "bubble-5" : page === "contacts" ? "bullet-list" : "settings-gear"}
                  size="small"
                />
                <span>{language.t(`im.workspace.${page}`)}</span>
              </button>
            )}
          </For>
        </nav>
      </Show>
    </div>
  )
}
