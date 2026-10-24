import {
  For,
  Show,
  createSignal,
  createMemo,
  createEffect,
  createResource,
  untrack,
  onCleanup,
  onMount,
} from "solid-js"
import { createStore } from "solid-js/store"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { Locale } from "../util/locale"
import { DialogIMForm, type IMFormField } from "./dialog-im-form"
import { DialogIMMedia } from "./dialog-im-media"
import { DialogIMDac } from "./dialog-im-dac"
import { DialogIMModel } from "./dialog-im-model"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"
import { DialogIMDevice } from "./dialog-im-device"
import { DialogIMActivation } from "./dialog-im-activation"
import { createIMActivation } from "./im-activation"
import { createIMDacDraft, imDacText, type IMDacDraftSnapshot } from "./im-dac-draft"
import { useDialog } from "../ui/dialog"
import { useOptionalRoute } from "../context/route"
import { createIMDacSessionReturn } from "../util/im-dac-session-return"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { imErrorText } from "./im-errors"
import {
  createIMClient,
  openIMGroupSocket,
  mergeIMMessages,
  recoverIMMessages,
  IMRequestError,
  type IMClient,
  type IMFacadeStatus,
  type IMGroup,
  type IMMessage,
  type IMRemoteAttachmentRef,
  type IMMessagePage,
  type IMReadResult,
  type IMSDK,
  type IMDacBinding,
  type IMDacCommand,
} from "./im-client"

type Form = {
  title: string
  description?: string
  fields: IMFormField[]
  submit: (values: string[], active: () => boolean) => Promise<void>
}

function requireName(raw: string) {
  const result = validateIMName(raw)
  if (!result.ok) throw new IMRequestError("im_invalid_name", "Invalid IM name")
  return result.name
}

type IMChatRestore = { groupID: string; draft: string; oldestID?: string; scrollTop: number; dac?: IMDacDraftSnapshot }

export function DialogIM(props: { restore?: IMChatRestore } = {}) {
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const compact = () => dimensions().height <= 24
  const client = createIMClient(sdk)
  const route = useOptionalRoute()
  const dialog = useDialog()
  const sourceRoute = route ? { ...route.data } : undefined
  const restoreScope = client.scope()
  const [pendingRestore, setPendingRestore] = createSignal(props.restore)
  const [status, setStatus] = createSignal<IMFacadeStatus>()
  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [form, setForm] = createSignal<Form>()
  const [modelOpen, setModelOpen] = createSignal(false)
  const [deviceOpen, setDeviceOpen] = createSignal(false)
  const [activationOpen, setActivationOpen] = createSignal<"activate" | "query">()
  const [chat, setChat] = createSignal<IMGroup>()
  const [selectedID, setSelectedID] = createSignal<string>()
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
  const [view, setView] = createStore({ readerUnavailable: false })
  let disposed = false
  const activation = createIMActivation({ client, current: () => !disposed })
  const deviceClient = sdk.client
  const deviceCurrent = () =>
    !disposed && client.dacAvailable() && client.scope() === restoreScope && sdk.client === deviceClient
  const device = IMDeviceClient.create({
    client: deviceClient as unknown as IMDeviceClient.Transport,
    current: deviceCurrent,
  })
  const [deviceStatus, deviceActions] = createResource(
    () => (activationOpen() === "activate" && deviceCurrent() ? restoreScope : undefined),
    async () => {
      const info = await device.info().catch(() => undefined)
      if (!info) return { ready: false }
      const pending = await device.pending().catch(() => undefined)
      return {
        ready:
          pending !== undefined &&
          (!pending || pending.state === "rejected" || (pending.state === "succeeded" && pending.credentialStored)),
      }
    },
  )
  const refresh = { generation: 0, active: false, abort: new AbortController() }
  const clearProtected = (supersede = false) => {
    if (supersede) {
      refresh.generation++
      refresh.abort.abort()
      refresh.abort = new AbortController()
      refresh.active = false
      observations.ordinary.generation++
      setPaging("ordinary", "busy", false)
      setBusy(false)
    }
    observations.protected.generation++
    observations.detail.generation++
    observations.detail.active = false
    observations.deadline = Infinity
    if (observations.timer) clearTimeout(observations.timer)
    setPaging("protected", { cursor: null, more: false, busy: false, failed: false, appended: false })
    setGroups((rows) => rows.filter((row) => !row.reader && !row.kernelConvID))
    setView("readerUnavailable", true)
    setForm(undefined)
  }
  onCleanup(() => {
    disposed = true
    activation.dispose()
    refresh.abort.abort()
    if (observations.timer) clearTimeout(observations.timer)
    if (observations.detailTimer) clearTimeout(observations.detailTimer)
  })

  const loadLane = async (lane: "ordinary" | "protected", append = false) => {
    if (disposed || paging[lane].busy || (append && !paging[lane].more)) return
    const generation = refresh.generation
    const laneGeneration = observations[lane].generation
    const scope = client.scope()
    const cursor = append ? (paging[lane].cursor ?? undefined) : undefined
    const current = () =>
      !disposed &&
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
        throw new IMRequestError("invalid_response", "Invalid conversation page")
      if (page.reader && status()?.reader?.displayEpoch && page.reader.displayEpoch !== status()?.reader?.displayEpoch)
        throw new IMRequestError("reader_stale", "Conversation scope changed")
      if (lane === "protected" && page.reader?.nextExpiryAt !== null && page.reader?.nextExpiryAt !== undefined) {
        observations.deadline = Math.min(
          observations.deadline,
          started + page.reader.nextExpiryAt - page.reader.validatedServerNow!,
        )
        if (observations.timer) clearTimeout(observations.timer)
        observations.timer = setTimeout(
          () => clearProtected(true),
          Math.max(0, observations.deadline - performance.now()),
        )
      }
      setGroups((prior) => [...new Map([...prior, ...page.groups].map((row) => [row.id, row])).values()])
      if (append || !paging[lane].appended) setPaging(lane, { cursor: page.nextCursor, more: page.hasMore })
      setPaging(lane, { failed: false, ...(append ? { appended: true } : {}) })
    } catch (error) {
      if (!current()) return
      if (lane === "protected") setGroups((rows) => rows.filter((row) => !row.reader && !row.kernelConvID))
      setPaging(lane, "failed", true)
      setFailure(imErrorText(error, i18n))
    } finally {
      if (current()) setPaging(lane, "busy", false)
    }
  }
  const loadSelected = async () => {
    const id = selectedID()
    if (!id || disposed || observations.detail.active) return
    const generation = observations.detail.generation
    const rootGeneration = refresh.generation
    const scope = client.scope()
    const current = () =>
      !disposed &&
      observations.detail.generation === generation &&
      refresh.generation === rootGeneration &&
      selectedID() === id &&
      client.scope() === scope
    observations.detail.active = true
    const started = performance.now()
    try {
      const detail = await client.getGroup(id, AbortSignal.any([refresh.abort.signal, AbortSignal.timeout(10_000)]))
      if (!current()) return
      if (
        detail.group.id !== id ||
        (detail.reader &&
          status()?.reader?.displayEpoch &&
          detail.reader.displayEpoch !== status()?.reader?.displayEpoch)
      )
        throw new IMRequestError("reader_stale", "Conversation scope changed")
      if (observations.detailTimer) clearTimeout(observations.detailTimer)
      if (detail.reader?.nextExpiryAt !== null && detail.reader?.nextExpiryAt !== undefined)
        observations.detailTimer = setTimeout(
          () => {
            if (current()) setView("readerUnavailable", true)
          },
          Math.max(0, started + detail.reader.nextExpiryAt - detail.reader.validatedServerNow! - performance.now()),
        )
      setChat(detail.group)
      setGroups((rows) => rows.map((group) => (group.id === id ? detail.group : group)))
      setView("readerUnavailable", false)
    } catch (error) {
      if (current()) {
        setView("readerUnavailable", true)
        setFailure(imErrorText(error, i18n))
      }
    } finally {
      if (current()) observations.detail.active = false
    }
  }
  const reload = async (reset = false) => {
    if (busy() || refresh.active) return
    if (reset) for (const lane of ["ordinary", "protected"] as const) setPaging(lane, "appended", false)
    refresh.active = true
    const generation = refresh.generation
    const scope = client.scope()
    const current = () => !disposed && generation === refresh.generation && client.scope() === scope
    const signal = AbortSignal.any([refresh.abort.signal, AbortSignal.timeout(10_000)])
    const observed = client
      .facadeStatus(signal)
      .then((snapshot) => {
        if (!current()) return
        if (
          (status()?.reader?.displayEpoch && status()?.reader?.displayEpoch !== snapshot.reader?.displayEpoch) ||
          snapshot.reader?.state === "unavailable" ||
          (!!snapshot.reader && snapshot.kernel !== "connected")
        )
          clearProtected()
        setStatus(snapshot)
        return snapshot
      })
      .catch((error: unknown) => {
        if (current()) {
          clearProtected()
          setFailure(imErrorText(error, i18n))
        }
      })
    await Promise.all([
      observed,
      loadLane("ordinary"),
      observed.then((snapshot) => {
        if (!current()) return
        if (snapshot?.facade === "disabled" && snapshot.reader === null) {
          clearProtected(false)
          setView("readerUnavailable", false)
          return
        }
        return loadLane("protected")
      }),
      observed.then(() => {
        if (current()) return loadSelected()
      }),
    ]).finally(() => {
      if (current()) {
        refresh.active = false
        if (!paging.ordinary.failed && !paging.protected.failed) setFailure("")
      }
    })
  }
  createEffect(() => {
    selectedID()
    observations.detail.generation++
    observations.detail.active = false
    if (observations.detailTimer) clearTimeout(observations.detailTimer)
    untrack(() => {
      if (selectedID()) void loadSelected()
    })
  })
  createEffect(() => {
    client.scope()
    if (client.scope() !== restoreScope) setPendingRestore(undefined)
    refresh.generation++
    refresh.abort.abort()
    refresh.abort = new AbortController()
    refresh.active = false
    setBusy(false)
    setGroups([])
    for (const lane of ["ordinary", "protected"] as const) {
      observations[lane].generation++
      setPaging(lane, { cursor: null, more: false, busy: false, failed: false, appended: false })
    }
    observations.deadline = Infinity
    if (observations.timer) clearTimeout(observations.timer)
    setSelectedID(undefined)
    setChat(undefined)
    setStatus(undefined)
    setForm(undefined)
    setModelOpen(false)
    setActivationOpen(undefined)
    void untrack(reload)
  })
  onMount(() => {
    if (props.restore && client.scope() === restoreScope) setSelectedID(props.restore.groupID)
    const timer = setInterval(() => {
      void reload()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const done = async () => {
    if (disposed) return
    setForm(undefined)
    await reload()
  }
  const open = (group: IMGroup) => {
    if (disposed) return
    setForm(undefined)
    setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)])
    setSelectedID(group.id)
  }

  const nameForm = (title: string, submit: (name: string) => Promise<unknown>, value?: string) =>
    setForm({
      title,
      description: i18n.t("tui.im.nameHint"),
      fields: [{ label: i18n.t("tui.im.name"), value }],
      submit: async (values, active) => {
        await submit(requireName(values[0]))
        if (active()) await done()
      },
    })

  const find = () => {
    const resolved = createSignal<{ uuid: string; name: string }>()
    setForm({
      title: i18n.t("tui.im.find"),
      get description() {
        return resolved[0]() ? i18n.t("tui.im.resolved", resolved[0]()) : i18n.t("tui.im.nameHint")
      },
      fields: [{ label: i18n.t("tui.im.name") }],
      submit: async (values, active) => {
        const name = requireName(values[0])
        if (!resolved[0]() || resolved[0]()!.name !== name) {
          const result = await client.facadeResolve(name)
          if (active()) resolved[1](result)
          return
        }
        const group = await client.facadeOpenDirect(name)
        if (active()) open(group)
      },
    })
  }

  const createGroup = () =>
    setForm({
      title: i18n.t("tui.im.newGroupTitle"),
      description: i18n.t("tui.im.nameHint"),
      fields: [{ label: i18n.t("tui.im.name") }, { label: i18n.t("tui.im.members") }],
      submit: async (values, active) => {
        const group = await client.facadeCreateGroup(requireName(values[0]), [
          ...new Set(
            values[1]
              .split(/[,，\s]+/)
              .filter(Boolean)
              .map(requireName),
          ),
        ])
        if (active()) open(group)
      },
    })

  const options = () => [
    ...groups().map((group) => ({
      title: `${group.kernelConvID?.startsWith("k:1:") || (group.reader && group.type === "direct") ? "@ " : "# "}${group.name}`,
      value: `chat:${group.id}`,
      category:
        group.kernelConvID === `k:2:${status()?.identity?.orgAllGroupID}`
          ? i18n.t("tui.im.allGroup")
          : group.kernelConvID?.startsWith("k:1:") || (group.reader && group.type === "direct")
            ? i18n.t("tui.im.humanDirect")
            : group.kernelConvID
              ? i18n.t("tui.im.kernelGroup")
              : i18n.t("tui.im.local"),
      footer: group.reader
        ? group.reader.state === "pending" && compact()
          ? undefined
          : group.reader.state === "pending"
            ? i18n.t("tui.im.reader.pending")
            : `${i18n.t("tui.im.reader.unread")}: ${group.reader.liveUnread ?? "—"}`
        : Locale.time(group.updatedAt),
      details: group.reader?.state === "pending" && compact() ? [i18n.t("tui.im.reader.pending")] : undefined,
    })),
    ...(status()?.identity
      ? [{ title: i18n.t("tui.im.rename"), value: "rename", category: i18n.t("tui.im.identity") }]
      : []),
    ...(status() && status()?.facade !== "disabled"
      ? [{ title: i18n.t("tui.im.retry"), value: "retry", category: i18n.t("tui.im.identity") }]
      : []),
    ...(status()?.facade === "active"
      ? [
          { title: i18n.t("tui.im.find"), value: "find", category: "IM" },
          { title: i18n.t("tui.im.newGroup"), value: "group", category: "IM" },
        ]
      : []),
    { title: i18n.t("tui.im.localGroup"), value: "local", category: i18n.t("tui.im.local") },
    { title: i18n.t("tui.im.device.title"), value: "im-device", category: "IM", disabled: !client.dacAvailable() },
    { title: i18n.t("tui.im.model.title"), value: "im-model", category: "IM", disabled: !client.dacAvailable() },
    {
      title: i18n.t("tui.im.activation.title"),
      value: "im-activate",
      category: "IM",
      disabled: !client.dacAvailable() || status()?.blocked?.code === "im_device_store_unavailable",
    },
    {
      title: i18n.t("tui.im.activation.resume"),
      value: "im-activation-status",
      category: "IM",
      disabled: !client.dacAvailable(),
    },
    { title: i18n.t("tui.im.refresh"), value: "refresh", category: "IM" },
    ...(["ordinary", "protected"] as const).flatMap((lane) =>
      paging[lane].more
        ? [
            {
              title: i18n.t(lane === "ordinary" ? "tui.im.reader.moreOrdinary" : "tui.im.reader.moreProtected"),
              value: `more:${lane}`,
              category: "IM",
              disabled: paging[lane].busy,
            },
          ]
        : [],
    ),
  ]

  const activationRequired = () =>
    status()?.facade === "claim_required" ||
    ["activation_required", "im_activation_required"].includes(status()?.blocked?.code ?? "")
  const statusNotice = () =>
    failure() ||
    (activationRequired()
      ? i18n.t("tui.im.activation.notice")
      : status()?.blocked
        ? imErrorText(new IMRequestError(status()!.blocked!.code, ""), i18n)
        : status()?.recovery?.status === "failed"
          ? i18n.t("tui.im.recoveryFailed")
          : status()?.recovery?.status === "pending"
            ? i18n.t("tui.im.recoveryPending")
            : i18n.t("tui.im.reader.listObserved"))

  const openDacSession = (sessionID: string, restore: IMChatRestore | undefined, captured = client.scope()) => {
    const sameOwner = () => !captured.signal?.aborted && client.scope() === captured && sdk.client === captured.client
    if (!route || !sourceRoute || !sameOwner()) return
    route.openIMDacSession(
      sessionID,
      createIMDacSessionReturn({
        sessionID,
        current: sameOwner,
        restore: () => {
          route.navigate(sourceRoute)
          dialog.replace(() => <DialogIM restore={restore} />)
        },
      }),
    )
    dialog.clear()
  }
  const select = (value: string) => {
    if (busy()) return
    if (value === "im-device") {
      setDeviceOpen(true)
      return
    }
    if (value === "im-model") {
      setModelOpen(true)
      return
    }
    if (value === "im-activate" || value === "im-activation-status") {
      setActivationOpen(value === "im-activate" ? "activate" : "query")
      return
    }
    if (value.startsWith("chat:")) {
      setSelectedID(value.slice(5))
      return
    }
    if (value === "more:ordinary" || value === "more:protected") {
      void loadLane(value === "more:ordinary" ? "ordinary" : "protected", true)
      return
    }
    if (value === "rename") {
      nameForm(i18n.t("tui.im.rename"), client.facadeRename, status()?.identity?.name)
      return
    }
    if (value === "find") {
      find()
      return
    }
    if (value === "group") {
      createGroup()
      return
    }
    if (value === "refresh") {
      void reload(true)
      return
    }
    if (value === "retry") {
      setBusy(true)
      void client.facadeRetry().then(
        () => {
          if (!disposed) {
            setBusy(false)
            void reload()
          }
        },
        (error: unknown) => {
          if (disposed) return
          setBusy(false)
          setFailure(imErrorText(error, i18n))
        },
      )
      return
    }
    if (value !== "local") return
    setForm({
      title: i18n.t("tui.im.localGroup"),
      fields: [{ label: i18n.t("tui.im.name") }],
      submit: async (values, active) => {
        const name = values[0].trim()
        if (!name) throw new IMRequestError("invalid_request", "Empty name")
        const group = await client.createGroup({ name, type: "project" })
        if (active()) open(group)
      },
    })
  }

  return (
    <box>
      <Show
        when={!deviceOpen()}
        fallback={
          <DialogIMDevice
            client={deviceClient as unknown as IMDeviceClient.Transport}
            current={deviceCurrent}
            back={() => {
              setDeviceOpen(false)
              void Promise.resolve(deviceActions.refetch()).catch(() => undefined)
              void reload()
            }}
          />
        }
      >
        <Show
          when={!activationOpen()}
          fallback={
            <Show
              when={activationOpen() === "query" || deviceStatus()?.ready}
              fallback={
                <Show when={!deviceStatus.loading} fallback={<text>{i18n.t("tui.im.loading")}</text>}>
                  <DialogIMDevice
                    client={deviceClient as unknown as IMDeviceClient.Transport}
                    current={deviceCurrent}
                    back={() => {
                      setActivationOpen(undefined)
                      void reload()
                    }}
                  />
                </Show>
              }
            >
              <DialogIMActivation
                flow={activation}
                queryOnly={activationOpen() === "query"}
                back={() => {
                  setActivationOpen(undefined)
                  void reload()
                }}
              />
            </Show>
          }
        >
          <Show when={!modelOpen()} fallback={<DialogIMModel client={client} back={() => setModelOpen(false)} />}>
            <Show
              when={chat()}
              fallback={
                <Show
                  when={form()}
                  fallback={
                    <DialogSelect
                      title={i18n.t("tui.im.title")}
                      titleView={
                        <box flexGrow={1} flexShrink={1} minWidth={0} maxWidth={Math.max(8, dimensions().width - 12)}>
                          <text fg={theme.text} wrapMode={compact() ? "none" : "word"}>
                            {i18n.t("tui.im.title")} ·{" "}
                            {busy()
                              ? i18n.t("tui.im.loading")
                              : status()
                                ? i18n.t(
                                    activationRequired() ? "tui.im.activation.title" : `tui.im.${status()!.facade}`,
                                  )
                                : ""}
                            <Show when={compact() && status()?.kernel}>
                              {` · ${i18n.t("tui.im.connection", { state: i18n.t(`tui.im.${status()!.kernel!}`) })}`}
                            </Show>
                          </text>
                          <Show when={status()?.identity}>
                            {(identity) => (
                              <text fg={theme.textMuted} wrapMode={compact() ? "none" : "word"}>
                                {identity().name} · {identity().uuid} · org {identity().orgID}
                              </text>
                            )}
                          </Show>
                          <Show when={!compact() && status()?.kernel}>
                            <text fg={theme.textMuted}>
                              {i18n.t("tui.im.connection", { state: i18n.t(`tui.im.${status()!.kernel!}`) })}
                            </text>
                          </Show>
                          <Show when={!compact() && status()?.recovery?.status === "pending"}>
                            <text fg={theme.textMuted}>{i18n.t("tui.im.recoveryPending")}</text>
                          </Show>
                          <Show when={!compact() && status()?.recovery?.status === "failed"}>
                            <text fg={theme.error}>{i18n.t("tui.im.recoveryFailed")}</text>
                          </Show>
                          <Show when={!compact() && status()?.blocked}>
                            <text fg={theme.error}>
                              {imErrorText(new IMRequestError(status()!.blocked!.code, ""), i18n)}
                            </text>
                          </Show>
                          <Show
                            when={compact()}
                            fallback={<text fg={theme.textMuted}>{i18n.t("tui.im.reader.listObserved")}</text>}
                          >
                            <text
                              fg={
                                failure() || status()?.blocked || status()?.recovery?.status === "failed"
                                  ? theme.error
                                  : theme.textMuted
                              }
                              wrapMode="none"
                            >
                              {statusNotice()}
                            </text>
                          </Show>
                          <Show when={!compact() && failure()}>
                            <text fg={theme.error}>{failure()}</text>
                          </Show>
                        </box>
                      }
                      locked={busy()}
                      options={options()}
                      onSelect={(option) => select(option.value)}
                    />
                  }
                >
                  {(active) => <DialogIMForm {...active()} back={() => setForm(undefined)} />}
                </Show>
              }
            >
              {(group) => (
                <DialogIMChat
                  client={client}
                  sdk={sdk}
                  group={group()}
                  metadataRefreshed={loadSelected}
                  displayEpoch={status()?.reader?.displayEpoch}
                  readerUnavailable={view.readerUnavailable}
                  invalidated={() => {
                    clearProtected(true)
                    void reload()
                  }}
                  identity={status()?.viewer?.memberID ?? status()?.identity?.uuid}
                  selfMemberIDs={[status()?.viewer?.memberID, status()?.identity?.uuid].filter(
                    (value): value is string => typeof value === "string",
                  )}
                  restore={pendingRestore()?.groupID === group().id ? pendingRestore() : undefined}
                  restored={() => setPendingRestore(undefined)}
                  openSession={
                    route && sourceRoute
                      ? (pointer, restore) => {
                          if (disposed) return
                          if (pointer.sessionID) openDacSession(pointer.sessionID, restore)
                        }
                      : undefined
                  }
                  back={(restore) => {
                    setPendingRestore(restore)
                    setSelectedID(undefined)
                    setChat(undefined)
                    void reload()
                  }}
                />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

type DialogIMChatProps = {
  client: IMClient
  sdk: IMSDK
  group: IMGroup
  displayEpoch?: string
  invalidated?: () => void
  metadataRefreshed?: () => Promise<void>
  readerUnavailable?: boolean
  identity?: string
  selfMemberIDs?: readonly string[]
  back: (restore: IMChatRestore) => void
  restore?: IMChatRestore
  restored?: () => void
  ownerCurrent?: () => boolean
  openSession?: (pointer: IMDacBinding, restore: IMChatRestore) => void
}

export function DialogIMChat(props: DialogIMChatProps) {
  const target = createMemo(
    () => ({
      groupID: props.group.id,
      identity: props.identity,
      epoch: props.displayEpoch,
      scope: props.client.scope(),
      client: props.client,
    }),
    undefined,
    {
      equals: (a, b) =>
        a?.groupID === b.groupID &&
        a?.identity === b.identity &&
        a?.epoch === b.epoch &&
        a?.scope === b.scope &&
        a?.client === b.client,
    },
  )
  return (
    <Show when={target()} keyed>
      {(captured) => {
        const client = createIMClient(props.sdk, captured.scope)
        return (
          <IMChatConversation
            {...props}
            client={client}
            ownerCurrent={() =>
              (props.ownerCurrent?.() ?? true) &&
              props.client === captured.client &&
              props.client.scope() === captured.scope
            }
          />
        )
      }}
    </Show>
  )
}

function IMChatConversation(props: DialogIMChatProps) {
  const restore = props.restore
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  let transcript: ScrollBoxRenderable | undefined
  const [dacOpen, setDacOpen] = createSignal(false)
  const [recentCommands, setRecentCommands] = createSignal<IMDacCommand[]>([])
  const [messages, setMessages] = createSignal<IMMessage[]>([])
  const [connection, setConnection] = createSignal("connecting" as "connecting" | "connected" | "disconnected")
  const [metadataInvalidated, setMetadataInvalidated] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [hasMore, setHasMore] = createSignal(false)
  const [form, setForm] = createSignal<Form>()
  const [draft, setDraft] = createSignal(restore?.draft ?? "")
  const requests = new AbortController()
  const [observation, setObservation] = createStore({
    refreshing: false,
    readerUnavailable: !!props.group.reader || !!props.group.kernelConvID,
    readBusy: false,
    newActionRequired: false,
    checkedActionID: "",
    checkedState: undefined as IMReadResult["reader"],
    readPrepared: false,
    readReached: false,
    readResult: undefined as IMReadResult["reader"],
  })
  const reader = {
    generation: 0,
    flight: false,
    epoch: props.displayEpoch ?? "",
    deadline: Infinity,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    actionID: undefined as string | undefined,
    readFlight: false,
    finishedActionID: undefined as string | undefined,
    supersededActions: new Set<string>(),
  }
  const protectedGroup = () => !!props.group.reader || !!props.group.kernelConvID
  const unresolvedActions = createMemo(() => props.group.reader?.unresolvedReadActions ?? [])
  const currentUnknownListed = () =>
    observation.readResult?.state === "unknown" &&
    unresolvedActions().some((action) => action.actionID === observation.readResult?.actionID)
  const currentReadVisible = () =>
    (!unresolvedActions().length && !observation.newActionRequired) ||
    observation.readPrepared ||
    observation.readResult?.state === "partial" ||
    (observation.readResult?.state === "unknown" && !currentUnknownListed())
  const newReadAvailable = () => {
    const current = props.group.reader
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
      observation.readPrepared ||
      observation.readResult?.state === "partial" ||
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
    const action = props.group.reader?.readAction
    untrack(() => {
      if (
        !action ||
        reader.readFlight ||
        (reader.finishedActionID === action.actionID && observation.readResult?.actionID === action.actionID) ||
        reader.supersededActions.has(action.actionID)
      )
        return
      if (reader.actionID && reader.actionID !== action.actionID) return
      if ((action.phase === "confirmed" && action.targetReached) || action.phase === "cancelled") {
        reader.finishedActionID = action.actionID
        reader.actionID = undefined
        setObservation({
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
      setObservation({
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
  createEffect(() => {
    const group = props.group
    const unavailable = props.readerUnavailable
    if (!unavailable && group.reader?.state === "pending") setMetadataInvalidated(false)
  })
  const pendingConversation = () =>
    props.group.reader?.state === "pending" &&
    !!props.displayEpoch &&
    reader.epoch === props.displayEpoch &&
    connection() === "connected" &&
    !props.readerUnavailable &&
    !metadataInvalidated() &&
    (props.ownerCurrent?.() ?? true)
  const invalidate = (epoch?: string, bodyPending = false) => {
    if (disposed || !protectedGroup()) return
    reader.generation++
    if (epoch && epoch !== reader.epoch) reader.actionID = undefined
    if (epoch) reader.epoch = epoch
    reader.deadline = Infinity
    if (reader.timer) clearTimeout(reader.timer)
    setMessages([])
    if (!bodyPending) {
      setMetadataInvalidated(true)
      setDacOpen(false)
      setForm(undefined)
    }
    setCursor(null)
    setHasMore(false)
    setMedia({ open: false, attachmentID: undefined, remote: undefined })
    setObservation({
      readerUnavailable: true,
      readReached: false,
      readBusy: reader.readFlight,
      readResult: reader.actionID
        ? { actionID: reader.actionID, state: "unknown", targetAdmitted: "", readOrdinal: "", liveUnread: "" }
        : undefined,
    })
    setBusy(false)
    if (!bodyPending) props.invalidated?.()
  }
  const acceptPage = (page: IMMessagePage, started: number) => {
    if (!protectedGroup()) return true
    if (connection() !== "connected" || page.protectedUnavailable) {
      invalidate()
      return false
    }
    if (!page.reader) {
      // Validated pending metadata authorizes a private task, never unavailable message bodies.
      invalidate(undefined, pendingConversation() && !page.messages.length && !page.hasMore && page.nextCursor === null)
      return false
    }
    const value = page.reader
    if (props.displayEpoch && props.displayEpoch !== value.displayEpoch) {
      invalidate()
      return false
    }
    if (reader.epoch && reader.epoch !== value.displayEpoch) {
      setMessages([])
      reader.deadline = Infinity
      reader.actionID = undefined
      setObservation("readResult", undefined)
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
    setObservation("readerUnavailable", false)
    setMetadataInvalidated(false)
    return true
  }
  const [media, setMedia] = createStore({
    open: false,
    attachmentID: undefined as string | undefined,
    remote: undefined as IMRemoteAttachmentRef | undefined,
  })
  let disposed = false
  let refreshPending = false
  let pendingSend: { content: string; id: string } | undefined
  onCleanup(() => {
    disposed = true
    requests.abort()
    if (reader.timer) clearTimeout(reader.timer)
  })
  const dacCurrent = () =>
    !disposed &&
    props.client.dacAvailable() &&
    (!observation.readerUnavailable || pendingConversation()) &&
    (props.ownerCurrent?.() ?? true)
  const dac = createIMDacDraft({
    client: props.client,
    groupID: props.group.id,
    current: (): boolean => dacCurrent() && (!dac.state.referenceMessageIDs.length || !observation.readerUnavailable),
    restore: restore?.dac,
  })
  onCleanup(() => dac.dispose())
  const captureReturn = () => ({
    groupID: props.group.id,
    draft: draft(),
    oldestID: messages()[0]?.id,
    scrollTop: transcript?.scrollTop ?? 0,
    dac: dac.snapshot(),
  })
  const beginDac = (message?: IMMessage) => {
    if (!dacCurrent() || !props.openSession || (message && observation.readerUnavailable)) return
    if (message) dac.update({ text: message.type === "text" ? message.content : "", referenceMessageIDs: [message.id] })
    setDacOpen(true)
  }
  const openPersonalSession = async (sessionID: string) => {
    if (!props.openSession || !dacCurrent()) return
    const scope = props.client.scope()
    const binding = await props.client.dacSession(
      props.group.id,
      sessionID,
      AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
      dac.state.command?.state === "admitted" && dac.state.command.sessionID === sessionID
        ? dac.state.command.commandID
        : undefined,
    )
    if (!dacCurrent() || props.client.scope() !== scope) return
    props.openSession(binding, captureReturn())
  }
  let restored = !restore
  const restorePosition = () => {
    if (disposed || restored || !transcript || !messages().length) return
    if (restore?.oldestID && !messages().some((message) => message.id === restore?.oldestID)) return
    transcript.scrollTo(restore?.scrollTop ?? 0)
    restored = true
    renderer.removePostProcessFn(restorePosition)
  }
  if (restore) renderer.addPostProcessFn(restorePosition)
  onCleanup(() => renderer.removePostProcessFn(restorePosition))

  const refreshTransport = async () => {
    if (disposed || observation.refreshing) return
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 10_000)
    const observed = new Map(messages().map((message) => [message.id, message]))
    setObservation("refreshing", true)
    try {
      if (protectedGroup()) {
        await props.client.refreshGroup(props.group.id, AbortSignal.any([requests.signal, abort.signal]))
        if (disposed || abort.signal.aborted || props.ownerCurrent?.() === false) return
        await props.metadataRefreshed?.()
        if (disposed || abort.signal.aborted || props.ownerCurrent?.() === false) return
        await load()
        return
      }
      const page = await props.client.listMessages(
        props.group.id,
        50,
        undefined,
        AbortSignal.any([requests.signal, abort.signal]),
      )
      if (disposed || abort.signal.aborted) return
      setMessages((current) => mergeIMMessages(current, page.messages, "snapshot", observed))
      setFailure("")
    } catch {
      if (!disposed) {
        if (protectedGroup()) invalidate()
        setFailure(i18n.t("tui.im.transport.refreshFailed"))
      }
    } finally {
      clearTimeout(timeout)
      if (!disposed) setObservation("refreshing", false)
    }
  }

  const load = async (older = false) => {
    if (disposed || (protectedGroup() && connection() !== "connected")) return
    if (busy() || reader.flight) {
      if (!older) refreshPending = true
      return
    }
    if (older && !hasMore()) return
    setBusy(true)
    reader.flight = true
    const generation = reader.generation
    const started = performance.now()
    const observed = new Map(messages().map((message) => [message.id, message]))
    const requestedCursor = older ? (cursor() ?? undefined) : undefined
    await (
      older || protectedGroup()
        ? props.client.listMessages(
            props.group.id,
            50,
            requestedCursor,
            AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
          )
        : recoverIMMessages(
            props.client,
            props.group.id,
            messages()[0]?.id ?? restore?.oldestID,
            AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
          )
    )
      .then((page) => {
        if (disposed || generation !== reader.generation || !acceptPage(page, started)) return
        if (
          page.hasMore !== (typeof page.nextCursor === "string" && page.nextCursor.length > 0) ||
          (!page.hasMore && page.nextCursor !== null) ||
          (older && (!requestedCursor || page.nextCursor === requestedCursor))
        )
          throw new IMRequestError("invalid_response", "IM history cursor did not advance")
        setMessages((current) => mergeIMMessages(current, page.messages, "snapshot", observed))
        if (
          restore &&
          (!page.messages.length ||
            (restore.oldestID && !page.messages.some((message) => message.id === restore?.oldestID)))
        ) {
          restored = true
          renderer.removePostProcessFn(restorePosition)
        }
        // A reconnect refresh must not move an already-paged history cursor forward.
        if (older || !cursor()) {
          setCursor(page.nextCursor)
          setHasMore(page.hasMore)
        }
        setFailure("")
        if (!protectedGroup() && !restore) void props.client.markRead(props.group.id).catch(() => undefined)
      })
      .catch((error: unknown) => {
        if (!disposed && generation === reader.generation) {
          if (protectedGroup()) invalidate()
          setFailure(imErrorText(error, i18n))
        }
      })
      .finally(() => {
        reader.flight = false
        if (disposed) return
        setBusy(false)
        if (!refreshPending) return
        refreshPending = false
        void load()
      })
  }

  onMount(() => {
    props.restored?.()
    void load()
    const socket = openIMGroupSocket(props.sdk, props.group.id, {
      protected: protectedGroup(),
      onState: (state) => {
        setConnection(state)
        if (state === "disconnected") invalidate()
      },
      onReaderChanged: (value) => {
        if (reader.epoch && reader.epoch !== value.displayEpoch) invalidate(value.displayEpoch)
        void load()
      },
      onReaderInvalidated: (value) => invalidate(value.displayEpoch),
      onOpen: () => {
        void load()
      },
      onMessage: (message) => {
        if (disposed || protectedGroup() || message.groupID !== props.group.id) return
        const unseen = !messages().some((current) => current.id === message.id)
        setMessages((current) => mergeIMMessages(current, [message], "live"))
        if (unseen && !restore) void props.client.markRead(props.group.id).catch(() => undefined)
      },
      onFailed: (payload) => setFailure(imErrorText(new IMRequestError(payload.code, payload.message), i18n)),
    })
    const timer = setInterval(() => {
      if (protectedGroup()) void load()
    }, 5000)
    onCleanup(() => {
      socket.close()
      clearInterval(timer)
    })
  })

  createEffect(() => {
    if (props.readerUnavailable) untrack(() => invalidate())
  })

  const compose = () =>
    setForm({
      title: props.group.name,
      fields: [
        {
          label: i18n.t("tui.im.send"),
          placeholder: i18n.t("tui.im.messagePlaceholder"),
          value: draft(),
          multiline: true,
          onChange: setDraft,
        },
      ],
      submit: async (values, active) => {
        setDraft(values[0])
        const privateText = imDacText(values[0])
        if (privateText !== undefined) {
          if (!props.client.dacAvailable())
            throw new IMRequestError("dac_local_only", "Personal DAC requires the local connection")
          if (!dac.update({ text: privateText, referenceMessageIDs: [] }))
            throw new IMRequestError("dac_scope_changed", "DAC draft has an unresolved request", 409)
          setDraft("")
          setForm(undefined)
          setDacOpen(true)
          if (!privateText.trim()) return
          const command = await dac.submit()
          if (!disposed && command?.state === "admitted") await openPersonalSession(command.sessionID)
          return
        }
        const content = values[0].trim()
        if (!content) throw new IMRequestError("invalid_request", "Empty message")
        // Keep ambiguous failed sends on the same server receipt. An edited payload or a
        // new successful submission is a new intent, even if its text is later identical.
        if (pendingSend?.content !== content) pendingSend = { content, id: `tui:${crypto.randomUUID()}` }
        const submitted = pendingSend
        const observed = new Map(messages().map((message) => [message.id, message]))
        const message = await props.client.createMessage(props.group.id, { content, clientRequestID: submitted.id })
        if (pendingSend === submitted) pendingSend = undefined
        if (disposed || !active()) return
        if (protectedGroup()) void load()
        else setMessages((current) => mergeIMMessages(current, [message], "receipt", observed))
        setDraft("")
        setForm(undefined)
      },
    })
  const openDac = async () => {
    if (!props.openSession || !dacCurrent()) return
    const scope = props.client.scope()
    try {
      const binding = await props.client.dacBinding(
        props.group.id,
        AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
      )
      if (!dacCurrent() || props.client.scope() !== scope) return
      setRecentCommands([...(binding.recentCommands ?? [])])
      if (binding.recentCommands?.length) {
        const command =
          binding.recentCommands.find((command) => command.commandID === dac.state.commandID) ??
          binding.recentCommands[0]
        if (dac.state.uncertain || dac.state.replyUncertain) await dac.refresh()
        else await dac.inspect(command.commandID)
        if (!dacCurrent() || props.client.scope() !== scope) return
        setDacOpen(true)
        return
      }
      if (!binding.sessionID) {
        beginDac()
        return
      }
      await openPersonalSession(binding.sessionID)
    } catch (error) {
      if (dacCurrent() && props.client.scope() === scope) setFailure(imErrorText(error, i18n))
    }
  }
  const invite = () => {
    if (!(props.group.kernelConvID?.startsWith("k:2:") || (props.group.reader && props.group.type !== "direct"))) return
    setForm({
      title: i18n.t("tui.im.invite"),
      description: i18n.t("tui.im.nameHint"),
      fields: [{ label: i18n.t("tui.im.name") }],
      submit: async (values, active) => {
        await props.client.facadeInvite(props.group.id, requireName(values[0]))
        if (!disposed && active()) setForm(undefined)
      },
    })
  }

  const markProtectedRead = async (
    mode: "current" | "cancel" | "new" | "reconcile" = "current",
    originalID?: string,
  ) => {
    const historical =
      mode === "reconcile" ? unresolvedActions().find((action) => action.actionID === originalID) : undefined
    if (
      (mode === "cancel" && !observation.readPrepared) ||
      (mode === "new" && !newReadAvailable()) ||
      (mode === "reconcile" && !historical) ||
      !protectedGroup() ||
      props.group.reader?.state !== "ready" ||
      observation.readerUnavailable ||
      observation.readBusy ||
      reader.readFlight ||
      connection() !== "connected"
    )
      return
    if (mode === "current" && !reader.actionID && unresolvedActions().length > 0) return
    const epoch = reader.epoch
    const prior = observation.readResult?.state
    const previousID = reader.actionID
    const actionID =
      historical?.actionID ?? (mode === "new" ? undefined : previousID) ?? `tui-read_${crypto.randomUUID()}`
    if (!historical) reader.actionID = actionID
    reader.readFlight = true
    setObservation("readBusy", true)
    if (!historical)
      setObservation({
        readPrepared: false,
        readReached: mode !== "new" && prior === "unknown" && observation.readReached,
      })
    try {
      const result = await props.client.markRead(props.group.id, {
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
        disposed ||
        epoch !== reader.epoch ||
        observation.readerUnavailable ||
        (!historical && reader.actionID !== actionID)
      )
        return
      if (!result.reader || result.reader.actionID !== actionID) throw new Error("reader_action_mismatch")
      if (historical) {
        setObservation({ checkedActionID: actionID, checkedState: result.reader })
        return
      }
      if (mode === "new") {
        reader.supersededActions.clear()
        for (const action of unresolvedActions()) reader.supersededActions.add(action.actionID)
        if (previousID) reader.supersededActions.add(previousID)
      }
      setObservation({ readResult: result.reader, newActionRequired: false })
      if (result.reader.state === "confirmed" || result.reader.state === "cancelled") {
        reader.finishedActionID = actionID
        reader.actionID = undefined
      }
    } catch (error) {
      if (disposed || epoch !== reader.epoch) return
      if (
        error instanceof IMRequestError &&
        error.code === "reader_unknown" &&
        !historical &&
        mode === "current" &&
        !previousID
      ) {
        reader.actionID = undefined
        setObservation({ newActionRequired: true, readResult: undefined })
        return
      }
      if (historical || reader.actionID === actionID) invalidate()
    } finally {
      reader.readFlight = false
      if (!disposed) setObservation("readBusy", false)
    }
  }

  useBindings(() => ({
    enabled: !form() && !media.open && !dacOpen(),
    priority: 1,
    bindings: [
      { key: "ctrl+s", cmd: compose },
      { key: "ctrl+t", cmd: () => beginDac() },
      { key: "ctrl+o", cmd: () => void openDac() },
      {
        key: "ctrl+j",
        cmd: () => beginDac(),
      },
      {
        key: "ctrl+u",
        cmd: () => {
          if (!protectedGroup() || props.group.reader?.state === "ready")
            setMedia({ open: true, attachmentID: undefined, remote: undefined })
        },
      },
      {
        key: "ctrl+k",
        cmd: () => {
          void markProtectedRead()
        },
      },
      {
        key: "ctrl+x",
        cmd: () => {
          if (observation.readPrepared) void markProtectedRead("cancel")
        },
      },
      {
        key: "ctrl+n",
        cmd: () => {
          void markProtectedRead("new")
        },
      },
      ...unresolvedActions().map((action, index) => ({
        key: `alt+${index + 1}`,
        cmd: () => {
          void markProtectedRead("reconcile", action.actionID)
        },
      })),
      { key: "ctrl+g", cmd: invite },
      {
        key: "ctrl+r",
        cmd: () => {
          void refreshTransport()
        },
      },
      {
        key: "ctrl+p",
        cmd: () => {
          void load(true)
        },
      },
      { key: "escape", cmd: () => props.back(captureReturn()) },
    ],
  }))

  return (
    <box>
      <Show
        when={dacOpen()}
        fallback={
          <box>
            <Show
              when={media.open}
              fallback={
                <Show
                  when={form()}
                  fallback={
                    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
                      <text fg={theme.text}>
                        {observation.readerUnavailable ? i18n.t("tui.im.title") : props.group.name} ·{" "}
                        {i18n.t("tui.im.connection", { state: i18n.t(`tui.im.${connection()}`) })}
                      </text>
                      <Show when={protectedGroup()}>
                        <text fg={theme.textMuted}>
                          {i18n.t(
                            props.group.reader?.state === "pending"
                              ? "tui.im.reader.pending"
                              : observation.readerUnavailable
                                ? "tui.im.reader.unavailable"
                                : "tui.im.reader.ready",
                          )}
                        </text>
                        <Show
                          when={
                            props.group.reader?.state === "ready" &&
                            !observation.readerUnavailable &&
                            currentReadVisible()
                          }
                        >
                          <text fg={theme.primary} wrapMode="word" onMouseUp={() => void markProtectedRead()}>
                            {i18n.t(
                              observation.readPrepared
                                ? "tui.im.reader.resume"
                                : observation.readResult?.state === "unknown"
                                  ? "tui.im.reader.reconcile"
                                  : observation.readResult?.state === "partial"
                                    ? "tui.im.reader.continue"
                                    : "tui.im.reader.markRead",
                            )}{" "}
                            (Ctrl+K)
                          </text>
                        </Show>
                        <Show when={observation.readPrepared && !observation.readerUnavailable}>
                          <text fg={theme.primary} wrapMode="word" onMouseUp={() => void markProtectedRead("cancel")}>
                            {i18n.t("tui.im.reader.cancel")} (Ctrl+X)
                          </text>
                        </Show>
                        <Show when={newReadAvailable() && !observation.readerUnavailable}>
                          <text fg={theme.primary} wrapMode="word" onMouseUp={() => void markProtectedRead("new")}>
                            {i18n.t("tui.im.reader.newAction")} (Ctrl+N)
                          </text>
                        </Show>
                        <Show when={observation.newActionRequired}>
                          <text fg={theme.textMuted} wrapMode="word">
                            {i18n.t("tui.im.reader.newActionRequired")}
                          </text>
                        </Show>
                        <Show when={!observation.readerUnavailable && unresolvedActions().length > 0}>
                          <text fg={theme.textMuted}>{i18n.t("tui.im.reader.unresolved")}</text>
                          <scrollbox maxHeight={8} verticalScrollbarOptions={{ visible: true }}>
                            <For each={unresolvedActions()}>
                              {(action, index) => (
                                <box>
                                  <text fg={theme.textMuted} wrapMode="word">
                                    {i18n.t(
                                      action.targetReached
                                        ? "tui.im.reader.targetReachedUnknown"
                                        : "tui.im.reader.unknown",
                                    )}
                                  </text>
                                  <text fg={theme.textMuted} wrapMode="word">
                                    {action.actionID}
                                  </text>
                                  <Show when={!observation.readerUnavailable}>
                                    <text
                                      fg={theme.primary}
                                      wrapMode="word"
                                      onMouseUp={() => void markProtectedRead("reconcile", action.actionID)}
                                    >
                                      {i18n.t("tui.im.reader.checkAction")} (Alt+{index() + 1})
                                    </text>
                                  </Show>
                                  <Show
                                    when={observation.checkedActionID === action.actionID && observation.checkedState}
                                  >
                                    <text fg={theme.textMuted} wrapMode="word">
                                      {i18n.t(
                                        observation.checkedState?.state === "unknown"
                                          ? "tui.im.reader.stillUnknown"
                                          : `tui.im.reader.${observation.checkedState?.state ?? "unknown"}`,
                                      )}
                                    </text>
                                  </Show>
                                </box>
                              )}
                            </For>
                          </scrollbox>
                        </Show>
                        <Show when={observation.readReached && !currentUnknownListed()}>
                          <text fg={theme.textMuted} wrapMode="word">
                            {i18n.t(
                              observation.readResult?.state === "unknown"
                                ? "tui.im.reader.targetReachedUnknown"
                                : "tui.im.reader.targetReached",
                            )}
                          </text>
                        </Show>
                        <Show
                          when={
                            observation.readResult &&
                            !currentUnknownListed() &&
                            !(observation.readReached && observation.readResult?.state === "unknown")
                              ? observation.readResult
                              : undefined
                          }
                        >
                          {(result) => (
                            <text fg={theme.textMuted} wrapMode="word">
                              {i18n.t(`tui.im.reader.${result().state}`)}
                            </text>
                          )}
                        </Show>
                      </Show>
                      <scrollbox
                        ref={(value: ScrollBoxRenderable) => (transcript = value)}
                        maxHeight={Math.min(14, Math.max(3, dimensions().height - 20))}
                        stickyScroll
                        stickyStart="bottom"
                        verticalScrollbarOptions={{ visible: true }}
                        horizontalScrollbarOptions={{ visible: false }}
                      >
                        <Show
                          when={messages().length}
                          fallback={
                            <text fg={theme.textMuted}>
                              {busy() ? i18n.t("tui.im.loading") : i18n.t("tui.im.empty")}
                            </text>
                          }
                        >
                          <For each={messages()}>
                            {(message) => (
                              <box marginBottom={1}>
                                <text fg={theme.textMuted}>
                                  {message.senderID === props.identity ||
                                  props.selfMemberIDs?.includes(message.senderID) ||
                                  message.senderID === "server"
                                    ? i18n.t("tui.im.you")
                                    : message.senderID}{" "}
                                  · {Locale.time(message.createdAt)}
                                </text>
                                {/* Reserve the visible vertical scrollbar cell so narrow wrapped text is not clipped. */}
                                <text fg={theme.text} marginRight={1} wrapMode="word">
                                  {message.type === "file"
                                    ? AttachmentPreview.displayName(message.content)
                                    : message.content}
                                </text>
                                <Show when={props.openSession && dacCurrent()}>
                                  <text fg={theme.primary} onMouseUp={() => beginDac(message)}>
                                    {i18n.t("tui.im.dac.fromMessage")}
                                  </text>
                                </Show>
                                <For
                                  each={
                                    message.remoteAttachments?.length ? [] : MediaBatch.references(message.metadata)
                                  }
                                >
                                  {(id) => (
                                    <text
                                      fg={theme.primary}
                                      wrapMode="word"
                                      onMouseUp={() => setMedia({ open: true, attachmentID: id, remote: undefined })}
                                    >
                                      {i18n.t("tui.im.media.details")}
                                    </text>
                                  )}
                                </For>
                                <For each={message.remoteAttachments}>
                                  {(attachment) => (
                                    <text
                                      fg={theme.primary}
                                      wrapMode="word"
                                      onMouseUp={() =>
                                        setMedia({
                                          open: true,
                                          attachmentID: undefined,
                                          remote: { groupID: props.group.id, messageID: message.id, attachment },
                                        })
                                      }
                                    >
                                      {i18n.t("tui.im.media.details")} ·{" "}
                                      {AttachmentPreview.displayName(attachment.filename)}
                                    </text>
                                  )}
                                </For>
                                <Show when={message.transport}>
                                  {(transport) => (
                                    <box>
                                      <text fg={theme.textMuted} marginRight={1} wrapMode="word">
                                        {i18n.t(`tui.im.transport.${transport().state}`)}
                                      </text>
                                      <Show when={transport().state === "acknowledged"}>
                                        <text fg={theme.textMuted} marginRight={1} wrapMode="word">
                                          {i18n.t("tui.im.transport.acknowledgedHint")}
                                        </text>
                                      </Show>
                                      <Show when={transport().state === "unknown"}>
                                        <text fg={theme.textMuted} marginRight={1} wrapMode="word">
                                          {i18n.t(
                                            transport().reason === "legacy_missing_receipt"
                                              ? "tui.im.transport.reason.legacy"
                                              : transport().reason === "delivery_identity_or_expiry_changed"
                                                ? "tui.im.transport.reason.identity"
                                                : transport().reason === "receipt_mismatch"
                                                  ? "tui.im.transport.reason.mismatch"
                                                  : "tui.im.transport.reason.unknown",
                                          )}
                                        </text>
                                      </Show>
                                    </box>
                                  )}
                                </Show>
                              </box>
                            )}
                          </For>
                        </Show>
                      </scrollbox>
                      <Show when={failure()}>
                        <text fg={theme.error}>{failure()}</text>
                      </Show>
                      <Show when={busy()}>
                        <text fg={theme.textMuted}>{i18n.t("tui.im.loading")}</text>
                      </Show>
                      <Show when={hasMore()}>
                        <text
                          fg={theme.textMuted}
                          onMouseUp={() => {
                            void load(true)
                          }}
                        >
                          {i18n.t("tui.im.loadOlder")} (Ctrl+P)
                        </text>
                      </Show>
                      <text fg={theme.primary} onMouseUp={() => void refreshTransport()} wrapMode="word">
                        {observation.refreshing
                          ? i18n.t("tui.im.transport.refreshing")
                          : i18n.t("tui.im.transport.refresh")}{" "}
                        (Ctrl+R)
                      </text>
                      <text fg={theme.primary} onMouseUp={compose}>
                        {i18n.t("tui.im.send")} (Ctrl+S)
                      </text>
                      <Show when={props.openSession && dacCurrent()}>
                        <text fg={theme.primary} onMouseUp={() => void openDac()}>
                          {i18n.t("tui.im.dac.open")} (Ctrl+O)
                        </text>
                        <text fg={theme.primary} onMouseUp={() => beginDac()}>
                          {i18n.t("tui.im.dac.title")} (Ctrl+J)
                        </text>
                      </Show>
                      <Show when={!protectedGroup() || props.group.reader?.state === "ready"}>
                        <text
                          fg={theme.primary}
                          onMouseUp={() => setMedia({ open: true, attachmentID: undefined, remote: undefined })}
                          wrapMode="word"
                        >
                          {i18n.t("tui.im.media.title")} (Ctrl+U)
                        </text>
                      </Show>
                      <Show
                        when={
                          props.group.kernelConvID?.startsWith("k:2:") ||
                          (props.group.reader && props.group.type !== "direct")
                        }
                      >
                        <text fg={theme.primary} onMouseUp={invite}>
                          {i18n.t("tui.im.invite")} (Ctrl+G)
                        </text>
                      </Show>
                      <text fg={theme.textMuted}>{i18n.t("tui.im.chatHint")}</text>
                    </box>
                  }
                >
                  {(active) => <DialogIMForm {...active()} back={() => setForm(undefined)} />}
                </Show>
              }
            >
              <DialogIMMedia
                client={props.client}
                group={props.group}
                identity={props.identity}
                attachmentID={media.attachmentID}
                remote={media.remote}
                remoteAttachments={messages().flatMap((message) =>
                  (message.remoteAttachments ?? []).map((attachment) => ({
                    groupID: props.group.id,
                    messageID: message.id,
                    attachment,
                  })),
                )}
                attachments={messages().flatMap((message) =>
                  message.remoteAttachments?.length
                    ? []
                    : MediaBatch.references(message.metadata).map((id) => ({
                        id,
                        name: message.content || i18n.t("tui.im.media.details"),
                        messageID: message.id,
                      })),
                )}
                back={() => setMedia("open", false)}
                onSent={(message) =>
                  setMessages((current) =>
                    mergeIMMessages(current, [message], "receipt", new Map(current.map((item) => [item.id, item]))),
                  )
                }
              />
            </Show>
          </box>
        }
      >
        <DialogIMDac
          draft={dac}
          recentCommands={recentCommands()}
          openSession={openPersonalSession}
          back={() => setDacOpen(false)}
        />
      </Show>
    </box>
  )
}
