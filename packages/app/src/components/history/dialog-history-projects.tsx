import { Component, createMemo, createResource, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Icon } from "@deepagent-code/ui/icon"
import { getFilename } from "@deepagent-code/core/util/path"
import { useLanguage } from "@/context/language"
import "../settings-v2/settings-v2.css"

type ProjectListItem = {
  id: string
  worktree: string
  name?: string
}

type RawSdkClient = {
  client: {
    request<TData>(options: {
      method: string
      url: string
      body?: unknown
      headers?: Record<string, string>
    }): Promise<{ data?: TData }>
  }
}

export const listAllProjects = async (client: RawSdkClient): Promise<ProjectListItem[]> => {
  try {
    const response = await client.client.request<{ items?: ProjectListItem[] } | ProjectListItem[]>({
      method: "GET",
      url: "/global/projects",
    })
    const data = response.data
    if (Array.isArray(data)) return data
    return data?.items ?? []
  } catch {
    // Endpoint missing (stale sidecar build) or transient error — degrade to an
    // empty list instead of surfacing a scary error / crashing the dialog.
    return []
  }
}

export const DialogHistoryProjects: Component<{
  client: RawSdkClient
  activeWorktrees: ReadonlySet<string>
  onOpen: (directory: string) => void
}> = (props) => {
  const language = useLanguage()
  const [items] = createResource(async () => listAllProjects(props.client))

  const historical = createMemo(() => {
    const all = items() ?? []
    // History = projects the user is NOT currently viewing as active.
    return all
      .filter((p) => p.worktree && !props.activeWorktrees.has(p.worktree))
      .sort((a, b) => (a.name ?? a.worktree).localeCompare(b.name ?? b.worktree))
  })

  return (
    <Dialog size="x-large" variant="settings" title={language.t("sidebar.history")}>
      <div class="settings-v2-panel" data-component="history-projects-dialog">
        <div class="settings-v2-tab-body deepagent-dialog-body">
          <p class="text-12-regular text-v2-text-text-faint">
            {language.t("sidebar.history.description")}
          </p>

          <div class="deepagent-dialog-scroll rounded-lg border border-v2-border-border-muted">
            <Show
              when={!items.loading}
              fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("review.loading")}</div>}
            >
              <Show
                when={historical().length > 0}
                fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("review.empty")}</div>}
              >
                <For each={historical()}>
                  {(project) => (
                    <button
                      type="button"
                      data-action="history-project"
                      class="flex w-full items-center gap-3 border-b border-v2-border-border-muted px-3 py-2.5 text-left last:border-b-0 hover:bg-v2-background-bg-layer-01"
                      onClick={() => props.onOpen(project.worktree)}
                    >
                      <Icon name="folder" size="small" class="text-icon-weak" />
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="break-words text-13-medium text-v2-text-text-base">
                          {project.name ?? getFilename(project.worktree)}
                        </span>
                        <span class="break-words text-11-regular text-v2-text-text-faint">{project.worktree}</span>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
