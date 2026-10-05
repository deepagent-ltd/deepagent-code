import { createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Icon } from "@deepagent-code/ui/icon"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useIMClient } from "@/utils/im-client"
import { facadeFailureText, type FacadeFailureLike } from "./facade-errors"
import { submitFacadeGroupCreate, submitFacadeName, submitFacadeRebind } from "@/pages/session/im-panel-helpers"
import type { IMGroup } from "./types"

// B2 门面对话框：rebind（换 key 找回）与内核建群（群名 + 成员名 chips，逐个 resolve 验证）。
// 流程逻辑在 im-panel-helpers 纯函数里，这里只做对话框接线。

const inputClass =
  "w-full rounded-md border border-border-weak-base bg-surface-panel px-2 py-1 text-13-regular outline-none"

const DialogFailure: Component<{ failure: FacadeFailureLike }> = (props) => {
  const language = useLanguage()
  return (
    <div role="alert">
      <div class="text-12-regular text-text-critical">{facadeFailureText(language.t, props.failure)}</div>
    </div>
  )
}

/** 换 key 找回：输入新 sk- key → 门面 rebind → 成功后 onRebound（父级刷新状态/群列表）。 */
export const RebindDialog: Component<{ onRebound: () => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const dialog = useDialog()
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<FacadeFailureLike | null>(null)

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    const result = await submitFacadeRebind(key(), (k) => client.facadeRebind(k))
    setBusy(false)
    if ("skipped" in result) return
    if ("errorCode" in result) {
      setFailure(result)
      return
    }
    dialog.close()
    props.onRebound()
  }

  return (
    <Dialog title={language.t("im.facade.rebind.title")} description={language.t("im.facade.rebind.description")}>
      <div class="flex flex-col gap-2">
        <InlineInput
          autofocus
          type="password"
          autocomplete="off"
          spellcheck={false}
          class={inputClass}
          value={key()}
          placeholder={language.t("im.facade.rebind.placeholder")}
          aria-label={language.t("im.facade.rebind.title")}
          aria-invalid={!!failure()}
          disabled={busy()}
          onInput={(event) => setKey(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === "Enter") void submit()
          }}
        />
        <Show when={failure()}>{(f) => <DialogFailure failure={f()} />}</Show>
        <div>
          <Button variant="primary" size="small" disabled={busy() || !key().trim()} onClick={() => void submit()}>
            {language.t("im.facade.rebind.submit")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** 内核建群：群名 + 成员名 chips（Enter 逐个 resolve 进 chips；im_not_found 等逐码提示）。 */
export const KernelGroupDialog: Component<{ onCreated: (group: IMGroup) => void }> = (props) => {
  const language = useLanguage()
  const client = useIMClient()
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const [memberInput, setMemberInput] = createSignal("")
  const [members, setMembers] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const [resolving, setResolving] = createSignal(false)
  const [failure, setFailure] = createSignal<FacadeFailureLike | null>(null)

  const addMember = async () => {
    if (busy() || resolving()) return
    setResolving(true)
    setFailure(null)
    const result = await submitFacadeName(memberInput(), (n) => client.facadeResolve(n))
    setResolving(false)
    if ("skipped" in result) return
    if ("errorCode" in result) {
      setFailure(result)
      return
    }
    // 重复添加幂等：chips 去重（门面侧建群对重复成员名不报错，但 UI 不该堆重复项）。
    if (!members().includes(result.value.name)) setMembers((prev) => [...prev, result.value.name])
    setMemberInput("")
  }

  const submit = async () => {
    if (busy() || resolving() || memberInput().trim()) return
    setBusy(true)
    setFailure(null)
    const result = await submitFacadeGroupCreate(name(), members(), (n, ms) => client.facadeCreateGroup(n, ms))
    setBusy(false)
    if ("skipped" in result) return
    if ("errorCode" in result) {
      setFailure(result)
      return
    }
    dialog.close()
    props.onCreated(result.value)
  }

  return (
    <Dialog title={language.t("im.group.create")}>
      <div class="flex flex-col gap-2">
        <InlineInput
          autofocus
          class={inputClass}
          value={name()}
          placeholder={language.t("im.group.create.placeholder")}
          aria-label={language.t("im.group.create.placeholder")}
          disabled={busy()}
          onInput={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <Show when={members().length > 0}>
          <div class="flex flex-wrap gap-1">
            <For each={members()}>
              {(member) => (
                <span class="flex items-center gap-1 rounded-md bg-surface-raised-base px-2 py-0.5 text-12-regular text-text-base">
                  {member}
                  <button
                    type="button"
                    class="text-text-weak hover:text-text-base"
                    aria-label={language.t("im.facade.group.members.remove", { name: member })}
                    disabled={busy() || resolving()}
                    onClick={() => setMembers((prev) => prev.filter((m) => m !== member))}
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <InlineInput
          class={inputClass}
          value={memberInput()}
          placeholder={language.t("im.facade.group.members.placeholder")}
          aria-label={language.t("im.facade.group.members.placeholder")}
          disabled={busy() || resolving()}
          onInput={(event) => setMemberInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === "Enter") void addMember()
          }}
        />
        <div>
          <Button
            variant="secondary"
            size="small"
            disabled={busy() || resolving() || !memberInput().trim()}
            onClick={() => void addMember()}
          >
            {language.t("im.facade.group.members.add")}
          </Button>
        </div>
        <div class="text-11-regular text-text-weak">{language.t("im.facade.group.members.hint")}</div>
        <Show when={failure()}>{(f) => <DialogFailure failure={f()} />}</Show>
        <div>
          <Button
            variant="primary"
            size="small"
            disabled={busy() || resolving() || !!memberInput().trim() || !name().trim()}
            onClick={() => void submit()}
          >
            {language.t("im.group.create")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
