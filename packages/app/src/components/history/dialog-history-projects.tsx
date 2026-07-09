import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Dialog as ConfirmDialog } from "@deepagent-code/ui/dialog"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Button } from "@deepagent-code/ui/button"
import { DropdownMenu } from "@deepagent-code/ui/dropdown-menu"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { getFilename } from "@deepagent-code/core/util/path"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
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

// Permanently delete a project row (and, by DB cascade, all its sessions/messages).
// Returns true on success. Does NOT touch files on disk — only the database record.
const deleteProject = async (client: RawSdkClient, projectID: string): Promise<boolean> => {
  await client.client.request({
    method: "DELETE",
    url: `/global/projects/${encodeURIComponent(projectID)}`,
  })
  return true
}

const ConfirmDeleteDialog: Component<{
  project: ProjectListItem
  onConfirm: () => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const name = createMemo(() => props.project.name ?? getFilename(props.project.worktree))

  const handleDelete = async () => {
    setBusy(true)
    try {
      await props.onConfirm()
    } finally {
      setBusy(false)
      dialog.close()
    }
  }

  return (
    <ConfirmDialog title={language.t("project.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("project.delete.confirm", { name: name() })}
          </span>
          <span class="text-12-regular text-text-weak">{language.t("project.delete.warning")}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={busy()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={busy()} onClick={handleDelete}>
            {language.t("project.delete.button")}
          </Button>
        </div>
      </div>
    </ConfirmDialog>
  )
}

export const DialogHistoryProjects: Component<{
  client: RawSdkClient
  activeWorktrees: ReadonlySet<string>
  onOpen: (directory: string) => void
  onDeleted?: (worktree: string) => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [items, { mutate }] = createResource(async () => listAllProjects(props.client))

  const historical = createMemo(() => {
    const all = items() ?? []
    // History = projects the user is NOT currently viewing as active.
    return all
      .filter((p) => p.worktree && !props.activeWorktrees.has(p.worktree))
      .sort((a, b) => (a.name ?? a.worktree).localeCompare(b.name ?? b.worktree))
  })

  const confirmDelete = (project: ProjectListItem) => {
    dialog.show(() => (
      <ConfirmDeleteDialog
        project={project}
        onConfirm={async () => {
          try {
            await deleteProject(props.client, project.id)
          } catch (err) {
            showToast({
              variant: "error",
              title: language.t("project.delete.failed.title"),
              description: err instanceof Error ? err.message : String(err),
            })
            return
          }
          // Optimistically drop the deleted project from the list and notify the host so
          // it can close the project locally if it happens to be open.
          mutate((prev) => (prev ?? []).filter((p) => p.id !== project.id))
          props.onDeleted?.(project.worktree)
        }}
      />
    ))
  }

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
                    <div class="group/history-row flex w-full items-center gap-1 border-b border-v2-border-border-muted px-3 py-2.5 last:border-b-0 hover:bg-v2-background-bg-layer-01">
                      <button
                        type="button"
                        data-action="history-project"
                        class="flex min-w-0 flex-1 items-center gap-3 text-left"
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
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          data-action="history-project-menu"
                          aria-label={language.t("common.moreOptions")}
                          class="shrink-0 size-6 rounded-md"
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content>
                            <DropdownMenu.Item
                              data-action="history-project-open"
                              onSelect={() => props.onOpen(project.worktree)}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.open")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              data-action="history-project-delete"
                              onSelect={() => confirmDelete(project)}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </div>
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
