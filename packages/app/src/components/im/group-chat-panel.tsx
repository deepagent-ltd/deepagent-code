import { createSignal, createEffect, createMemo, onMount, Show, For, onCleanup, untrack } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { MessageList } from "./message-list"
import { MessageComposer } from "./message-composer"
import { ThreadView } from "./thread-view"
import { useIMWebSocket } from "@/hooks/use-im-websocket"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import {
  createIMClient,
  mergeIMMessages,
  useIMClient,
  IMFacadeRequestError,
  type IMClient,
  type IMMessagePage,
} from "@/utils/im-client"
import type { AgentDescriptor, IMReaderGroup, IMReadResult } from "./types"
import { createComposerDrafts } from "./composer-draft"
import { createMediaIntentStore, createMediaBatchStore } from "@/utils/im-media-intent"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { Schema } from "effect"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"

interface GroupChatPanelProps {
  groupID: string
  reader?: IMReaderGroup
  protected?: boolean
  displayEpoch?: string
  onReaderInvalidated?: (reason: "history" | "source") => void
  onMetadataRefreshed?: () => Promise<void>
  readerUnavailable?: boolean
  name?: string
  headerOwned?: boolean
  selfMemberIDs?: readonly string[]
  senderNames?: ReadonlyMap<string, string>
  // §B3 thread — when true, clicking a message opens its reply thread. Gated by the caller on the
  // server's v4ThreadEnabled capability so the affordance only appears where the route is live.
  threadsEnabled?: boolean
  onOpenConversationSession?: (message: LocalMessage) => void
  onUseDac?: (message: LocalMessage) => void
  onDac?: (text: string, delivery: "queue" | "steer") => boolean | void | Promise<boolean | void>
  // §B3 file upload — when true, the composer shows the Attach button. Gated on the server's
  // v4FileUploadEnabled capability so we don't render an affordance the route fails-closed on
  // (a click would otherwise 404 FILE_UPLOAD_DISABLED and toast an error).
  fileUploadEnabled?: boolean
  drafts?: ReturnType<typeof createComposerDrafts>
}

export function GroupChatPanel(props: GroupChatPanelProps) {
  const drafts = props.drafts ?? createComposerDrafts()
  const client = useIMClient()
  const target = createMemo(
    () => ({
      groupID: props.groupID,
      scope: client.scope?.(),
      epoch: props.displayEpoch,
      identity: (props.selfMemberIDs ?? ["server"]).join("\0"),
    }),
    undefined,
    {
      equals: (a, b) =>
        a?.groupID === b.groupID && a?.scope === b.scope && a?.identity === b.identity && a?.epoch === b.epoch,
    },
  )
  // A new conversation owns its requests, composer and socket lifecycle. Returning
  // to a conversation reuses only its draft, never another conversation's UI state.
  return (
    <Show when={target().groupID ? target() : undefined} keyed>
      {(captured) => (
        <GroupConversation
          {...props}
          groupID={captured.groupID}
          drafts={drafts}
          client={captured.scope ? createIMClient(() => captured.scope!) : client}
        />
      )}
    </Show>
  )
}

function GroupConversation(
  props: GroupChatPanelProps & { drafts: ReturnType<typeof createComposerDrafts>; client: IMClient },
) {
  const language = useLanguage()
  const client = props.client
  const requests = new AbortController()
  const [state, setState] = createStore({
    mediaRecords: [] as MediaIntent.Record[],
    mediaBatches: [] as MediaBatch.Record[],
    mediaPolicy: undefined as MediaBatch.Policy | undefined,
    mediaReady: false,
    mediaFailed: false,
    mediaInitializing: false,
    mediaInitializationError: "" as "" | "disabled" | "qualification" | "storage" | "capacity",
    mediaError: "" as "" | "tooMany" | "tooLarge" | "expired",
    uploadProgress: "",
    sendingAttachment: false,
    failed: false,
    cursor: null as string | null,
    hasMore: false,
    loadingOlder: false,
    refreshing: false,
    refreshFailed: false,
    readerUnavailable: !!props.protected || !!props.reader,
    readBusy: false,
    newActionRequired: false,
    checkedActionID: "",
    checkedState: undefined as IMReadResult["reader"],
    readPrepared: false,
    readReached: false,
    readResult: undefined as IMReadResult["reader"],
  })
  const [historicalMessages, setHistoricalMessages] = createSignal<LocalMessage[]>([])
  const [agents, setAgents] = createSignal<AgentDescriptor[]>([])
  const [loading, setLoading] = createSignal(true)
  const [threadRoot, setThreadRoot] = createSignal<LocalMessage | null>(null)
  const history = {
    generation: 0,
    active: false,
    pending: false,
    anchor: "",
    disposed: false,
    nextAt: 0,
    direct: true,
    trailing: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const clearTrailing = () => {
    if (history.trailing !== undefined) clearTimeout(history.trailing)
    history.trailing = undefined
  }
  const trail = () => {
    if (history.disposed || history.active || history.trailing !== undefined || document.visibilityState === "hidden")
      return
    const generation = history.generation
    history.trailing = setTimeout(
      () => {
        history.trailing = undefined
        if (history.disposed || generation !== history.generation || !history.pending) return
        void load(true, false)
      },
      Math.ceil(Math.max(0, history.nextAt - performance.now())),
    )
  }
  const reader = {
    epoch: props.displayEpoch ?? "",
    deadline: Infinity,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    actionID: undefined as string | undefined,
    readFlight: false,
    finishedActionID: undefined as string | undefined,
    supersededActions: new Set<string>(),
  }
  const protectedGroup = () => props.protected || !!props.reader
  const unresolvedActions = createMemo(() => props.reader?.unresolvedReadActions ?? [])
  const currentUnknownListed = () =>
    state.readResult?.state === "unknown" &&
    unresolvedActions().some((action) => action.actionID === state.readResult?.actionID)
  const currentReadVisible = () =>
    (!unresolvedActions().length && !state.newActionRequired) ||
    state.readPrepared ||
    state.readResult?.state === "partial" ||
    (state.readResult?.state === "unknown" && !currentUnknownListed())
  const newReadAvailable = () => {
    const current = props.reader
    const admitted = current?.admittedOrdinal
    const unknown = unresolvedActions()
    if (
      !current ||
      current.state !== "ready" ||
      !admitted ||
      !/^(0|[1-9][0-9]{0,18})$/.test(admitted) ||
      (admitted.length === 19 && admitted > "9223372036854775807") ||
      !unknown.length ||
      !current.liveUnread ||
      !/^[1-9][0-9]*$/.test(current.liveUnread) ||
      state.readPrepared ||
      state.readResult?.state === "partial" ||
      current.readAction?.phase === "prepared" ||
      current.readAction?.phase === "dispatched"
    )
      return false
    return unknown.every(
      (action) =>
        /^(0|[1-9][0-9]{0,18})$/.test(action.targetAdmitted) &&
        (admitted.length > action.targetAdmitted.length ||
          (admitted.length === action.targetAdmitted.length && admitted > action.targetAdmitted)),
    )
  }
  createEffect(() => {
    const action = props.reader?.readAction
    untrack(() => {
      if (
        !action ||
        reader.readFlight ||
        (reader.finishedActionID === action.actionID && state.readResult?.actionID === action.actionID) ||
        reader.supersededActions.has(action.actionID)
      )
        return
      if (reader.actionID && reader.actionID !== action.actionID) return
      if ((action.phase === "confirmed" && action.targetReached) || action.phase === "cancelled") {
        reader.finishedActionID = action.actionID
        reader.actionID = undefined
        setState({
          readPrepared: false,
          readReached: action.targetReached,
          readResult: {
            actionID: action.actionID,
            state: action.phase === "cancelled" ? "cancelled" : "confirmed",
            targetAdmitted: action.targetAdmitted,
            readOrdinal: "",
            liveUnread: "",
          },
        })
        return
      }
      reader.actionID = action.actionID
      setState({
        readPrepared: action.phase === "prepared",
        readReached: action.targetReached,
        readResult:
          action.phase === "prepared"
            ? undefined
            : {
                actionID: action.actionID,
                state: action.phase === "confirmed" ? "partial" : "unknown",
                targetAdmitted: action.targetAdmitted,
                readOrdinal: "",
                liveUnread: "",
              },
      })
    })
  })
  const invalidate = (epoch?: string, reason: "history" | "source" = "source") => {
    if (history.disposed || !protectedGroup()) return
    clearTrailing()
    history.generation++
    history.pending = false
    history.anchor = ""
    if (epoch && epoch !== reader.epoch) reader.actionID = undefined
    if (epoch) reader.epoch = epoch
    if (reader.timer) clearTimeout(reader.timer)
    reader.deadline = Infinity
    setHistoricalMessages([])
    setThreadRoot(null)
    setState({
      cursor: null,
      hasMore: false,
      loadingOlder: false,
      readerUnavailable: true,
      readReached: false,
      readBusy: reader.readFlight,
      readResult: reader.actionID
        ? { actionID: reader.actionID, state: "unknown", targetAdmitted: "", readOrdinal: "", liveUnread: "" }
        : undefined,
    })
    setLoading(false)
    props.onReaderInvalidated?.(reason)
  }
  const historyFailure = (error: unknown) =>
    error instanceof IMFacadeRequestError &&
    ([401, 403, 404, 410].includes(error.status) ||
      ["reader_scope_mismatch", "reader_stale", "reader_legacy_unverified", "reader_mapping_conflict"].includes(
        error.code,
      ))
      ? "source"
      : "history"
  const acceptPage = (page: IMMessagePage, started: number) => {
    if (!protectedGroup()) return true
    if (!connected()) {
      invalidate()
      return false
    }
    if (!page.reader || page.protectedUnavailable) {
      invalidate(undefined, "history")
      return false
    }
    const value = page.reader
    if (props.displayEpoch && props.displayEpoch !== value.displayEpoch) {
      invalidate()
      return false
    }
    if (reader.epoch && reader.epoch !== value.displayEpoch) {
      setHistoricalMessages([])
      setThreadRoot(null)
      reader.deadline = Infinity
      reader.actionID = undefined
      setState("readResult", undefined)
    }
    reader.epoch = value.displayEpoch
    const remaining = value.nextExpiryAt === null ? Infinity : value.nextExpiryAt - value.validatedServerNow
    if (
      !Number.isSafeInteger(value.validatedServerNow) ||
      (value.nextExpiryAt !== null && !Number.isSafeInteger(value.nextExpiryAt)) ||
      remaining <= 0 ||
      started + remaining <= performance.now()
    ) {
      invalidate()
      return false
    }
    reader.deadline = Math.min(reader.deadline, started + remaining)
    if (reader.timer) clearTimeout(reader.timer)
    if (Number.isFinite(reader.deadline))
      reader.timer = setTimeout(() => invalidate(), Math.max(0, reader.deadline - performance.now()))
    setState("readerUnavailable", false)
    return true
  }
  let mediaStore: ReturnType<typeof createMediaIntentStore> | undefined
  let batchStore: ReturnType<typeof createMediaBatchStore> | undefined
  let mediaScope: MediaIntent.Scope | undefined
  let mediaAbort = new AbortController()
  let mediaGeneration = 0
  let uploadAbort: AbortController | undefined
  const reloadMedia = async () => {
    if (!mediaStore || !mediaScope) return
    const run = mediaGeneration
    if (!batchStore) return
    const [values, batches] = await Promise.all([mediaStore.list(mediaScope), batchStore.list(mediaScope)])
    if (!history.disposed && run === mediaGeneration) {
      const claimed = new Set(
        batches
          .filter((batch) => batch.phase !== "unavailable")
          .flatMap((batch) => batch.files.map((file) => file.intentID)),
      )
      setState({
        mediaRecords: values.filter(
          (value) => !["bound", "unavailable"].includes(value.phase) && !claimed.has(value.id),
        ),
        mediaBatches: batches.filter((batch) => !["bound", "unavailable"].includes(batch.phase)),
      })
    }
  }
  const mediaDraft = () => state.mediaBatches.find((batch) => batch.phase === "draft")
  const mediaInit = { enabled: false, running: false, pending: false }
  // Qualification queries may fail before the parent finishes observing this
  // conversation. A later metadata observation can retry only initialization.
  // An initialized media owner and its dispatched requests remain untouched.
  const initializeMedia = (successor = false) => {
    if (history.disposed || !mediaInit.enabled || mediaScope) return
    if (mediaInit.running) {
      if (!successor) mediaInit.pending = true
      return
    }
    const run = mediaGeneration
    const signal = AbortSignal.any([mediaAbort.signal, AbortSignal.timeout(10_000)])
    mediaInit.running = true
    mediaInit.pending = false
    setState("mediaInitializing", true)
    const phase = { current: "disabled" as "disabled" | "qualification" | "storage" }
    void (async () => {
      if (!(await client.mediaEnabled(signal))) throw new Error("media_disabled")
      phase.current = "qualification"
      const [detail, status] = await Promise.all([client.getGroup(props.groupID, signal), client.facadeStatus(signal)])
      if (history.disposed || run !== mediaGeneration || mediaAbort.signal.aborted) return
      signal.throwIfAborted()
      const group = detail.group
      if (!group || !status.viewer?.memberID) throw new Error("media_qualification_unavailable")
      // A verified empty conversation may have no visible history yet. The
      // original upload/send endpoints still recheck current membership.
      if (
        (group.kernelConvID || group.reader) &&
        ((group.reader?.state !== "pending" && group.reader?.state !== "ready") ||
          !detail.reader ||
          status.reader?.state !== "ready" ||
          status.kernel !== "connected" ||
          detail.reader.displayEpoch !== status.reader.displayEpoch)
      )
        throw new Error("media_qualification_unavailable")
      phase.current = "storage"
      mediaScope = MediaIntent.scope({
        server: client.scope().url,
        directory: client.scope().directory,
        workspaceID: group.workspaceID,
        groupID: group.id,
        memberID: status.viewer.memberID,
      })
      mediaStore = createMediaIntentStore()
      batchStore = createMediaBatchStore()
      if (Schema.is(MediaBatch.Policy)(status.media)) setState("mediaPolicy", status.media)
      await reloadMedia()
      signal.throwIfAborted()
      if (!history.disposed && run === mediaGeneration) setState({ mediaReady: true, mediaInitializationError: "" })
    })()
      .catch((error: unknown) => {
        if (history.disposed || run !== mediaGeneration || mediaAbort.signal.aborted) return
        mediaStore?.close()
        batchStore?.close()
        mediaStore = undefined
        batchStore = undefined
        mediaScope = undefined
        // These requests only qualify attachment access and read local receipts.
        // They have not dispatched an upload or message; retain operation uncertainty separately.
        setState({
          mediaReady: false,
          mediaInitializationError:
            phase.current === "storage" &&
            error instanceof Error &&
            (error.message === "media_store_limit" || error.name === "QuotaExceededError")
              ? "capacity"
              : phase.current,
        })
      })
      .finally(() => {
        if (history.disposed || run !== mediaGeneration) return
        mediaInit.running = false
        setState("mediaInitializing", false)
        const again = !successor && mediaInit.pending && !mediaScope
        mediaInit.pending = false
        // Coalesce observations made during a query into at most one successor.
        if (again) initializeMedia(true)
      })
  }
  createEffect(() => {
    const enabled = !!props.fileUploadEnabled
    untrack(() => {
      if (enabled !== mediaInit.enabled) {
        mediaInit.enabled = enabled
        mediaInit.running = false
        mediaInit.pending = false
        mediaGeneration++
        mediaAbort.abort()
        uploadAbort?.abort()
        mediaAbort = new AbortController()
        mediaStore?.close()
        batchStore?.close()
        mediaStore = undefined
        batchStore = undefined
        mediaScope = undefined
        setState({
          mediaReady: false,
          mediaRecords: [],
          mediaBatches: [],
          mediaPolicy: undefined,
          mediaFailed: false,
          mediaInitializing: false,
          mediaInitializationError: "",
        })
      }
      if (enabled) initializeMedia()
    })
  })
  onCleanup(() => {
    mediaGeneration++
    mediaAbort.abort()
    uploadAbort?.abort()
    mediaStore?.close()
    batchStore?.close()
  })

  const {
    connected,
    messages: realtimeMessages,
    agentStatuses,
    agentProgress,
    typingMembers,
    send,
    reconnect,
  } = useIMWebSocket(client, () => props.groupID, {
    protected: protectedGroup,
    changed: (epoch) => {
      if (reader.epoch && reader.epoch !== epoch) invalidate(epoch)
      void load(true)
    },
    invalidated: invalidate,
  })

  // The single desktop user identity, as the server assigns it. Used to exclude
  // our own echoed typing/read events from the UI.
  const selfMemberID = () => props.selfMemberIDs?.[0] ?? "server"

  const othersTyping = () =>
    Array.from(typingMembers()).filter((id) => !(props.selfMemberIDs ?? ["server"]).includes(id))

  // Load historical messages
  const load = (background = false, allowSuccessor = true) => {
    if (history.disposed || (protectedGroup() && !connected())) {
      setLoading(false)
      return
    }
    if (background && document.visibilityState === "hidden") {
      clearTrailing()
      history.pending = true
      return
    }
    if (history.active) {
      history.pending = true
      return
    }
    if (background && (history.trailing !== undefined || (performance.now() < history.nextAt && !history.direct))) {
      history.pending = true
      trail()
      return
    }
    if (!background) clearTrailing()
    // Trailing refreshes consume the latest hint without reopening an immediate request chain.
    history.direct = allowSuccessor && performance.now() >= history.nextAt
    history.nextAt = performance.now() + 1000
    history.active = true
    history.pending = false
    const result = { succeeded: false }
    const groupID = props.groupID
    const generation = history.generation
    const current = () => !history.disposed && history.generation === generation
    const observed = new Map(historicalMessages().map((message) => [message.id, message]))
    const anchor = history.anchor
    const started = performance.now()
    if (!background) setLoading(true)
    return client
      .listMessages(groupID, 50, undefined, AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]))
      .then(async (data) => {
        if (!current() || !acceptPage(data, started)) return
        const historical = [...data.messages]
        // A reconnect can span more than the newest page. Walk back to a known message
        // before merging, so realtime gaps do not become holes in the visible conversation.
        let page = data
        for (
          let count = 0;
          !protectedGroup() &&
          background &&
          anchor &&
          page.hasMore &&
          !page.messages.some((message) => message.id === anchor);
          count++
        ) {
          if (count >= 100 || !page.nextCursor) throw new Error("IM history catch-up exceeded its page budget")
          const cursor = page.nextCursor
          page = await client.listMessages(groupID, 50, cursor, requests.signal)
          if (!current()) return
          if (page.hasMore && page.nextCursor === cursor) throw new Error("IM history cursor did not advance")
          historical.push(...page.messages)
        }
        setHistoricalMessages((previous) => mergeIMMessages(previous, historical, "snapshot", observed))
        result.succeeded = true
        setState("failed", false)
        if (!background || !anchor) setState({ cursor: data.nextCursor, hasMore: data.hasMore })
        history.anchor = data.messages.at(-1)?.id ?? anchor
        setLoading(false)
        markVisibleRead()
      })
      .catch((error: unknown) => {
        if (!current()) return
        if (protectedGroup()) invalidate(undefined, historyFailure(error))
        setState("failed", true)
        setLoading(false)
      })
      .finally(() => {
        if (history.disposed) return
        history.active = false
        if (!history.pending) return
        if (!result.succeeded && generation === history.generation) {
          history.pending = false
          clearTrailing()
          return
        }
        if (allowSuccessor && history.direct) void load(true, false)
        else trail()
      })
  }
  const loadOlder = async () => {
    if (state.loadingOlder || !state.cursor) return
    const cursor = state.cursor
    const groupID = props.groupID
    const generation = history.generation
    const observed = new Map(historicalMessages().map((message) => [message.id, message]))
    const started = performance.now()
    setState("loadingOlder", true)
    try {
      const page = await client.listMessages(groupID, 50, cursor, requests.signal)
      if (history.disposed || history.generation !== generation || !acceptPage(page, started)) return
      if (
        page.hasMore !== (typeof page.nextCursor === "string" && page.nextCursor.length > 0) ||
        (!page.hasMore && page.nextCursor !== null) ||
        page.nextCursor === cursor
      )
        throw new Error("IM history cursor did not advance")
      setHistoricalMessages((previous) => mergeIMMessages(previous, page.messages, "snapshot", observed))
      setState({ cursor: page.nextCursor, hasMore: page.hasMore, failed: false })
    } catch (error) {
      if (!history.disposed && history.generation === generation) {
        if (protectedGroup()) invalidate(undefined, historyFailure(error))
        setState("failed", true)
      }
    } finally {
      if (!history.disposed && history.generation === generation) setState("loadingOlder", false)
    }
  }
  createEffect(() => {
    props.groupID
    history.generation++
    clearTrailing()
    history.active = false
    history.pending = false
    history.anchor = ""
    setHistoricalMessages([])
    setThreadRoot(null)
    setState({ cursor: null, hasMore: false, loadingOlder: false, failed: false })
    void untrack(() => load())
  })
  createEffect(() => {
    if (connected()) void untrack(() => load(true))
  })
  createEffect(() => {
    if (props.readerUnavailable) untrack(() => invalidate())
  })
  onCleanup(() => {
    history.disposed = true
    clearTrailing()
    requests.abort()
    if (reader.timer) clearTimeout(reader.timer)
  })
  onMount(() => {
    const page = { hidden: document.visibilityState === "hidden" }
    const visible = () => {
      if (document.visibilityState === "hidden") {
        page.hidden = true
        clearTrailing()
        return
      }
      if (page.hidden) {
        history.nextAt = 0
        history.direct = true
      }
      page.hidden = false
      if (protectedGroup() && connected()) void load(true)
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden" && protectedGroup() && connected()) void load(true)
    }, 30_000)
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", visible)
    })
  })

  // Load available agents
  onMount(() => {
    client
      .listAgents(requests.signal)
      .then((data) => {
        if (history.disposed) return
        setAgents(data || [])
      })
      .catch((error) => {
        if (history.disposed) return
        console.error("Failed to load agents:", error)
      })
  })

  // Creation echoes may arrive after an acknowledged HTTP receipt. They never downgrade it.
  createEffect(() => {
    const incoming = realtimeMessages()
    if (protectedGroup()) return
    untrack(() => {
      const existing = new Set(historicalMessages().map((message) => message.id))
      setHistoricalMessages((previous) => mergeIMMessages(previous, incoming, "live"))
      if (incoming.some((message) => !existing.has(message.id))) markVisibleRead()
    })
  })
  const allMessages = historicalMessages

  function markVisibleRead() {
    if (protectedGroup() || history.disposed || loading() || historicalMessages().length === 0) return
    const readAt = Date.now()
    void client.markRead(props.groupID, readAt).catch(() => undefined)
    send({ type: "read_receipt", data: { groupID: props.groupID, memberID: selfMemberID(), readAt } })
  }

  const markProtectedRead = async (
    mode: "current" | "cancel" | "new" | "reconcile" = "current",
    originalID?: string,
  ) => {
    const historical =
      mode === "reconcile" ? unresolvedActions().find((action) => action.actionID === originalID) : undefined
    if (
      (mode === "cancel" && !state.readPrepared) ||
      (mode === "new" && !newReadAvailable()) ||
      (mode === "reconcile" && !historical) ||
      !protectedGroup() ||
      props.reader?.state !== "ready" ||
      state.readerUnavailable ||
      state.readBusy ||
      reader.readFlight ||
      !connected()
    )
      return
    if (mode === "current" && !reader.actionID && unresolvedActions().length > 0) return
    const epoch = reader.epoch
    const prior = state.readResult?.state
    const previousID = reader.actionID
    const actionID =
      historical?.actionID ?? (mode === "new" ? undefined : previousID) ?? `gui-read_${crypto.randomUUID()}`
    if (!historical) reader.actionID = actionID
    reader.readFlight = true
    setState("readBusy", true)
    if (!historical)
      setState({ readPrepared: false, readReached: mode !== "new" && prior === "unknown" && state.readReached })
    try {
      const result = await client.markRead(props.groupID, {
        actionID,
        ...(mode === "new"
          ? { newAction: true }
          : mode === "cancel"
            ? { cancel: true }
            : historical || prior === "unknown"
              ? { reconcile: true }
              : prior === "partial"
                ? { continue: true }
                : {}),
      })
      if (
        history.disposed ||
        epoch !== reader.epoch ||
        state.readerUnavailable ||
        (!historical && reader.actionID !== actionID)
      )
        return
      if (!result.reader || result.reader.actionID !== actionID) throw new Error("reader_action_mismatch")
      if (historical) {
        setState({ checkedActionID: actionID, checkedState: result.reader })
        return
      }
      if (mode === "new") {
        reader.supersededActions.clear()
        for (const action of unresolvedActions()) reader.supersededActions.add(action.actionID)
        if (previousID) reader.supersededActions.add(previousID)
      }
      setState({ readResult: result.reader, newActionRequired: false })
      if (result.reader.state === "confirmed" || result.reader.state === "cancelled") {
        reader.finishedActionID = actionID
        reader.actionID = undefined
      }
    } catch (error) {
      if (history.disposed || epoch !== reader.epoch) return
      if (
        error instanceof IMFacadeRequestError &&
        error.code === "reader_unknown" &&
        !historical &&
        mode === "current" &&
        !previousID
      ) {
        reader.actionID = undefined
        setState({ newActionRequired: true, readResult: undefined })
        return
      }
      if (historical || reader.actionID === actionID) invalidate()
    } finally {
      reader.readFlight = false
      if (!history.disposed) setState("readBusy", false)
    }
  }

  // Only explicit refresh updates protected metadata; message observation remains read-only.
  const refreshTransport = async () => {
    if (history.disposed || state.refreshing) return
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 10_000)
    const observed = new Map(historicalMessages().map((message) => [message.id, message]))
    setState({ refreshing: true, refreshFailed: false })
    try {
      if (protectedGroup()) {
        await client.refreshGroup(props.groupID, AbortSignal.any([requests.signal, abort.signal]))
        if (history.disposed || abort.signal.aborted) return
        await props.onMetadataRefreshed?.()
        if (history.disposed || abort.signal.aborted) return
        await load()
        return
      }
      const page = await client.listMessages(
        props.groupID,
        50,
        undefined,
        AbortSignal.any([requests.signal, abort.signal]),
      )
      if (history.disposed || abort.signal.aborted) return
      setHistoricalMessages((previous) => mergeIMMessages(previous, page.messages, "snapshot", observed))
    } catch {
      if (!history.disposed) {
        if (protectedGroup()) invalidate()
        setState("refreshFailed", true)
      }
    } finally {
      clearTimeout(timeout)
      if (!history.disposed) setState("refreshing", false)
    }
  }

  const handleTyping = (typing: boolean) => {
    send({ type: "typing", data: { groupID: props.groupID, memberID: selfMemberID(), typing } })
  }

  const handleSendMessage = async (content: string, clientRequestID: string) => {
    const draft = mediaDraft()
    if (draft) {
      await sendBatch(structuredClone(unwrap(draft)), content)
      return
    }
    const groupID = props.groupID
    const observed = new Map(historicalMessages().map((message) => [message.id, message]))
    const created = await client.createMessage(groupID, { content, type: "text", clientRequestID })
    if (history.disposed || props.groupID !== groupID) return
    // The HTTP receipt is authoritative even when the broadcast is delayed or dropped.
    if (protectedGroup()) {
      void load(true)
      return
    }
    setHistoricalMessages((previous) => mergeIMMessages(previous, [created], "receipt", observed))
  }

  // Multipart uploads only create draft receipts. Sending is a separate user action.
  const handleAttach = async (files: readonly File[]) => {
    const groupID = props.groupID
    const store = mediaStore
    const target = mediaScope
    const run = mediaGeneration
    if (!props.fileUploadEnabled || !state.mediaReady || state.sendingAttachment || !store || !target) return
    if (files.length + (mediaDraft()?.files.length ?? 0) > 4) {
      setState("mediaError", "tooMany")
      return
    }
    if (files.some((file) => file.size > (state.mediaPolicy?.maxAttachmentBytes ?? AttachmentPreview.maxBytes))) {
      setState("mediaError", "tooLarge")
      return
    }
    const abort = new AbortController()
    uploadAbort = abort
    const signal = AbortSignal.any([mediaAbort.signal, abort.signal])
    setState({ sendingAttachment: true, mediaFailed: false, mediaError: "" })
    try {
      if (!(await client.mediaEnabled(signal))) throw new Error("media_disabled")
      for (const [index, file] of files.entries()) {
        signal.throwIfAborted()
        if (history.disposed || run !== mediaGeneration) return
        setState(
          "uploadProgress",
          language.t("im.media.batch.uploadProgress", { current: index + 1, total: files.length }),
        )
        const bytes = await MediaIntent.readBytes(file.stream(), file.size, signal)
        const name = Array.from(file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_"))
          .slice(0, 255)
          .join("")
        const prepared = await store.put(
          MediaIntent.create(target, {
            name,
            mime: AttachmentPreview.mime(bytes),
            sizeBytes: bytes.length,
            checksum: await MediaIntent.checksum(bytes),
          }),
        )
        if (history.disposed || run !== mediaGeneration) return
        const uploading = await store.put(MediaIntent.change(prepared, "uploading"), prepared.revision)
        let received: MediaIntent.Record
        try {
          const attachment = await client.uploadAttachment(new File([bytes], name, { type: prepared.file.mime }), {
            groupId: groupID,
            signal,
          })
          received = await store.put(MediaIntent.change(uploading, "uploaded_unbound", attachment), uploading.revision)
        } catch (error) {
          await store
            .put(MediaIntent.change(uploading, "upload_outcome_unknown"), uploading.revision)
            .catch(() => undefined)
          throw error
        }
        if (history.disposed || run !== mediaGeneration || !props.fileUploadEnabled) return
        const batches = batchStore
        if (!batches) throw new Error("media_store_unavailable")
        const previous = (await batches.list(target)).find((batch) => batch.phase === "draft")
        if (history.disposed || run !== mediaGeneration) return
        await batches.put(
          previous
            ? MediaBatch.edit(previous, { files: [...previous.files, MediaBatch.item(received)] })
            : MediaBatch.create(target, MediaBatch.item(received), state.mediaPolicy?.enabled ? "batch" : "legacy"),
          previous?.revision,
        )
        await reloadMedia()
      }
    } catch {
      if (!abort.signal.aborted && !history.disposed && run === mediaGeneration) setState("mediaFailed", true)
    } finally {
      if (uploadAbort === abort) uploadAbort = undefined
      if (!history.disposed && run === mediaGeneration && state.sendingAttachment) {
        setState({ sendingAttachment: false, uploadProgress: "" })
        await reloadMedia().catch(() => setState("mediaFailed", true))
      }
    }
  }

  const sendBatch = async (record: MediaBatch.Record, content = record.content) => {
    const store = batchStore
    const run = mediaGeneration
    const signal = mediaAbort.signal
    if (
      !store ||
      !mediaScope ||
      !MediaIntent.sameScope(record.scope, mediaScope) ||
      history.disposed ||
      !props.fileUploadEnabled
    )
      throw new Error("media_unavailable")
    if (!(await client.mediaEnabled(signal))) throw new Error("media_disabled")
    const status = await client.facadeStatus(signal)
    if (Schema.is(MediaBatch.Policy)(status.media) && !status.media.enabled) throw new Error("media_disabled")
    const policy = Schema.is(MediaBatch.Policy)(status.media) && status.media.enabled ? status.media : undefined
    if (history.disposed || signal.aborted || run !== mediaGeneration) throw new Error("media_scope_changed")
    if (record.files.some((file) => file.attachment.expiresAt <= Date.now())) {
      setState("mediaError", "expired")
      throw new Error("media_batch_expired")
    }
    if (record.phase === "draft" && !policy && (record.files.length !== 1 || content !== ""))
      throw new Error("media_batch_unsupported")
    if (record.phase !== "draft" && record.format === "batch" && !policy) throw new Error("media_batch_unsupported")
    const prepared =
      record.phase === "draft"
        ? await store.put(
            MediaBatch.edit(record, {
              content: policy ? content : record.files[0].attachment.filename,
              format: policy ? "batch" : "legacy",
            }),
            record.revision,
          )
        : record.phase === "sending"
          ? await store.put(MediaBatch.change(record, "send_outcome_unknown"), record.revision)
          : record
    const pending = await store.put(MediaBatch.change(prepared, "sending"), prepared.revision)
    setState({ sendingAttachment: true, mediaFailed: false, mediaError: "" })
    await reloadMedia()
    try {
      if (history.disposed || signal.aborted || run !== mediaGeneration) throw new Error("media_scope_changed")
      const created = await client.createMessage(
        pending.scope.groupID,
        {
          content: pending.content,
          type: "file",
          clientRequestID: pending.requestID,
          ...(pending.format === "batch"
            ? { attachmentIDs: pending.files.map((file) => file.attachment.id) }
            : { attachmentID: pending.files[0].attachment.id }),
        },
        signal,
      )
      if (!MediaBatch.matches(pending, created)) throw new Error("media_receipt_mismatch")
      await store.put(MediaBatch.change(pending, "bound", created.id), pending.revision)
      // The known message receipt stays known if local retirement later fails.
      await (async () => {
        const originals = await mediaStore?.list(pending.scope)
        for (const file of pending.files) {
          const original = originals?.find((item) => item.id === file.intentID)
          if (original?.phase === "uploaded_unbound")
            await mediaStore?.put(
              MediaIntent.change(original, "bound", { ...file.attachment, messageID: created.id }),
              original.revision,
            )
        }
      })().catch(() => undefined)
      if (!history.disposed && run === mediaGeneration) {
        if (protectedGroup()) void load(true)
        if (!protectedGroup())
          setHistoricalMessages((values) =>
            mergeIMMessages(values, [created], "receipt", new Map(values.map((value) => [value.id, value]))),
          )
      }
    } catch (error) {
      await store.put(MediaBatch.change(pending, "send_outcome_unknown"), pending.revision).catch(() => undefined)
      throw error
    } finally {
      if (!history.disposed && run === mediaGeneration) {
        await reloadMedia().finally(() => {
          if (!history.disposed && run === mediaGeneration) setState("sendingAttachment", false)
        })
      }
    }
  }

  const removeDraftFile = async (record: MediaBatch.Record, intentID: string) => {
    const store = batchStore
    const intents = mediaStore
    const run = mediaGeneration
    if (!store || !intents || state.sendingAttachment || record.phase !== "draft") return
    setState("sendingAttachment", true)
    try {
      const original = (await intents.list(record.scope)).find((item) => item.id === intentID)
      if (!original || original.phase !== "uploaded_unbound") throw new Error("media_store_conflict")
      await intents.put(MediaIntent.change(original, "unavailable"), original.revision)
      const files = record.files.filter((file) => file.intentID !== intentID)
      await store.put(
        files.length ? MediaBatch.edit(record, { files }) : MediaBatch.change(record, "unavailable"),
        record.revision,
      )
    } catch {
      if (!history.disposed && run === mediaGeneration) setState("mediaFailed", true)
    } finally {
      if (!history.disposed && run === mediaGeneration) {
        await reloadMedia().finally(() => {
          if (!history.disposed && run === mediaGeneration) setState("sendingAttachment", false)
        })
      }
    }
  }

  const sendAttachment = async (record: MediaIntent.Record) => {
    const store = mediaStore
    const run = mediaGeneration
    const signal = mediaAbort.signal
    if (
      !store ||
      !mediaScope ||
      !MediaIntent.sameScope(record.scope, mediaScope) ||
      !record.attachment ||
      record.attachment.expiresAt <= Date.now() ||
      history.disposed ||
      !props.fileUploadEnabled
    )
      throw new Error("media_unavailable")
    if (!(await client.mediaEnabled(signal)) || signal.aborted || history.disposed || run !== mediaGeneration)
      throw new Error("media_unavailable")
    setState("sendingAttachment", true)
    const previous =
      record.phase === "sending"
        ? await store.put(MediaIntent.change(record, "send_outcome_unknown"), record.revision)
        : record
    const pending = await store.put(MediaIntent.change(previous, "sending"), previous.revision)
    try {
      if (signal.aborted || history.disposed || run !== mediaGeneration) throw new Error("media_unavailable")
      const created = await client.createMessage(
        pending.scope.groupID,
        {
          content: pending.attachment!.filename,
          type: "file",
          attachmentID: pending.attachment!.id,
          clientRequestID: pending.requestID,
        },
        signal,
      )
      if (
        created.groupID !== pending.scope.groupID ||
        created.senderID !== pending.scope.memberID ||
        created.type !== "file" ||
        created.metadata?.type !== "attachment_ref" ||
        created.metadata.attachmentID !== pending.attachment!.id
      )
        throw new Error("media_receipt_mismatch")
      await store.put(
        MediaIntent.change(pending, "bound", { ...pending.attachment, messageID: created.id }),
        pending.revision,
      )
      if (!history.disposed && run === mediaGeneration) {
        setState("mediaRecords", (values) => values.filter((value) => value.id !== pending.id))
        if (protectedGroup()) {
          void load(true)
          return
        }
        setHistoricalMessages((values) =>
          mergeIMMessages(values, [created], "receipt", new Map(values.map((value) => [value.id, value]))),
        )
      }
    } catch (error) {
      await store.put(MediaIntent.change(pending, "send_outcome_unknown"), pending.revision).catch(() => undefined)
      throw error
    } finally {
      if (!history.disposed && run === mediaGeneration) {
        await reloadMedia().finally(() => {
          if (!history.disposed && run === mediaGeneration) setState("sendingAttachment", false)
        })
      }
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="flex-1 flex items-center justify-center">
          <div class="text-12-regular text-text-weak">{language.t("im.loading")}</div>
        </div>
      }
    >
      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div class="shrink-0 border-b border-border-weaker-base px-3 py-2">
          <Show when={!props.headerOwned}>
            <h2 class="text-13-medium text-text-strong truncate" title={props.name}>
              {props.name ?? language.t("session.tab.im")}
            </h2>
          </Show>
          <div class="flex items-center justify-between gap-2 min-w-0">
            <div class="text-11-regular text-text-weak min-w-0 truncate" role="status">
              <span>{connected() ? language.t("im.connection.live") : language.t("im.connection.reconnecting")}</span>
              <Show when={protectedGroup()}>
                <span aria-hidden="true"> · </span>
                <span>
                  {language.t(
                    props.reader?.state === "pending"
                      ? "im.reader.pending"
                      : state.readerUnavailable
                        ? "im.reader.unavailable"
                        : "im.reader.ready",
                  )}
                </span>
              </Show>
            </div>
            <Button
              class="shrink-0"
              size="small"
              variant="ghost"
              disabled={state.refreshing}
              onClick={() => void refreshTransport()}
            >
              {state.refreshing ? language.t("im.transport.refreshing") : language.t("im.transport.refresh")}
            </Button>
          </div>
          <Show when={protectedGroup()}>
            <div class="flex items-center gap-2 flex-wrap mt-1">
              <Show when={currentReadVisible()}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={
                    state.readBusy || state.readerUnavailable || props.reader?.state !== "ready" || !connected()
                  }
                  onClick={() => void markProtectedRead()}
                >
                  {language.t(
                    state.readPrepared
                      ? "im.reader.resume"
                      : state.readResult?.state === "unknown"
                        ? "im.reader.reconcile"
                        : state.readResult?.state === "partial"
                          ? "im.reader.continue"
                          : "im.reader.markRead",
                  )}
                </Button>
              </Show>
              <Show when={state.readPrepared}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={state.readBusy || state.readerUnavailable || !connected()}
                  onClick={() => void markProtectedRead("cancel")}
                >
                  {language.t("im.reader.cancel")}
                </Button>
              </Show>
            </div>
            <Show when={newReadAvailable()}>
              <Button
                size="small"
                variant="secondary"
                disabled={state.readBusy || state.readerUnavailable || !connected()}
                onClick={() => void markProtectedRead("new")}
              >
                {language.t("im.reader.newAction")}
              </Button>
            </Show>
            <Show when={state.newActionRequired}>
              <p role="status" class="text-12-regular text-text-weak">
                {language.t("im.reader.newActionRequired")}
              </p>
            </Show>
            <Show when={!state.readerUnavailable && unresolvedActions().length > 0}>
              <details class="mt-1 text-12-regular text-text-weak" open>
                <summary class="cursor-pointer">{language.t("im.reader.unresolved")}</summary>
                <div class="max-h-36 overflow-y-auto space-y-2">
                  <For each={unresolvedActions()}>
                    {(action) => (
                      <div class="min-w-0">
                        <p>
                          {language.t(action.targetReached ? "im.reader.targetReachedUnknown" : "im.reader.unknown")}
                        </p>
                        <code class="block break-all text-11-regular">{action.actionID}</code>
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${language.t("im.reader.checkAction")} ${action.actionID}`}
                          disabled={state.readBusy || state.readerUnavailable || !connected()}
                          onClick={() => void markProtectedRead("reconcile", action.actionID)}
                        >
                          {language.t("im.reader.checkAction")}
                        </Button>
                        <Show when={state.checkedActionID === action.actionID && state.checkedState}>
                          <p role="status">
                            {language.t(
                              state.checkedState?.state === "unknown"
                                ? "im.reader.stillUnknown"
                                : `im.reader.${state.checkedState?.state ?? "unknown"}`,
                            )}
                          </p>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </details>
            </Show>
            <Show when={state.readReached && !currentUnknownListed()}>
              <p class="text-12-regular text-text-weak">
                {language.t(
                  state.readResult?.state === "unknown" ? "im.reader.targetReachedUnknown" : "im.reader.targetReached",
                )}
              </p>
            </Show>
            <Show
              when={
                state.readResult &&
                !currentUnknownListed() &&
                !(state.readReached && state.readResult?.state === "unknown")
                  ? state.readResult
                  : undefined
              }
            >
              {(result) => (
                <p role="status" class="text-12-regular text-text-weak">
                  {language.t(`im.reader.${result().state}`)}
                </p>
              )}
            </Show>
          </Show>
          <Show when={state.refreshFailed}>
            <p role="alert" class="text-12-regular text-text-critical">
              {language.t("im.transport.refreshFailed")}
            </p>
          </Show>
          <Show when={!connected()}>
            <Button size="small" variant="ghost" onClick={() => reconnect()}>
              {language.t("im.connection.retry")}
            </Button>
          </Show>
        </div>
        <Show when={state.failed}>
          <div class="px-3 py-2 flex items-center gap-2" role="alert">
            <span class="text-12-regular text-text-critical">{language.t("im.message.load.failed")}</span>
            <Button variant="secondary" size="small" onClick={() => void load(true)}>
              {language.t("im.facade.retry")}
            </Button>
          </div>
        </Show>

        <MessageList
          mediaEnabled={props.fileUploadEnabled}
          messages={allMessages()}
          agentStatuses={agentStatuses()}
          agentProgress={agentProgress()}
          onOpenThread={props.threadsEnabled ? (m) => setThreadRoot(m) : undefined}
          onUseDac={
            props.onUseDac
              ? (message) => {
                  const current = allMessages().find(
                    (item) => item.id === message.id && item.groupID === props.groupID && item.senderType === "user",
                  )
                  if (!current || history.disposed || (protectedGroup() && (!connected() || state.readerUnavailable)))
                    return
                  props.onUseDac?.(current)
                }
              : undefined
          }
          onOpenConversationSession={
            props.onOpenConversationSession
              ? (message) => {
                  const current = allMessages().find((item) => item.id === message.id && item.groupID === props.groupID)
                  if (!current || history.disposed || (protectedGroup() && (!connected() || state.readerUnavailable)))
                    return
                  props.onOpenConversationSession?.(current)
                }
              : undefined
          }
          selfMemberIDs={props.selfMemberIDs}
          senderNames={props.senderNames}
          onLoadOlder={state.hasMore ? loadOlder : undefined}
          loadingOlder={state.loadingOlder}
        />

        <Show when={othersTyping().length > 0}>
          <div class="px-3 py-1 text-11-regular text-text-weak">{language.t("im.message.typing")}</div>
        </Show>

        <Show when={props.fileUploadEnabled && state.mediaInitializationError}>
          <div role="alert" class="px-3 py-2 flex items-center gap-2 text-12-regular text-text-weak">
            <span>{language.t(`im.media.initialize.${state.mediaInitializationError || "qualification"}`)}</span>
            <Button size="small" variant="ghost" disabled={state.mediaInitializing} onClick={() => initializeMedia()}>
              {language.t("im.media.initialize.retry")}
            </Button>
          </div>
        </Show>
        <Show when={props.fileUploadEnabled && state.mediaFailed}>
          <p role="alert" class="px-3 text-12-regular text-text-weak">
            {language.t("im.media.storageOrTransferFailed")}
          </p>
        </Show>
        <Show when={state.mediaError}>
          <p role="alert" class="px-3 text-12-regular text-text-critical">
            {language.t(`im.media.batch.${state.mediaError || "expired"}`, {
              size: (state.mediaPolicy?.maxAttachmentBytes ?? AttachmentPreview.maxBytes) / (1024 * 1024),
            })}
          </p>
        </Show>
        <Show when={state.uploadProgress && state.sendingAttachment}>
          <div class="px-3 py-2 flex items-center gap-2 text-12-regular" role="status">
            <span>{state.uploadProgress}</span>
            <Button size="small" variant="ghost" onClick={() => uploadAbort?.abort()}>
              {language.t("im.media.batch.cancelUpload")}
            </Button>
          </div>
        </Show>
        <Show when={props.fileUploadEnabled && state.mediaReady}>
          <p class="px-3 text-11-regular text-text-weak">
            {language.t("im.media.batch.limits", {
              count: state.mediaPolicy?.maxAttachments ?? 1,
              size: (state.mediaPolicy?.maxAttachmentBytes ?? AttachmentPreview.maxBytes) / (1024 * 1024),
            })}
          </p>
        </Show>
        <For each={state.mediaBatches}>
          {(batch) => (
            <section
              class="mx-3 my-2 rounded-md border border-border-weaker-base p-2 text-12-regular"
              aria-label={language.t("im.media.batch.draft")}
            >
              <For each={batch.files}>
                {(file) => (
                  <div class="flex items-center justify-between gap-2 min-w-0">
                    <span class="truncate" title={file.attachment.filename}>
                      {AttachmentPreview.displayName(file.attachment.filename)} · {file.attachment.sizeBytes} B
                    </span>
                    <Show when={batch.phase === "draft"}>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={state.sendingAttachment}
                        aria-label={`${language.t("im.media.batch.remove")} ${file.attachment.filename}`}
                        onClick={() => void removeDraftFile(structuredClone(unwrap(batch)), file.intentID)}
                      >
                        {language.t("im.media.batch.remove")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={batch.phase !== "draft"}>
                <p role="status" class="my-1">
                  {language.t(
                    batch.phase === "sending" && state.sendingAttachment
                      ? "im.media.batch.sending"
                      : "im.media.batch.unknown",
                  )}
                </p>
                <Show when={batch.content}>
                  <p class="whitespace-pre-wrap break-words">{batch.content}</p>
                </Show>
                <Button
                  size="small"
                  disabled={state.sendingAttachment}
                  onClick={() => {
                    if (state.sendingAttachment) return
                    const run = mediaGeneration
                    setState("sendingAttachment", true)
                    void sendBatch(structuredClone(unwrap(batch)))
                      .catch(() => {
                        if (!history.disposed && run === mediaGeneration) setState("mediaFailed", true)
                      })
                      .finally(() => {
                        if (!history.disposed && run === mediaGeneration) setState("sendingAttachment", false)
                      })
                  }}
                >
                  {language.t("im.media.retry")}
                </Button>
              </Show>
            </section>
          )}
        </For>
        <Show
          when={
            mediaDraft() &&
            !state.mediaPolicy?.enabled &&
            ((mediaDraft()?.files.length ?? 0) > 1 || props.drafts(props.groupID).state.content !== "")
          }
        >
          <p role="status" class="px-3 text-12-regular text-text-weak">
            {language.t("im.media.batch.multipleUnavailable")}
          </p>
        </Show>
        <For each={state.mediaRecords}>
          {(pending) => (
            <div class="px-3 py-2 flex flex-wrap items-center gap-2 text-12-regular">
              <span class="break-all">
                {AttachmentPreview.displayName(pending.file.name)} ·{" "}
                {language.t(`im.media.phase.${MediaIntent.observedPhase(pending)}`)}
              </span>
              <Show when={["uploaded_unbound", "sending", "send_outcome_unknown"].includes(pending.phase)}>
                <Button
                  size="small"
                  disabled={state.sendingAttachment}
                  onClick={() => {
                    if (state.sendingAttachment) return
                    setState("sendingAttachment", true)
                    const run = mediaGeneration
                    void sendAttachment(structuredClone(unwrap(pending)))
                      .catch(() => {
                        if (!history.disposed && run === mediaGeneration) setState("mediaFailed", true)
                      })
                      .finally(() => {
                        if (!history.disposed && run === mediaGeneration) setState("sendingAttachment", false)
                      })
                  }}
                >
                  {language.t("im.media.retry")}
                </Button>
              </Show>
              <Button
                size="small"
                variant="ghost"
                disabled={state.sendingAttachment}
                onClick={() => {
                  void mediaStore
                    ?.discard(structuredClone(unwrap(pending)))
                    .then(reloadMedia)
                    .catch(() => setState("mediaFailed", true))
                }}
              >
                {language.t("im.media.discard")}
              </Button>
            </div>
          )}
        </For>
        <MessageComposer
          draft={props.drafts(props.groupID)}
          onSend={handleSendMessage}
          onDac={props.onDac}
          onTyping={handleTyping}
          agents={agents()}
          onAttach={props.fileUploadEnabled && state.mediaReady && !state.sendingAttachment ? handleAttach : undefined}
          attachmentBusy={state.sendingAttachment}
          hasAttachments={!!mediaDraft()}
          attachmentLimit={4 - (mediaDraft()?.files.length ?? 0)}
          sendDisabled={
            !!mediaDraft() &&
            !state.mediaPolicy?.enabled &&
            ((mediaDraft()?.files.length ?? 0) > 1 || props.drafts(props.groupID).state.content !== "")
          }
        />
      </div>

      {/* §B3 thread — an overlay panel for the selected message's reply chain. */}
      <Show when={threadRoot()}>
        {(root) => (
          <ThreadView
            mediaEnabled={props.fileUploadEnabled}
            displayEpoch={reader.epoch}
            onReaderInvalidated={() => invalidate()}
            groupID={props.groupID}
            root={root()}
            agents={agents()}
            selfMemberIDs={props.selfMemberIDs}
            senderNames={props.senderNames}
            drafts={props.drafts}
            onClose={() => setThreadRoot(null)}
          />
        )}
      </Show>
    </Show>
  )
}
