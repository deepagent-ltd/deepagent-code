import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform, type SharedBrowserView } from "@/context/platform"
import type { WorkPanelKind } from "@/context/work-panel-state"

export function WorkPanelHome(props: {
  sessionID?: string
  directory: string
  open: (kind: WorkPanelKind, options?: { resourceID?: string }) => void
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const text = (key: string) => language.t(`workPanel.${key}` as Parameters<typeof language.t>[0])
  const [address, setAddress] = createSignal("")
  const [views, setViews] = createSignal<SharedBrowserView[]>([])
  const [error, setError] = createSignal(false)
  let alive = true
  onCleanup(() => {
    alive = false
  })
  createEffect(() => {
    const sessionID = props.sessionID
    const directory = props.directory
    const bridge = platform.sharedBrowser
    setViews([])
    setError(false)
    if (!sessionID || !bridge) return
    let alive = true
    const revisions = new Map<string, number>()
    const receive = (view: SharedBrowserView) => {
      if (
        !alive ||
        view.resource.rootSessionID !== sessionID ||
        view.resource.scope.directory !== directory ||
        view.resource.revision < (revisions.get(view.resource.resourceID) ?? 0)
      )
        return
      revisions.set(view.resource.resourceID, view.resource.revision)
      setViews((old) => [
        ...old.filter((item) => item.resource.resourceID !== view.resource.resourceID),
        ...(view.resource.state !== "closed" ? [view] : []),
      ])
    }
    const dispose = bridge.onState(receive)
    void bridge.list(sessionID).then(
      (items) => {
        if (alive) items.forEach(receive)
      },
      () => {
        if (alive) setError(true)
      },
    )
    onCleanup(() => {
      alive = false
      dispose()
    })
  })
  const label = (kind: WorkPanelKind) =>
    kind === "files"
      ? language.t("session.files.all")
      : kind === "review"
        ? language.t("session.tab.review")
        : kind === "terminal"
          ? language.t("session.panel.terminal")
          : kind === "dev"
            ? language.t("session.panel.debug")
            : kind === "profile"
              ? language.t("session.panel.profile")
              : kind === "context"
                ? language.t("session.context.title")
                : kind === "debug-console"
                  ? language.t("session.panel.debugConsole")
                  : language.t("session.panel.problems")
  return (
    <div class="min-h-0 flex-1 overflow-y-auto" data-slot="work-panel-home">
      <Show when={platform.browser}>
        <form
          class="mx-3 mb-3 flex items-center gap-2 rounded-full bg-surface-raised-base px-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!address().trim()) return
            const sessionID = props.sessionID
            const directory = props.directory
            void Promise.resolve(platform.browser?.navigate(address().trim())).then(
              () => {
                if (alive && props.sessionID === sessionID && props.directory === directory) props.open("browser")
              },
              () => {
                if (alive) setError(true)
              },
            )
          }}
        >
          <Icon name="link" size="small" />
          <input
            class="min-w-0 flex-1 bg-transparent py-2.5 text-12-regular outline-none"
            value={address()}
            placeholder={text("navigate")}
            aria-label={text("address")}
            onInput={(event) => setAddress(event.currentTarget.value)}
          />
        </form>
      </Show>
      <div class="mx-auto max-w-xl px-5 py-6">
        <h3 class="mb-3 text-12-medium text-text-weak">{text("tools")}</h3>
        <div class="grid grid-cols-2 gap-2">
          <For each={["files", "review", "terminal"] as const}>
            {(kind) => (
              <button
                type="button"
                class="flex min-h-11 items-center gap-2 rounded-lg bg-surface-raised-base px-3 py-2 text-left text-13-regular hover:bg-surface-raised-base-hover"
                onClick={() => props.open(kind)}
              >
                <Icon name={kind === "files" ? "file-tree" : kind === "review" ? "review" : "terminal"} />
                {label(kind)}
              </button>
            )}
          </For>
        </div>
        <Show when={platform.sharedBrowser}>
          <section class="mt-7">
            <h3 class="mb-3 text-12-medium text-text-weak">{text("recent")}</h3>
            <For each={views()} fallback={<p class="text-12-regular text-text-weak">{text("emptyPages")}</p>}>
              {(view) => (
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-3 rounded-lg p-2 text-left hover:bg-surface-raised-base-hover"
                  onClick={() => props.open("browser", { resourceID: view.resource.resourceID })}
                >
                  <Icon name="link" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-13-regular">{view.resource.policy.origin}</span>
                    <span class="block text-11-regular text-text-weak">
                      {language.t(`browser.shared.${view.resource.state}` as Parameters<typeof language.t>[0])}
                    </span>
                  </span>
                </button>
              )}
            </For>
          </section>
        </Show>
        <details class="mt-7">
          <summary class="cursor-pointer rounded-md py-2 text-12-medium text-text-weak">{text("diagnostics")}</summary>
          <div class="grid grid-cols-1 gap-1">
            <For each={["dev", "debug-console", "profile", "context", "problems"] as const}>
              {(kind) => (
                <button
                  type="button"
                  class="rounded-md px-2 py-2 text-left text-12-regular hover:bg-surface-raised-base-hover"
                  onClick={() => props.open(kind)}
                >
                  {label(kind)}
                </button>
              )}
            </For>
          </div>
        </details>
        <Show when={error()}>
          <p role="status" class="mt-4 text-12-regular text-text-weak">
            {language.t("common.requestFailed")}
          </p>
        </Show>
      </div>
    </div>
  )
}
