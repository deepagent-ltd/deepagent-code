import { createResource, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useLanguage } from "@/context/language"
import { desktopApi } from "@/utils/desktop-api"

export function GitTimelineDialog(props: {
  workDir: string
  relPath: string
  name: string
  local: boolean
}): ReturnType<typeof Dialog> {
  const language = useLanguage()
  const [result] = createResource(async () => {
    const api = desktopApi()
    // The git timeline reads from a local git binary in the desktop main process. On the web build
    // or against a remote Server Edition sidecar, the local filesystem is not the workspace, so
    // surface that explicitly instead of running git against a path that doesn't exist locally.
    if (!api || !props.local) return { ok: false as const, error: "desktop-only", entries: [] }
    return api.git?.fileLog(props.workDir, props.relPath)
  })

  return (
    <Dialog
      title={language.t("fileTree.timeline.title", { name: props.name })}
      description={props.relPath}
      size="large"
    >
      <div class="flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto -mx-2">
        <Show
          when={!result.loading}
          fallback={
            <div class="px-3 py-4 text-12-regular text-text-weak">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={result()?.ok && result()!.entries.length > 0}
            fallback={
              <Show
                when={result()?.ok}
                fallback={
                  <div class="px-3 py-4 text-12-regular text-text-weak">
                    {result()?.error ?? language.t("fileTree.timeline.error")}
                  </div>
                }
              >
                <div class="px-3 py-4 text-12-regular text-text-weak">
                  {language.t("fileTree.timeline.empty")}
                </div>
              </Show>
            }
          >
            <For each={result()!.entries}>
              {(entry) => (
                <div class="flex gap-3 px-3 py-2 rounded-md hover:bg-surface-raised-base-hover">
                  <code class="text-12-regular text-text-weak shrink-0">{entry.hash.slice(0, 8)}</code>
                  <div class="min-w-0 flex-1">
                    <div class="text-13-regular text-text-strong truncate">{entry.subject}</div>
                    <div class="text-12-regular text-text-weak truncate">
                      {entry.author} · {entry.date}
                    </div>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
