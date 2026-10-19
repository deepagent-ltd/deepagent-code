import { Component, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import type { BrowserViewState, SharedBrowserView } from "@/context/platform"
import { SharedBrowserPreview } from "@/components/shared-browser-preview"
import { SharedBrowserTuiPairing } from "@/components/shared-browser-tui-pairing"

// U7 (S1 §P2): the renderer-side chrome for the isolated browser. The actual web content is a
// WebContentsView drawn by the MAIN process over the rect this panel occupies — the renderer only
// owns the address bar + nav buttons + bounds reporting. There is NO content bridge: this component
// can read url/title (for the address bar) but never the page DOM/body. When the panel unmounts or
// the mode changes, the view is hidden.
export const SidePanelBrowser: Component<{
  onClose: () => void
  sessionID?: string
  directory?: string
  selection?: { resourceID: string; nonce: string }
  onSelectResource?: (resourceID?: string) => void
  personal?: boolean
  hideTabs?: boolean
}> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const browser = platform.browser
  const [shared, setShared] = createStore({
    views: [] as SharedBrowserView[],
    selected: "",
    personal: false,
    loading: false,
    error: "",
  })
  const selected = createMemo(
    () =>
      shared.views.find((view) => view.resource.resourceID === shared.selected) ??
      (shared.selected ? undefined : shared.views[0]),
  )
  const showShared = () => !shared.personal && (!!selected() || !!shared.selected)
  const text = (key: string) => language.t(`browser.shared.${key}` as Parameters<typeof language.t>[0])
  const lists = { refresh: undefined as ((requiredID?: string) => Promise<void>) | undefined }
  createEffect(() => {
    const sessionID = props.sessionID
    const bridge = platform.sharedBrowser
    const directory = props.directory
    const selectedID = untrack(() => props.selection?.resourceID ?? "")
    setShared({ views: [], selected: selectedID, personal: props.personal === true, loading: false, error: "" })
    if (!sessionID || !bridge) return
    let disposed = false
    const revisions = new Map<string, number>()
    const receive = (view: SharedBrowserView) => {
      if (
        disposed ||
        props.sessionID !== sessionID ||
        props.directory !== directory ||
        platform.sharedBrowser !== bridge ||
        view.resource.rootSessionID !== sessionID ||
        view.resource.scope.sessionID !== sessionID ||
        (!!directory && view.resource.scope.directory !== directory) ||
        view.resource.revision < (revisions.get(view.resource.resourceID) ?? 0)
      )
        return
      revisions.set(view.resource.resourceID, view.resource.revision)
      if (
        view.resource.state === "closed" &&
        untrack(() => shared.selected) === view.resource.resourceID &&
        (!props.hideTabs || props.selection?.resourceID !== view.resource.resourceID)
      ) {
        setShared("selected", "")
        props.onSelectResource?.(undefined)
      }
      setShared("views", (views) =>
        view.resource.state === "closed"
          ? views.filter((value) => value.resource.resourceID !== view.resource.resourceID)
          : views.some((value) => value.resource.resourceID === view.resource.resourceID)
            ? views.map((value) => (value.resource.resourceID === view.resource.resourceID ? view : value))
            : [...views, view],
      )
    }
    const unsubscribe = bridge.onState(receive)
    const pending = { list: undefined as Promise<void> | undefined }
    const refresh = (requiredID?: string): Promise<void> => {
      if (disposed) return Promise.resolve()
      if (pending.list)
        return pending.list.then(() => {
          if (
            !disposed &&
            requiredID &&
            shared.selected === requiredID &&
            !shared.views.some((view) => view.resource.resourceID === requiredID)
          )
            return refresh()
        })
      setShared({ loading: true, error: "" })
      pending.list = bridge
        .list(sessionID)
        .then(
          (views) => {
            views.forEach(receive)
          },
          (error: unknown) => {
            if (!disposed && props.sessionID === sessionID)
              setShared("error", error instanceof Error ? error.message : text("unavailable"))
          },
        )
        .finally(() => {
          pending.list = undefined
          if (!disposed) setShared("loading", false)
        })
      return pending.list
    }
    lists.refresh = refresh
    void refresh()
    onCleanup(() => {
      disposed = true
      unsubscribe()
      if (lists.refresh === refresh) lists.refresh = undefined
    })
  })
  createEffect(
    on([() => props.selection?.resourceID, () => props.selection?.nonce], ([resourceID]) => {
      if (!resourceID) return
      setShared({ selected: resourceID, personal: false })
      if (!untrack(() => shared.views.some((view) => view.resource.resourceID === resourceID)))
        void lists.refresh?.(resourceID)
    }),
  )

  const [state, setState] = createSignal<BrowserViewState>({
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
  })
  const [address, setAddress] = createSignal("")
  let container: HTMLDivElement | undefined
  let addressInput: HTMLInputElement | undefined

  let synchronizePersonal: (() => void) | undefined
  const reportBounds = () => synchronizePersonal?.()

  onMount(() => {
    if (!browser) return
    const off = browser.onState((s) => {
      setState(s)
      // A focused WebContentsView leaves the renderer's last active input in place. Only
      // an address input being edited in this focused renderer may retain its draft.
      if (!document.hasFocus() || document.activeElement !== addressInput)
        setAddress(s.url === "about:blank" ? "" : s.url)
    })
    window.addEventListener("resize", reportBounds)
    onCleanup(() => {
      off()
      window.removeEventListener("resize", reportBounds)
      void browser.hide()
    })
  })
  createEffect(() => {
    const hidden = showShared()
    if (!browser) return
    if (hidden) {
      void browser.hide()
      return
    }
    if (!container) return
    const viewport = container
    let disposed = false
    let frame: number | undefined
    let obscured: boolean | undefined
    let previous = ""
    const sync = () => {
      const rect = viewport.getBoundingClientRect()
      // Native child views sit above renderer layers. Only inspect trusted app
      // chrome geometry; the page stays in its original WebContents/partition.
      const blocked = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-component="popover-content"], [data-component="dialog-overlay"], [data-component="dialog"], [data-component="dialog-v2"], [data-component="dropdown-menu-content"], [data-component="dropdown-menu-sub-content"], [data-component="menu-v2-content"]',
        ),
      ].some((element) => {
        if (element.closest('[hidden], [aria-hidden="true"]')) return false
        const style = getComputedStyle(element)
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false
        const overlay = element.getBoundingClientRect()
        return (
          overlay.width > 0 &&
          overlay.height > 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          overlay.left < rect.right &&
          overlay.right > rect.left &&
          overlay.top < rect.bottom &&
          overlay.bottom > rect.top
        )
      })
      if (blocked) {
        if (obscured !== true) void browser.hide()
        obscured = true
        return
      }
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      const key = JSON.stringify(bounds)
      if (obscured !== false) void browser.show(bounds)
      else if (previous !== key) void browser.setBounds(bounds)
      previous = key
      obscured = false
    }
    const schedule = () => {
      if (disposed || frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!disposed) sync()
      })
    }
    synchronizePersonal = schedule
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-expanded", "data-closed", "data-state", "hidden", "aria-hidden", "style", "class"],
    })
    sync()
    onCleanup(() => {
      disposed = true
      observer.disconnect()
      overlays.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (synchronizePersonal === schedule) synchronizePersonal = undefined
    })
  })

  const go = () => {
    if (!browser) return
    void browser.navigate(address())
  }

  return (
    <div class="h-full w-full min-w-0 flex flex-col bg-background-base">
      <Show when={!props.hideTabs}>
        <div
          class="flex h-10 shrink-0 items-center gap-1 border-b border-border-weak-base px-2"
          data-slot="browser-tabs"
        >
          <div
            class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            role="tablist"
            aria-label={text("choose")}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
              const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
              if (index < 0) return
              event.preventDefault()
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
              tabs[next]?.focus()
              tabs[next]?.click()
            }}
          >
            <For each={shared.views}>
              {(view, index) => (
                <button
                  type="button"
                  role="tab"
                  class="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-12-regular transition-colors hover:bg-surface-raised-base-hover"
                  classList={{
                    "bg-surface-raised-base text-text-strong":
                      !shared.personal && selected()?.resource.resourceID === view.resource.resourceID,
                    "text-text-weak": shared.personal || selected()?.resource.resourceID !== view.resource.resourceID,
                  }}
                  aria-selected={!shared.personal && selected()?.resource.resourceID === view.resource.resourceID}
                  tabIndex={!shared.personal && selected()?.resource.resourceID === view.resource.resourceID ? 0 : -1}
                  title={`${view.resource.policy.origin} · ${view.resource.resourceID}`}
                  data-shared-resource-id={view.resource.resourceID}
                  onClick={() => {
                    setShared({ personal: false, selected: view.resource.resourceID })
                    props.onSelectResource?.(view.resource.resourceID)
                  }}
                >
                  <Icon name="window-cursor" size="small" />
                  <span class="max-w-32 truncate">
                    {text("page")}
                    {shared.views.length > 1 ? ` ${index() + 1}` : ""}
                  </span>
                </button>
              )}
            </For>
            <button
              type="button"
              role="tab"
              aria-selected={shared.personal || !showShared()}
              tabIndex={shared.personal || !selected() ? 0 : -1}
              onClick={() => setShared("personal", true)}
              class="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-12-regular transition-colors hover:bg-surface-raised-base-hover"
              classList={{
                "bg-surface-raised-base text-text-strong": shared.personal || !showShared(),
                "text-text-weak": !shared.personal && showShared(),
              }}
            >
              <Icon name="link" size="small" />
              <span class="max-w-32 truncate">{text("personal")}</span>
            </button>
          </div>
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-7 w-7 shrink-0 rounded-md"
            onClick={props.onClose}
            aria-label={text("closePanel")}
            title={text("closePanel")}
          />
        </div>
      </Show>
      <Show when={shared.error}>
        <p role="alert" class="px-3 py-2 text-12-regular text-text-danger-base">
          {shared.error}
        </p>
      </Show>
      <Show when={shared.loading}>
        <p role="status" class="px-3 py-2 text-12-regular text-text-weak">
          {text("loading")}
        </p>
      </Show>
      <Show
        when={showShared() && selected()}
        fallback={
          <Show
            when={!showShared()}
            fallback={
              <p role="status" class="px-3 py-2 text-12-regular text-text-weak">
                {text(shared.loading ? "loading" : "unavailable")}
              </p>
            }
          >
            <>
              <div
                class="h-11 shrink-0 flex items-center gap-1 px-2 border-b border-border-weak-base"
                data-slot="browser-address-bar"
              >
                <IconButton
                  icon="chevron-left"
                  variant="ghost"
                  class="h-7 w-7 rounded-md"
                  disabled={!state().canGoBack}
                  onClick={() => browser?.back()}
                  aria-label={language.t("browser.back")}
                />
                <IconButton
                  icon="chevron-right"
                  variant="ghost"
                  class="h-7 w-7 rounded-md"
                  disabled={!state().canGoForward}
                  onClick={() => browser?.forward()}
                  aria-label={language.t("browser.forward")}
                />
                <IconButton
                  icon="reset"
                  variant="ghost"
                  class="h-7 w-7 rounded-md"
                  onClick={() => browser?.reload()}
                  aria-label={language.t("browser.reload")}
                />
                <InlineInput
                  ref={addressInput}
                  class="flex-1 min-w-0"
                  value={address()}
                  placeholder={language.t("browser.address")}
                  onInput={(e) => setAddress(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return
                    go()
                    e.currentTarget.blur()
                  }}
                />
                <IconButton
                  icon="share"
                  variant="ghost"
                  class="h-7 w-7 rounded-md"
                  onClick={() => browser?.openExternal()}
                  aria-label={language.t("browser.openExternal")}
                />
              </div>
              {/* The WebContentsView is overlaid by the main process on this region. */}
              <div ref={container} class="flex-1 min-h-0" data-slot="personal-browser-viewport">
                <Show when={!browser}>
                  <div class="h-full flex items-center justify-center text-center">
                    <div class="text-12-regular text-text-weak">{language.t("browser.desktopOnly")}</div>
                  </div>
                </Show>
              </div>
            </>
          </Show>
        }
      >
        {(view) => (
          <SharedBrowserPreview
            view={view()}
            bridge={platform.sharedBrowser!}
            onReturnToSession={props.onClose}
            onUpdate={(next) => {
              if (next.resource.rootSessionID !== props.sessionID) return
              if (
                next.resource.state === "closed" &&
                shared.selected === next.resource.resourceID &&
                (!props.hideTabs || props.selection?.resourceID !== next.resource.resourceID)
              ) {
                setShared("selected", "")
                props.onSelectResource?.(undefined)
              }
              setShared("views", (views) =>
                next.resource.state === "closed"
                  ? views.filter((value) => value.resource.resourceID !== next.resource.resourceID)
                  : views.map((value) =>
                      value.resource.resourceID === next.resource.resourceID &&
                      next.resource.revision >= value.resource.revision
                        ? next
                        : value,
                    ),
              )
            }}
          />
        )}
      </Show>
      <Show when={props.sessionID && props.directory && platform.sharedBrowser}>
        <SharedBrowserTuiPairing
          bridge={platform.sharedBrowser!}
          sessionID={props.sessionID!}
          directory={props.directory!}
        />
      </Show>
    </div>
  )
}
