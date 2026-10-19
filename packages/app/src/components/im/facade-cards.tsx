import { createSignal, Show, type Component } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useLanguage } from "@/context/language"
import { useIMClient, type IMFacadeStatus } from "@/utils/im-client"
import { facadeFailureText, type FacadeFailureLike } from "./facade-errors"
import { submitFacadeName } from "@/pages/session/im-panel-helpers"

// Missing activation opens the explicit settings flow; connection recovery never purchases activation.

const inputClass =
  "w-full rounded-md border border-border-weak-base bg-surface-panel px-2 py-1 text-13-regular outline-none"

const FailureText: Component<{ failure: FacadeFailureLike }> = (props) => {
  const language = useLanguage()
  return (
    <div class="px-1" role="alert">
      <div class="text-12-regular text-text-critical">{facadeFailureText(language.t, props.failure)}</div>
    </div>
  )
}

export const ActivationCard: Component<{ onActivate: () => void }> = (props) => {
  const language = useLanguage()
  return (
    <div class="m-3 flex flex-col gap-2 rounded-md border border-border-weaker-base bg-surface-raised-base p-3">
      <div class="text-13-medium text-text-strong">{language.t("im.activation.title")}</div>
      <div class="text-12-regular text-text-weak">{language.t("im.activation.required")}</div>
      <div>
        <Button variant="primary" size="small" onClick={props.onActivate}>
          {language.t("im.activation.openSettings")}
        </Button>
      </div>
    </div>
  )
}

// Revoked identities require console inheritance rather than another activation purchase.
const CONSOLE_RECOVERY_CODES = new Set(["im_key_invalid", "im_identity_disabled", "im_source_identity_missing"])

export const BlockedCard: Component<{
  blocked: { code: string; message: string }
  onRecovered: () => void
  onActivate: () => void
}> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<FacadeFailureLike | null>(null)

  const retry = async () => {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    try {
      await client.facadeRetry()
      props.onRecovered()
    } catch (error) {
      const code =
        typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "http_error"
      setFailure({ errorCode: code, errorMessage: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show
      when={props.blocked.code !== "im_activation_required"}
      fallback={<ActivationCard onActivate={props.onActivate} />}
    >
      <div class="m-3 flex flex-col gap-2 rounded-md border border-border-weaker-base bg-surface-raised-base p-3">
        <div class="text-13-medium text-text-strong">{language.t("im.facade.blocked.title")}</div>
        <FailureText failure={{ errorCode: props.blocked.code, errorMessage: props.blocked.message }} />
        <Show when={failure()}>{(f) => <FailureText failure={f()} />}</Show>
        <Show when={CONSOLE_RECOVERY_CODES.has(props.blocked.code)}>
          <p class="text-12-regular text-text-weak">{language.t("im.facade.blocked.recovery")}</p>
        </Show>
        <div class="flex items-center gap-2">
          <Button variant="primary" size="small" disabled={busy()} onClick={() => void retry()}>
            {busy()
              ? language.t(
                  props.blocked.code === "im_service_changed" ? "im.facade.reconnecting" : "im.facade.retrying",
                )
              : language.t(props.blocked.code === "im_service_changed" ? "im.facade.reconnect" : "im.facade.retry")}
          </Button>
        </div>
      </div>
    </Show>
  )
}

const KERNEL_TEXT_KEYS = {
  connecting: "im.facade.kernel.connecting",
  connected: "im.facade.kernel.connected",
  disconnected: "im.facade.kernel.disconnected",
  failed: "im.facade.kernel.failed",
} as const

const KERNEL_COLORS = {
  connecting: "var(--icon-warning-base, #d29922)",
  connected: "var(--icon-success-base, #3fb950)",
  disconnected: "var(--icon-weak, #6e7681)",
  failed: "var(--icon-critical-base, #f85149)",
} as const

/** Active identity: name, uuid, connection state and rename. */
export const IdentityCard: Component<{ status: IMFacadeStatus; onChanged: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const [editing, setEditing] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<FacadeFailureLike | null>(null)

  const identity = () => props.status.identity!
  const kernel = () => props.status.kernel

  const submitRename = async () => {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    const result = await submitFacadeName(editing() ?? "", (name) => client.facadeRename(name))
    setBusy(false)
    if ("skipped" in result) {
      setEditing(null)
      return
    }
    if ("errorCode" in result) {
      setFailure(result)
      return
    }
    setEditing(null)
    props.onChanged()
  }

  const retryRecovery = async () => {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    await client
      .facadeRetry()
      .then(props.onChanged)
      .catch(() => {
        setFailure({ errorCode: "transport_error", errorMessage: "" })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div class="mx-3 mt-3 flex flex-col gap-1.5 rounded-md border border-border-weaker-base bg-surface-raised-base px-3 py-2">
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <Show
            when={editing() === null}
            fallback={
              <InlineInput
                ref={(el: HTMLInputElement) => queueMicrotask(() => el.isConnected && el.focus())}
                class={inputClass}
                value={editing() ?? ""}
                placeholder={language.t("im.facade.identity.rename.placeholder")}
                aria-label={language.t("im.facade.identity.rename.placeholder")}
                aria-invalid={!!failure()}
                disabled={busy()}
                onInput={(event) => setEditing(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.isComposing || event.keyCode === 229 || busy()) return
                  if (event.key === "Enter") void submitRename()
                  if (event.key === "Escape") setEditing(null)
                }}
              />
            }
          >
            <span class="text-13-medium text-text-strong truncate">{identity().name}</span>
            <IconButton
              icon="pencil-line"
              variant="ghost"
              class="h-6 w-6 rounded-md shrink-0"
              aria-label={language.t("im.facade.identity.rename")}
              onClick={() => {
                setFailure(null)
                setEditing(identity().name)
              }}
            />
          </Show>
        </div>
      </div>
      <Show when={editing() !== null}>
        <div class="flex flex-col gap-2">
          <p class="text-12-regular text-text-weak">{language.t("im.facade.name.rule")}</p>
          <div class="flex gap-2">
            <Button
              variant="primary"
              size="small"
              disabled={busy() || !editing()?.trim()}
              onClick={() => void submitRename()}
            >
              {language.t("common.save")}
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={busy()}
              onClick={() => {
                setEditing(null)
                setFailure(null)
              }}
            >
              {language.t("common.cancel")}
            </Button>
          </div>
        </div>
      </Show>
      <div class="flex items-center gap-2 text-11-regular text-text-weak">
        <span>{language.t("im.facade.identity.uuid", { uuid: identity().uuid.slice(0, 8) })}</span>
        <Show when={kernel()}>
          {(state) => (
            <span class="flex items-center gap-1">
              <span
                class="inline-block h-1.5 w-1.5 rounded-full"
                style={{ "background-color": KERNEL_COLORS[state()] }}
              />
              {language.t(KERNEL_TEXT_KEYS[state()])}
            </span>
          )}
        </Show>
        <Show when={!kernel()}>
          <span class="flex items-center gap-1">
            <span
              class="inline-block h-1.5 w-1.5 rounded-full"
              style={{ "background-color": KERNEL_COLORS.disconnected }}
            />
            {language.t("im.facade.kernel.none")}
          </span>
        </Show>
      </div>
      <Show when={props.status.recovery && props.status.recovery.status !== "ready"}>
        <div class="flex flex-col gap-1" role="status">
          <p class="text-12-regular text-text-weak">
            {language.t(
              props.status.recovery?.status === "failed" ? "im.facade.recovery.failed" : "im.facade.recovery.pending",
            )}
          </p>
        </div>
      </Show>
      <Button variant="secondary" size="small" disabled={busy()} onClick={() => void retryRecovery()}>
        {language.t("im.facade.retry")}
      </Button>
      <Show when={failure()}>{(f) => <FailureText failure={f()} />}</Show>
    </div>
  )
}
