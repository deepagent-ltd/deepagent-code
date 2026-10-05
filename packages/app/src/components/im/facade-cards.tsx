import { createSignal, Show, type Component } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useIMClient, type IMFacadeStatus } from "@/utils/im-client"
import { facadeFailureText, type FacadeFailureLike } from "./facade-errors"
import { submitFacadeName } from "@/pages/session/im-panel-helpers"
import { RebindDialog } from "./facade-dialogs"

// B2 门面三态卡片：claim_required（认领引导）/ blocked（逐码错误 + 重试 + 找回入口）/ active 顶部
// 身份卡（名字 + uuid 短码 + 内核连接态 + rename 入口 + rebind 入口）。流程逻辑全部落在
// im-panel-helpers 的纯函数里（可单测），这里只做接线与呈现。

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

/** claim_required：名字输入 + 规则提示 + 客户端预校验 + 逐码错误 + 重名重试。 */
export const ClaimCard: Component<{ onClaimed: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<FacadeFailureLike | null>(null)

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    const result = await submitFacadeName(name(), (n) => client.facadeClaim(n))
    setBusy(false)
    if ("skipped" in result) return
    if ("errorCode" in result) {
      setFailure(result)
      return
    }
    props.onClaimed()
  }

  return (
    <div class="m-3 flex flex-col gap-2 rounded-md border border-border-weaker-base bg-surface-raised-base p-3">
      <div class="text-13-medium text-text-strong">{language.t("im.facade.claim.title")}</div>
      <div class="text-12-regular text-text-weak">{language.t("im.facade.claim.description")}</div>
      <InlineInput
        ref={(el: HTMLInputElement) => queueMicrotask(() => el.isConnected && el.focus())}
        class={inputClass}
        value={name()}
        placeholder={language.t("im.facade.claim.name.placeholder")}
        aria-label={language.t("im.facade.claim.name.placeholder")}
        aria-invalid={!!failure()}
        disabled={busy()}
        onInput={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.isComposing || event.keyCode === 229) return
          if (event.key === "Enter") void submit()
        }}
      />
      <div class="text-11-regular text-text-weak">{language.t("im.facade.name.rule")}</div>
      <Show when={failure()}>{(f) => <FailureText failure={f()} />}</Show>
      <div>
        <Button variant="primary" size="small" disabled={busy() || !name().trim()} onClick={() => void submit()}>
          {language.t("im.facade.claim.submit")}
        </Button>
      </div>
    </div>
  )
}

// Self-service rebind authenticates the existing active key. Revoked identities require console inheritance.
const CONSOLE_RECOVERY_CODES = new Set(["im_key_invalid", "im_identity_disabled", "im_source_identity_missing"])

/** blocked：逐码文案 + 重试（retryExchange）+ 可找回码的 rebind 入口。 */
export const BlockedCard: Component<{ blocked: { code: string; message: string }; onRecovered: () => void }> = (
  props,
) => {
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
    <div class="m-3 flex flex-col gap-2 rounded-md border border-border-weaker-base bg-surface-raised-base p-3">
      <div class="text-13-medium text-text-strong">{language.t("im.facade.blocked.title")}</div>
      <FailureText failure={{ errorCode: props.blocked.code, errorMessage: props.blocked.message }} />
      <Show when={failure()}>{(f) => <FailureText failure={f()} />}</Show>
      <Show when={CONSOLE_RECOVERY_CODES.has(props.blocked.code)}>
        <p class="text-12-regular text-text-weak">{language.t("im.facade.blocked.recovery")}</p>
      </Show>
      <div class="flex items-center gap-2">
        <Button variant="primary" size="small" disabled={busy()} onClick={() => void retry()}>
          {busy() ? language.t("im.facade.retrying") : language.t("im.facade.retry")}
        </Button>
      </div>
    </div>
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

/** active 顶部身份卡：name + uuid 短码 + 内核连接点 + rename（铅笔 inline 编辑）+ rebind 入口。 */
export const IdentityCard: Component<{ status: IMFacadeStatus; onChanged: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const dialog = useDialog()
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
        <button
          type="button"
          class="text-11-regular text-text-weak hover:text-text-base shrink-0"
          disabled={busy()}
          onClick={() => dialog.show(() => <RebindDialog onRebound={props.onChanged} />)}
        >
          {language.t("im.facade.identity.rebind")}
        </button>
      </div>
      <Show when={editing() !== null}>
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
      <Show when={failure()}>{(f) => <FailureText failure={f()} />}</Show>
    </div>
  )
}
