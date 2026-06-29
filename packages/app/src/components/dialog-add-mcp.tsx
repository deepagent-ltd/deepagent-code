import { Component, createMemo, createSignal, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Button } from "@deepagent-code/ui/button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useLanguage } from "@/context/language"
import { useMcpAdd } from "@/context/mcp"
import type { McpLocalConfig, McpRemoteConfig } from "@deepagent-code/sdk/v2/client"

// U8 (S1 §P2): one-click "add MCP server" form. Backend (mcp.add endpoint + OAuth) already exists;
// this is the missing front-end entry. Local = stdio command[]; Remote = URL (+ OAuth handled by the
// existing connect flow, which surfaces needs_auth in the list).
export const DialogAddMcp: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()
  const add = useMcpAdd()

  const [type, setType] = createSignal<"local" | "remote">("local")
  const [name, setName] = createSignal("")
  const [command, setCommand] = createSignal("")
  const [url, setUrl] = createSignal("")

  const valid = createMemo(() => {
    if (!name().trim()) return false
    return type() === "local" ? command().trim().length > 0 : url().trim().length > 0
  })

  const submit = async () => {
    if (!valid() || add.isPending) return
    const config: McpLocalConfig | McpRemoteConfig =
      type() === "local"
        ? { type: "local", command: command().trim().split(/\s+/), enabled: true }
        : { type: "remote", url: url().trim(), enabled: true }
    await add.mutateAsync({ name: name().trim(), config })
    dialog.close()
  }

  return (
    <Dialog title={language.t("dialog.mcp.add.title")}>
      <div class="flex flex-col gap-3 px-3 pb-3">
        <label class="flex flex-col gap-1">
          <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.name")}</span>
          <InlineInput
            value={name()}
            placeholder={language.t("dialog.mcp.add.namePlaceholder")}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>

        <div class="flex flex-col gap-1">
          <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.type")}</span>
          <div class="flex gap-2">
            <Button variant={type() === "local" ? "primary" : "secondary"} onClick={() => setType("local")}>
              {language.t("dialog.mcp.add.typeLocal")}
            </Button>
            <Button variant={type() === "remote" ? "primary" : "secondary"} onClick={() => setType("remote")}>
              {language.t("dialog.mcp.add.typeRemote")}
            </Button>
          </div>
        </div>

        <Show when={type() === "local"}>
          <label class="flex flex-col gap-1">
            <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.command")}</span>
            <InlineInput
              value={command()}
              placeholder={language.t("dialog.mcp.add.commandPlaceholder")}
              onInput={(e) => setCommand(e.currentTarget.value)}
            />
          </label>
        </Show>

        <Show when={type() === "remote"}>
          <label class="flex flex-col gap-1">
            <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.url")}</span>
            <InlineInput
              value={url()}
              placeholder={language.t("dialog.mcp.add.urlPlaceholder")}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </label>
        </Show>

        <div class="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("dialog.mcp.add.cancel")}
          </Button>
          <Button variant="primary" disabled={!valid() || add.isPending} onClick={submit}>
            {language.t("dialog.mcp.add.submit")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
