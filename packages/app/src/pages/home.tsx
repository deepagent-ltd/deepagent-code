import { createMemo, For, Match, Switch } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Logo } from "@deepagent-code/ui/logo"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { Icon } from "@deepagent-code/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useGlobal } from "@/context/global"
import { sandboxDir } from "@/utils/sandbox"
import { showToast } from "@/utils/toast"

export default function Home() {
  const sync = useServerSync()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const serverDotClass = createMemo(() => {
    const healthy = global.servers.health[server.key]?.healthy
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(server: ServerConnection.Any, directory: string) {
    const serverCtx = global.createServerCtx(server)
    serverCtx.projects.open(directory)
    serverCtx.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  // Appendix C 形态二 (form 2): folder-less new chat. Allocate a dedicated sandbox
  // directory under the server's data dir, materialize it on the server (so the
  // instance boots against a real path — an absent dir yields empty file trees and
  // PTY 503s), then route through the existing /:dir route. The sandbox — never "/"
  // — is what enforces the permission boundary for a project-less chat.
  async function startFolderlessChat() {
    const s = server.current
    if (!s) return

    let directory: string
    try {
      directory = sandboxDir(sync.data.path.data)
    } catch {
      // Path data not loaded yet — the server is still connecting.
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("common.loading"),
      })
      return
    }

    const serverCtx = global.createServerCtx(s)
    // Create a dir-scoped client and ensure the sandbox exists. mkdir({ path: "." })
    // resolves to the directory itself, which the server ensureDir's — bootstrapping
    // the sandbox root without needing a pre-existing instance.
    const client = serverCtx.sdk.createClient({ directory, throwOnError: true })
    try {
      await client.file.mkdir({ path: "." })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
      return
    }

    openProject(s, directory)
  }

  function chooseProject() {
    const s = server.current
    if (!s) return

    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(s, directory)
        }
        return
      }
      if (result) openProject(s, result)
    }

    pickDirectory({
      server: s,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            [serverDotClass()]: true,
          }}
        />
        {server.name}
      </Button>
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <div class="flex gap-2 items-center">
                <Button icon="prompt" size="normal" class="pl-2 pr-3" onClick={startFolderlessChat}>
                  {language.t("home.newChat")}
                </Button>
                <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                  {language.t("command.project.open")}
                </Button>
              </div>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(server.current!, project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync.ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <div class="flex gap-2 items-center mt-1">
              <Button icon="prompt" class="px-3" onClick={startFolderlessChat}>
                {language.t("home.newChat")}
              </Button>
              <Button variant="ghost" class="px-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
