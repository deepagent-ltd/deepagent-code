import { Component, createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import type { BrowserViewState } from "@/context/platform"

// U7 (S1 §P2): the renderer-side chrome for the isolated browser. The actual web content is a
// WebContentsView drawn by the MAIN process over the rect this panel occupies — the renderer only
// owns the address bar + nav buttons + bounds reporting. There is NO content bridge: this component
// can read url/title (for the address bar) but never the page DOM/body. When the panel unmounts or
// the mode changes, the view is hidden.
export const SidePanelBrowser: Component<{ onClose: () => void }> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const browser = platform.browser

  const [state, setState] = createSignal<BrowserViewState>({
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
  })
  const [address, setAddress] = createSignal("")
  let container: HTMLDivElement | undefined

  const reportBounds = () => {
    if (!container || !browser) return
    const r = container.getBoundingClientRect()
    void browser.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
  }

  onMount(() => {
    if (!browser) return
    const off = browser.onState((s) => {
      setState(s)
      // keep the address bar in sync unless the user is mid-edit (input focused)
      if (document.activeElement?.tagName !== "INPUT") setAddress(s.url === "about:blank" ? "" : s.url)
    })
    const ro = new ResizeObserver(() => reportBounds())
    if (container) ro.observe(container)
    window.addEventListener("resize", reportBounds)
    // show over the container rect
    if (container) {
      const r = container.getBoundingClientRect()
      void browser.show({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
    }
    onCleanup(() => {
      off()
      ro.disconnect()
      window.removeEventListener("resize", reportBounds)
      void browser.hide()
    })
  })

  const go = () => {
    if (!browser) return
    void browser.navigate(address())
  }

  return (
    <div class="h-full w-full min-w-0 flex flex-col bg-background-base">
      <div class="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-border-weak">
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
          class="flex-1 min-w-0"
          value={address()}
          placeholder={language.t("browser.address")}
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go()
          }}
        />
        <IconButton
          icon="share"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={() => browser?.openExternal()}
          aria-label={language.t("browser.openExternal")}
        />
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>
      {/* The WebContentsView is overlaid by the main process on this region. */}
      <div ref={container} class="flex-1 min-h-0">
        <Show when={!browser}>
          <div class="h-full flex items-center justify-center text-center">
            <div class="text-12-regular text-text-weak">{language.t("browser.desktopOnly")}</div>
          </div>
        </Show>
      </div>
    </div>
  )
}
