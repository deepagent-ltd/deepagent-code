import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { Locale } from "../util/locale"
import { DialogIMForm, type IMFormField } from "./dialog-im-form"
import { imErrorText } from "./im-errors"
import {
  createIMClient,
  openIMGroupSocket,
  mergeIMMessages,
  IMRequestError,
  type IMClient,
  type IMFacadeStatus,
  type IMGroup,
  type IMMessage,
  type IMSDK,
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

export async function readIMKeyFile(path: string) {
  if (!path.trim()) throw new IMRequestError("key_file", "Empty key file path")
  const file = Bun.file(path.trim())
  const info = await file.stat().catch(() => {
    throw new IMRequestError("key_file", "Unreadable key file")
  })
  if (!info.isFile() || info.size === 0 || info.size > 16 * 1024)
    throw new IMRequestError("key_file", "Invalid key file")
  const key = (
    await file.text().catch(() => {
      throw new IMRequestError("key_file", "Unreadable key file")
    })
  ).trim()
  if (!key || /\s/.test(key) || key.length > 16 * 1024) throw new IMRequestError("key_file", "Invalid key file")
  return key
}

export function DialogIM() {
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const client = createIMClient(sdk)
  const [status, setStatus] = createSignal<IMFacadeStatus>()
  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [form, setForm] = createSignal<Form>()
  const [chat, setChat] = createSignal<IMGroup>()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const reload = async () => {
    if (busy()) return
    setBusy(true)
    await Promise.all([client.facadeStatus(), client.listGroups()])
      .then(([snapshot, rows]) => {
        if (disposed) return
        setStatus(snapshot)
        setGroups(rows)
        setFailure("")
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(imErrorText(error, i18n))
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
  }

  onMount(() => {
    void reload()
    const timer = setInterval(() => {
      void reload()
    }, 10_000)
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
    setChat(group)
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
    ...(status()?.facade === "claim_required"
      ? [{ title: i18n.t("tui.im.claim"), value: "claim", category: i18n.t("tui.im.identity") }]
      : []),
    ...(status()?.identity
      ? [{ title: i18n.t("tui.im.rename"), value: "rename", category: i18n.t("tui.im.identity") }]
      : []),
    ...(status()?.facade === "active"
      ? [{ title: i18n.t("tui.im.rebind"), value: "rebind", category: i18n.t("tui.im.identity") }]
      : []),
    ...(status()?.facade === "blocked"
      ? [{ title: i18n.t("tui.im.recover"), value: "recover", category: i18n.t("tui.im.identity") }]
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
    { title: i18n.t("tui.im.localAgent"), value: "agent", category: i18n.t("tui.im.local") },
    { title: i18n.t("tui.im.localGroup"), value: "local", category: i18n.t("tui.im.local") },
    { title: i18n.t("tui.im.refresh"), value: "refresh", category: "IM" },
    ...groups().map((group) => ({
      title: `${group.kernelConvID?.startsWith("k:1:") ? "@ " : "# "}${group.name}`,
      value: `chat:${group.id}`,
      category:
        group.kernelConvID === `k:2:${status()?.identity?.orgAllGroupID}`
          ? i18n.t("tui.im.allGroup")
          : group.kernelConvID?.startsWith("k:1:")
            ? i18n.t("tui.im.humanDirect")
            : group.kernelConvID
              ? i18n.t("tui.im.kernelGroup")
              : i18n.t("tui.im.local"),
      footer: Locale.time(group.updatedAt),
    })),
  ]

  const select = (value: string) => {
    if (busy()) return
    if (value.startsWith("chat:")) {
      setChat(groups().find((group) => group.id === value.slice(5)))
      return
    }
    if (value === "claim") {
      nameForm(i18n.t("tui.im.claim"), client.facadeClaim)
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
      void reload()
      return
    }
    if (value === "rebind" || value === "recover") {
      setForm({
        title: i18n.t(value === "recover" ? "tui.im.recover" : "tui.im.rebind"),
        description: i18n.t("tui.im.keyFileHint"),
        fields: [{ label: i18n.t("tui.im.keyFile") }],
        submit: async (values, active) => {
          const key = await readIMKeyFile(values[0])
          if (value === "rebind") await client.facadeRebind(key)
          if (value === "recover") {
            await client.storeFacadeKey(key)
            await client.facadeRetry()
          }
          if (active()) await done()
        },
      })
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
    setForm({
      title: i18n.t(value === "agent" ? "tui.im.localAgent" : "tui.im.localGroup"),
      description: value === "agent" ? i18n.t("tui.im.localAgentHint") : undefined,
      fields: [{ label: i18n.t("tui.im.name") }],
      submit: async (values, active) => {
        const name = values[0].trim()
        if (!name) throw new IMRequestError("invalid_request", "Empty name")
        if (value === "agent" && !(await client.listAgents()).some((agent) => agent.id === name)) {
          throw new IMRequestError("im_not_found", "Local Agent not found")
        }
        const group = await client.createGroup(
          value === "agent"
            ? { name, type: "direct", member: { memberID: name, memberType: "agent" } }
            : { name, type: "project" },
        )
        if (active()) open(group)
      },
    })
  }

  return (
    <box>
      <Show
        when={chat()}
        fallback={
          <Show
            when={form()}
            fallback={
              <DialogSelect
                title={i18n.t("tui.im.title")}
                titleView={
                  <box>
                    <text fg={theme.text}>
                      {i18n.t("tui.im.title")} ·{" "}
                      {busy() ? i18n.t("tui.im.loading") : status() ? i18n.t(`tui.im.${status()!.facade}`) : ""}
                    </text>
                    <Show when={status()?.identity}>
                      {(identity) => (
                        <text fg={theme.textMuted}>
                          {identity().name} · {identity().uuid} · org {identity().orgID}
                        </text>
                      )}
                    </Show>
                    <Show when={status()?.kernel}>
                      <text fg={theme.textMuted}>
                        {i18n.t("tui.im.connection", { state: i18n.t(`tui.im.${status()!.kernel!}`) })}
                      </text>
                    </Show>
                    <Show when={status()?.recovery?.status === "pending"}>
                      <text fg={theme.textMuted}>{i18n.t("tui.im.recoveryPending")}</text>
                    </Show>
                    <Show when={status()?.recovery?.status === "failed"}>
                      <text fg={theme.error}>{i18n.t("tui.im.recoveryFailed")}</text>
                    </Show>
                    <Show when={status()?.blocked}>
                      <text fg={theme.error}>{imErrorText(new IMRequestError(status()!.blocked!.code, ""), i18n)}</text>
                    </Show>
                    <Show when={failure()}>
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
            identity={status()?.viewer?.memberID ?? status()?.identity?.uuid}
            back={() => {
              setChat(undefined)
              void reload()
            }}
          />
        )}
      </Show>
    </box>
  )
}

export function DialogIMChat(props: {
  client: IMClient
  sdk: IMSDK
  group: IMGroup
  identity?: string
  back: () => void
}) {
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const [messages, setMessages] = createSignal<IMMessage[]>([])
  const [connection, setConnection] = createSignal("connecting" as "connecting" | "connected" | "disconnected")
  const [failure, setFailure] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [hasMore, setHasMore] = createSignal(false)
  const [form, setForm] = createSignal<Form>()
  const [draft, setDraft] = createSignal("")
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const load = async (older = false) => {
    if (busy() || (older && !hasMore())) return
    setBusy(true)
    await props.client
      .listMessages(props.group.id, 50, older ? (cursor() ?? undefined) : undefined)
      .then((page) => {
        if (disposed) return
        setMessages((current) => mergeIMMessages(current, page.messages))
        // A reconnect refresh must not move an already-paged history cursor forward.
        if (older || !cursor()) {
          setCursor(page.nextCursor)
          setHasMore(page.hasMore)
        }
        setFailure("")
        void props.client.markRead(props.group.id).catch(() => undefined)
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(imErrorText(error, i18n))
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
  }

  onMount(() => {
    void load()
    const socket = openIMGroupSocket(props.sdk, props.group.id, {
      onState: setConnection,
      onOpen: () => {
        void load()
      },
      onMessage: (message) => {
        if (disposed || message.groupID !== props.group.id) return
        setMessages((current) => mergeIMMessages(current, [message]))
        void props.client.markRead(props.group.id).catch(() => undefined)
      },
      onFailed: (payload) => setFailure(imErrorText(new IMRequestError(payload.code, payload.message), i18n)),
    })
    onCleanup(() => socket.close())
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
        },
      ],
      submit: async (values, active) => {
        setDraft(values[0])
        if (!values[0].trim()) throw new IMRequestError("invalid_request", "Empty message")
        const message = await props.client.createMessage(props.group.id, { content: values[0].trim() })
        if (disposed || !active()) return
        setMessages((current) => mergeIMMessages(current, [message]))
        setDraft("")
        setForm(undefined)
      },
    })
  const invite = () => {
    if (!props.group.kernelConvID?.startsWith("k:2:")) return
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

  useBindings(() => ({
    enabled: !form(),
    priority: 1,
    bindings: [
      { key: "ctrl+s", cmd: compose },
      { key: "ctrl+g", cmd: invite },
      {
        key: "ctrl+r",
        cmd: () => {
          void load()
        },
      },
      {
        key: "ctrl+p",
        cmd: () => {
          void load(true)
        },
      },
      { key: "escape", cmd: props.back },
    ],
  }))

  return (
    <box>
      <Show
        when={form()}
        fallback={
          <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
            <text fg={theme.text}>
              {props.group.name} · {i18n.t("tui.im.connection", { state: i18n.t(`tui.im.${connection()}`) })}
            </text>
            <scrollbox maxHeight={14} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: true }}>
              <Show
                when={messages().length}
                fallback={
                  <text fg={theme.textMuted}>{busy() ? i18n.t("tui.im.loading") : i18n.t("tui.im.empty")}</text>
                }
              >
                <For each={messages()}>
                  {(message) => (
                    <box marginBottom={1}>
                      <text fg={theme.textMuted}>
                        {message.senderID === props.identity || message.senderID === "server"
                          ? i18n.t("tui.im.you")
                          : message.senderID}{" "}
                        · {Locale.time(message.createdAt)}
                      </text>
                      <text fg={theme.text} wrapMode="word">
                        {message.content}
                      </text>
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
            <text fg={theme.primary} onMouseUp={compose}>
              {i18n.t("tui.im.send")} (Ctrl+S)
            </text>
            <Show when={props.group.kernelConvID?.startsWith("k:2:")}>
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
    </box>
  )
}
