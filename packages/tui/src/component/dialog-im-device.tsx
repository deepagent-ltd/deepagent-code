import { Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"
import { IMDeviceSchema } from "@deepagent-code/core/im/device.schema"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useClipboard } from "../context/clipboard"
import { useBindings } from "../keymap"
import { IMSecretInput } from "./im-secret-input"

export function DialogIMDevice(props: { client: IMDeviceClient.Transport; current(): boolean; back(): void }) {
  const { theme } = useTheme()
  const i18n = useTuiI18n()
  const clipboard = useClipboard()
  const owner = new AbortController()
  const current = () => props.current() && !owner.signal.aborted
  const client = IMDeviceClient.create({ client: props.client, current })
  const [state, setState] = createStore({
    info: undefined as typeof IMDeviceSchema.Info.Type | undefined,
    migration: undefined as IMDeviceSchema.Migration | undefined,
    migrationID: undefined as string | undefined,
    voucher: "",
    confirmed: false,
    busy: false,
    observed: false,
    error: "",
  })
  const signal = () => AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)])
  const ready = () => current() && state.observed && !!state.info && !state.busy && !state.migrationID
  const canRetryOriginal = () =>
    current() &&
    state.observed &&
    !!state.info &&
    !state.busy &&
    !!state.migrationID &&
    state.migration?.state === "unknown"
  const editable = () => ready() || canRetryOriginal()
  const failed = (error: unknown) => {
    if (current())
      setState(
        "error",
        error instanceof IMDeviceClient.RequestError && error.code === "im_device_store_unavailable"
          ? "store"
          : state.migrationID
            ? "unavailable"
            : error instanceof IMDeviceClient.RequestError && error.code === "im_activation_unavailable"
              ? "service"
              : "observation",
      )
  }
  const receive = (value: IMDeviceSchema.Migration) => {
    if (!current() || (state.migrationID && state.migrationID !== value.migrationID)) return
    setState({ migration: value, migrationID: value.migrationID })
    if ((value.state === "succeeded" && value.credentialStored) || value.state === "rejected")
      setState("migrationID", undefined)
  }
  const load = async () => {
    if (!current() || state.busy || state.migrationID) return
    setState({ busy: true, error: "", observed: false })
    try {
      const info = await client.info(signal())
      if (!current()) return
      setState("info", info)
      const pending = await client.pending(signal())
      if (!current()) return
      setState({ info, observed: true })
      if (pending) receive(pending)
    } catch (error) {
      failed(error)
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const recover = async () => {
    const migrationID = state.migrationID
    if (!current() || state.busy || !migrationID) return
    setState({ busy: true, error: "" })
    try {
      receive(await client.status(migrationID, signal()))
    } catch (error) {
      failed(error)
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const submit = async (retryOriginal = false) => {
    if (!(retryOriginal ? canRetryOriginal() : ready()) || !state.voucher || !state.confirmed) return
    const request = {
      migrationID: retryOriginal ? state.migrationID! : `im-migrate-${crypto.randomUUID()}`,
      voucher: state.voucher,
      ...(retryOriginal ? { retryOriginal: true } : {}),
    }
    setState({
      migrationID: request.migrationID,
      busy: true,
      ...(retryOriginal ? {} : { migration: undefined }),
      error: "",
    })
    try {
      receive(await client.migrate(request, signal()))
    } catch (error) {
      failed(error)
      if (!retryOriginal && current() && error instanceof IMDeviceClient.RequestError) {
        if (error.code === "im_device_store_unavailable") setState({ migrationID: undefined, info: undefined })
        if (error.code === "im_activation_pending") setState("migrationID", undefined)
        if (error.code === "im_device_migration_pending") {
          const pending = await client.pending(signal()).catch((cause: unknown) => {
            failed(cause)
            return null
          })
          if (pending && current()) {
            setState("migrationID", undefined)
            receive(pending)
          }
        }
      }
    } finally {
      if (current()) setState({ voucher: "", confirmed: false, busy: false })
    }
  }
  const copy = async () => {
    if (!current() || !state.info) return
    if (!clipboard.write) {
      failed(new Error("Clipboard unavailable"))
      return
    }
    await clipboard.write(JSON.stringify(state.info, null, 2)).catch(failed)
  }
  useBindings(() => ({
    priority: 2,
    bindings: [
      { key: "return", cmd: () => void (state.migrationID ? recover() : submit()) },
      {
        key: "alt+c",
        cmd: () => {
          if (editable()) setState("confirmed", !state.confirmed)
        },
      },
      { key: "ctrl+r", cmd: () => void (state.migrationID ? recover() : load()) },
      {
        key: "alt+s",
        cmd: () => {
          if (canRetryOriginal()) void submit(true)
        },
      },
      { key: "escape", cmd: props.back },
    ],
  }))
  onMount(() => void load())
  onCleanup(() => {
    owner.abort()
    setState({ voucher: "", confirmed: false })
  })
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {i18n.t("tui.im.device.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {i18n.t("tui.im.device.notice")}
      </text>
      <Show when={state.info}>
        {(info) => (
          <>
            <text fg={theme.textMuted} wrapMode="word">
              {info().deviceJkt}
            </text>
            <text fg={theme.primary} onMouseUp={() => void copy()}>
              {i18n.t("tui.im.device.copy")}
            </text>
          </>
        )}
      </Show>
      <Show when={state.error}>
        <text fg={theme.error} wrapMode="word">
          {i18n.t(
            state.error === "store"
              ? "tui.im.device.storeUnavailable"
              : state.error === "service"
                ? "tui.im.device.serviceUnavailable"
                : state.error === "observation"
                  ? "tui.im.device.observationUnavailable"
                  : "tui.im.device.unavailable",
          )}
        </text>
      </Show>
      <Show when={state.migration}>
        {(migration) => (
          <text fg={theme.textMuted}>
            {i18n.t("tui.im.device.state", {
              state: migration().state,
              credits: migration().chargedCredits,
            })}
          </text>
        )}
      </Show>
      <Show when={state.migrationID}>
        {(id) => (
          <>
            <text fg={theme.warning} wrapMode="word">
              {i18n.t("tui.im.device.pending")}
            </text>
            <text fg={theme.textMuted}>{id()}</text>
            <text fg={theme.primary} onMouseUp={() => void recover()}>
              {i18n.t("tui.im.device.recover")}
            </text>
          </>
        )}
      </Show>
      <Show when={!state.migrationID || canRetryOriginal()}>
        <>
          <Show when={canRetryOriginal()}>
            <text fg={theme.textMuted} wrapMode="word">
              {i18n.t("tui.im.device.retryHint")}
            </text>
          </Show>
          <IMSecretInput
            value={state.voucher}
            setValue={(voucher) => {
              if (editable()) setState({ voucher, confirmed: false })
            }}
            active={editable()}
            locked={!editable()}
            label={i18n.t("tui.im.device.voucher")}
          />
          <text
            fg={editable() ? theme.primary : theme.textMuted}
            onMouseUp={() => {
              if (editable()) setState("confirmed", !state.confirmed)
            }}
          >
            {state.confirmed ? "[x] " : "[ ] "}
            {i18n.t(state.migrationID ? "tui.im.device.retryConsent" : "tui.im.device.confirm")}
          </text>
          <text
            fg={editable() && state.confirmed && state.voucher ? theme.primary : theme.textMuted}
            onMouseUp={() => void submit(!!state.migrationID)}
          >
            {i18n.t(state.migrationID ? "tui.im.device.retryOriginal" : "tui.im.device.migrate")}
          </text>
        </>
      </Show>
      <Show when={state.migration?.state === "succeeded" && state.migration.credentialStored}>
        <text fg={theme.success}>{i18n.t("tui.im.device.complete")}</text>
      </Show>
      <text fg={theme.primary} onMouseUp={() => void load()}>
        {i18n.t("tui.im.device.refresh")}
      </text>
      <text fg={theme.textMuted} onMouseUp={props.back}>
        {i18n.t("tui.im.activation.back")}
      </text>
    </box>
  )
}
