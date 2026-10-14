import { Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"
import { IMDeviceSchema } from "@deepagent-code/core/im/device.schema"
import { useLanguage } from "@/context/language"

export function IMDevicePanel(props: {
  client: IMDeviceClient.Transport
  current(): boolean
  available(value: boolean): void
}) {
  const language = useLanguage()
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
  const ready = () => current() && state.observed && !!state.info && !state.busy && !state.migrationID
  const canRetryOriginal = () =>
    current() &&
    state.observed &&
    !!state.info &&
    !state.busy &&
    !!state.migrationID &&
    state.migration?.state === "unknown"
  const editable = () => ready() || canRetryOriginal()
  const signal = () => AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)])
  const receive = (value: IMDeviceSchema.Migration) => {
    if (!current() || (state.migrationID && state.migrationID !== value.migrationID)) return
    setState({ migration: value, migrationID: value.migrationID })
    if ((value.state === "succeeded" && value.credentialStored) || value.state === "rejected")
      setState("migrationID", undefined)
  }
  const failed = (error: unknown) => {
    if (!current()) return
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
  const load = async () => {
    if (!current() || state.busy) return
    setState({ busy: true, error: "", observed: false })
    props.available(false)
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
      if (current()) {
        setState("busy", false)
        props.available(ready())
      }
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
      if (current()) {
        setState("busy", false)
        props.available(ready())
      }
    }
  }
  const migrate = async (retryOriginal = false) => {
    if (!(retryOriginal ? canRetryOriginal() : ready()) || !state.voucher || !state.confirmed) return
    const request = {
      migrationID: retryOriginal ? state.migrationID! : `im-migrate-${crypto.randomUUID()}`,
      voucher: state.voucher,
      ...(retryOriginal ? { retryOriginal: true } : {}),
    }
    setState({
      migrationID: request.migrationID,
      ...(retryOriginal ? {} : { migration: undefined }),
      busy: true,
      error: "",
    })
    props.available(false)
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
      if (current()) {
        setState({ voucher: "", confirmed: false, busy: false })
        props.available(ready())
      }
    }
  }
  const copy = async () => {
    if (!current() || !state.info) return
    if (!navigator.clipboard?.writeText) {
      failed(new Error("Clipboard unavailable"))
      return
    }
    await navigator.clipboard.writeText(JSON.stringify(state.info, null, 2)).catch(failed)
  }
  onMount(() => void load())
  onCleanup(() => {
    owner.abort()
    setState({ voucher: "", confirmed: false })
    props.available(false)
  })
  return (
    <section class="settings-v2-section flex flex-col gap-3" data-component="im-device">
      <h3 class="settings-v2-section-title">{language.t("im.device.title")}</h3>
      <p class="text-12-regular text-text-weak">{language.t("im.device.notice")}</p>
      <Show when={state.info}>
        {(info) => (
          <div class="flex flex-col gap-2">
            <code class="break-all">{info().deviceJkt}</code>
            <ButtonV2 variant="neutral" onClick={() => void copy()}>
              {language.t("im.device.copy")}
            </ButtonV2>
          </div>
        )}
      </Show>
      <Show when={state.error}>
        <p role="alert">
          {language.t(
            state.error === "store"
              ? "im.device.storeUnavailable"
              : state.error === "service"
                ? "im.device.serviceUnavailable"
                : state.error === "observation"
                  ? "im.device.observationUnavailable"
                  : "im.device.unavailable",
          )}
        </p>
      </Show>
      <Show when={state.migration}>
        {(migration) => (
          <p role="status">
            {language.t("im.device.state", {
              state: migration().state,
              credits: migration().chargedCredits,
            })}
          </p>
        )}
      </Show>
      <Show when={state.migrationID}>
        {(id) => (
          <div class="flex flex-col gap-2">
            <p role="status">{language.t("im.device.pending")}</p>
            <code class="break-all">{id()}</code>
            <ButtonV2 variant="neutral" disabled={state.busy || !current()} onClick={() => void recover()}>
              {language.t("im.device.recover")}
            </ButtonV2>
          </div>
        )}
      </Show>
      <Show when={!state.migrationID || canRetryOriginal()}>
        <div class="flex flex-col gap-2">
          <Show when={canRetryOriginal()}>
            <p>{language.t("im.device.retryHint")}</p>
          </Show>
          <label class="flex flex-col gap-1 text-12-regular">
            {language.t("im.device.voucher")}
            <TextInputV2
              type="password"
              value={state.voucher}
              maxlength={4096}
              disabled={!editable()}
              autocomplete="off"
              spellcheck={false}
              aria-label={language.t("im.device.voucher")}
              onInput={(event) => setState({ voucher: event.currentTarget.value, confirmed: false })}
            />
          </label>
          <label class="flex items-start gap-2 text-12-regular">
            <input
              type="checkbox"
              checked={state.confirmed}
              disabled={!editable()}
              onChange={(event) => setState("confirmed", event.currentTarget.checked)}
            />
            {language.t(state.migrationID ? "im.device.retryConsent" : "im.device.confirm")}
          </label>
          <ButtonV2
            variant="contrast"
            disabled={!editable() || !state.voucher || !state.confirmed}
            onClick={() => void migrate(!!state.migrationID)}
          >
            {language.t(state.migrationID ? "im.device.retryOriginal" : "im.device.migrate")}
          </ButtonV2>
        </div>
      </Show>
      <Show when={state.migration?.state === "succeeded" && state.migration.credentialStored}>
        <p role="status">{language.t("im.device.complete")}</p>
      </Show>
      <ButtonV2
        variant="neutral"
        disabled={state.busy || !current() || !!state.migrationID}
        onClick={() => void load()}
      >
        {language.t("im.device.refresh")}
      </ButtonV2>
    </section>
  )
}
