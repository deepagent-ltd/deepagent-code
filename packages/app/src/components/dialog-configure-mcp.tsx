import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Switch } from "@deepagent-code/ui/switch"
import { TextField } from "@deepagent-code/ui/text-field"
import { Component, createMemo, createSignal, Match, Show, Switch as SolidSwitch } from "solid-js"
import { useLanguage } from "@/context/language"
import { useMcpUpdate } from "@/context/mcp"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import type { McpLocalConfig, McpRemoteConfig } from "@deepagent-code/sdk/v2/client"

type McpConfig = McpLocalConfig | McpRemoteConfig
type StringRecord = Record<string, string>

const formatMap = (value: StringRecord | undefined) => JSON.stringify(value ?? {}, null, 2)

const isConfiguredMcp = (value: unknown): value is McpConfig =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  ((value as { type?: unknown }).type === "local" || (value as { type?: unknown }).type === "remote")

function parseMap(value: string, label: string) {
  const parsed = JSON.parse(value.trim() || "{}") as unknown
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(label)
  const entries = Object.entries(parsed)
  if (entries.some(([, entry]) => typeof entry !== "string")) throw new Error(label)
  return Object.fromEntries(entries) as StringRecord
}

export const DialogConfigureMcp: Component<{ name: string }> = (props) => {
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()
  const update = useMcpUpdate()

  const config = createMemo(() => {
    const value = sync.data.config.mcp?.[props.name]
    if (!isConfiguredMcp(value)) return
    return value
  })

  const initial = config()
  const [enabled, setEnabled] = createSignal(initial?.enabled !== false)
  const [command, setCommand] = createSignal(initial?.type === "local" ? initial.command.join(" ") : "")
  const [url, setUrl] = createSignal(initial?.type === "remote" ? initial.url : "")
  const [environment, setEnvironment] = createSignal(initial?.type === "local" ? formatMap(initial.environment) : "{}")
  const [headers, setHeaders] = createSignal(initial?.type === "remote" ? formatMap(initial.headers) : "{}")
  const [timeout, setTimeoutValue] = createSignal(initial?.timeout?.toString() ?? "")
  const [oauthDisabled, setOauthDisabled] = createSignal(initial?.type === "remote" && initial.oauth === false)

  const valid = createMemo(() => {
    const current = config()
    if (!current) return false
    if (current.type === "local" && command().trim().length === 0) return false
    if (current.type === "remote" && url().trim().length === 0) return false
    if (timeout().trim().length === 0) return true
    return Number.isFinite(Number(timeout())) && Number(timeout()) > 0
  })

  const submit = async () => {
    const current = config()
    if (!current || !valid() || update.isPending) return

    try {
      const parsedTimeout = timeout().trim() ? Number(timeout()) : undefined
      const next: McpConfig =
        current.type === "local"
          ? {
              ...current,
              enabled: enabled(),
              command: command().trim().split(/\s+/),
              environment: parseMap(environment(), language.t("dialog.mcp.configure.invalidJson")),
              timeout: parsedTimeout,
            }
          : {
              ...current,
              enabled: enabled(),
              url: url().trim(),
              headers: parseMap(headers(), language.t("dialog.mcp.configure.invalidJson")),
              oauth: oauthDisabled() ? false : current.oauth === false ? undefined : current.oauth,
              timeout: parsedTimeout,
            }

      await update.mutateAsync({ name: props.name, config: next })
      dialog.close()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Dialog title={language.t("dialog.mcp.configure.title", { name: props.name })} size="large">
      <Show
        when={config()}
        fallback={<div class="px-3 pb-3 text-14-regular text-text-weaker">{language.t("dialog.mcp.empty")}</div>}
      >
        {(current) => (
          <div class="flex flex-col gap-3 px-3 pb-3">
            <div class="flex items-center justify-between gap-3 bg-surface-base rounded-md p-3">
              <div class="flex flex-col gap-0.5">
                <span class="text-13-medium text-text-base">{language.t("dialog.mcp.configure.enabled")}</span>
                <span class="text-11-regular text-text-weaker">
                  {enabled()
                    ? language.t("dialog.mcp.configure.enabledOn")
                    : language.t("dialog.mcp.configure.enabledOff")}
                </span>
              </div>
              <Switch checked={enabled()} onChange={setEnabled} />
            </div>

            <SolidSwitch>
              <Match when={current().type === "local"}>
                <TextField
                  type="text"
                  label={language.t("dialog.mcp.add.command")}
                  value={command()}
                  onChange={setCommand}
                />
                <TextField
                  multiline
                  rows={4}
                  label={language.t("dialog.mcp.configure.environment")}
                  value={environment()}
                  onChange={setEnvironment}
                  spellcheck={false}
                />
              </Match>
              <Match when={current().type === "remote"}>
                <TextField type="text" label={language.t("dialog.mcp.add.url")} value={url()} onChange={setUrl} />
                <TextField
                  multiline
                  rows={4}
                  label={language.t("dialog.mcp.configure.headers")}
                  value={headers()}
                  onChange={setHeaders}
                  spellcheck={false}
                />
                <div class="flex items-center justify-between gap-3 bg-surface-base rounded-md p-3">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-13-medium text-text-base">{language.t("dialog.mcp.configure.oauth")}</span>
                    <span class="text-11-regular text-text-weaker">
                      {oauthDisabled()
                        ? language.t("dialog.mcp.configure.oauthDisabled")
                        : language.t("dialog.mcp.configure.oauthAuto")}
                    </span>
                  </div>
                  <Switch checked={!oauthDisabled()} onChange={(value) => setOauthDisabled(!value)} />
                </div>
              </Match>
            </SolidSwitch>

            <TextField
              type="number"
              min="1"
              label={language.t("dialog.mcp.configure.timeout")}
              value={timeout()}
              onChange={setTimeoutValue}
            />

            <div class="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => dialog.close()}>
                {language.t("dialog.mcp.add.cancel")}
              </Button>
              <Button variant="primary" disabled={!valid() || update.isPending} onClick={submit}>
                {language.t("dialog.mcp.configure.save")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
