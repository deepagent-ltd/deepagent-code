import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import type { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"

type View = SharedBrowserTuiSchema.View
type Approval = SharedBrowserTuiSchema.Approve
type Bridge = {
  tuiPending(sessionID: string): Promise<View[]>
  tuiApprove(input: Approval): Promise<View>
  tuiDetach(input: Approval): Promise<View>
  onTuiState(callback: (view: View) => void): () => void
}

/** This panel only approves the exact Main-owned pending connection. A hash or an HTTP
 * request never changes ownership until the real trusted Desktop bridge confirms it. */
export function SharedBrowserTuiPairing(props: { bridge: Bridge; sessionID: string; directory: string }) {
  const language = useLanguage()
  const text = (key: string) => language.t(`browser.tui.${key}` as Parameters<typeof language.t>[0])
  const [state, setState] = createStore({ views: [] as View[], busy: "", error: "", loading: false, expanded: false })
  const visible = () => state.views.filter((view) => view.state !== "retired")
  const pending = () => visible().filter((view) => view.state === "pending").length
  const contentID = `browser-tui-${crypto.randomUUID()}`
  const ranks = { pending: 0, active: 1, retired: 2 }
  let scopeEpoch = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    scopeEpoch++
  })
  const receive = (view: View) => {
    if (disposed || view.rootSessionID !== props.sessionID || view.directory !== props.directory) return
    const prior = state.views.find((item) => item.attachID === view.attachID)
    if (prior && (view.generation !== prior.generation || ranks[view.state] < ranks[prior.state])) return
    setState("views", (views) => {
      if (prior) return views.map((item) => (item.attachID === view.attachID ? view : item))
      const kept = views.length >= 32 ? views.filter((item) => item.state !== "retired") : views
      return kept.length >= 32 ? kept : [...kept, view]
    })
    if (!prior && view.state === "pending") setState("expanded", true)
  }
  createEffect(
    on([() => props.bridge, () => props.sessionID, () => props.directory], () => {
      const epoch = ++scopeEpoch
      const bridge = props.bridge
      const sessionID = props.sessionID
      const directory = props.directory
      let retired = false
      const current = () =>
        !disposed &&
        !retired &&
        scopeEpoch === epoch &&
        props.bridge === bridge &&
        props.sessionID === sessionID &&
        props.directory === directory
      setState({ views: [], busy: "", error: "", loading: true, expanded: false })
      const observe = (view: View) => {
        if (current()) receive(view)
      }
      const unsubscribe = bridge.onTuiState(observe)
      void bridge
        .tuiPending(sessionID)
        .then(
          (views) => views.forEach(observe),
          () => {
            if (current()) setState("error", text("unknown"))
          },
        )
        .finally(() => {
          if (current()) setState("loading", false)
        })
      onCleanup(() => {
        retired = true
        unsubscribe()
      })
    }),
  )
  const refresh = async () => {
    if (disposed || state.busy) return
    const epoch = scopeEpoch
    const bridge = props.bridge
    const sessionID = props.sessionID
    const directory = props.directory
    setState({ loading: true, error: "" })
    try {
      const views = await bridge.tuiPending(sessionID)
      if (
        disposed ||
        scopeEpoch !== epoch ||
        props.bridge !== bridge ||
        props.sessionID !== sessionID ||
        props.directory !== directory
      )
        return
      views.forEach(receive)
    } catch {
      if (
        !disposed &&
        scopeEpoch === epoch &&
        props.bridge === bridge &&
        props.sessionID === sessionID &&
        props.directory === directory
      )
        setState("error", text("unknown"))
    } finally {
      if (
        !disposed &&
        scopeEpoch === epoch &&
        props.bridge === bridge &&
        props.sessionID === sessionID &&
        props.directory === directory
      )
        setState("loading", false)
    }
  }
  const act = async (view: View, action: "approve" | "detach") => {
    if (disposed || state.busy) return
    const epoch = scopeEpoch
    const bridge = props.bridge
    const sessionID = props.sessionID
    const directory = props.directory
    if (view.rootSessionID !== sessionID || view.directory !== directory) return
    const request: Approval = {
      attachID: view.attachID,
      requestID: view.requestID,
      challengeHash: view.challengeHash,
      rootSessionID: sessionID,
      directory,
      expectedGeneration: view.generation,
    }
    setState({ busy: view.attachID, error: "" })
    try {
      const reply = await (action === "approve" ? bridge.tuiApprove(request) : bridge.tuiDetach(request))
      if (
        disposed ||
        scopeEpoch !== epoch ||
        props.bridge !== bridge ||
        props.sessionID !== sessionID ||
        props.directory !== directory
      )
        return
      if (
        reply.attachID !== view.attachID ||
        reply.generation !== view.generation ||
        reply.rootSessionID !== sessionID ||
        reply.directory !== directory
      )
        throw new Error("Stale local terminal connection")
      setState("views", (views) =>
        views.map((item) =>
          item.attachID === reply.attachID && ranks[item.state] <= ranks[reply.state] ? reply : item,
        ),
      )
    } catch {
      if (
        !disposed &&
        scopeEpoch === epoch &&
        props.bridge === bridge &&
        props.sessionID === sessionID &&
        props.directory === directory
      )
        setState("error", text("unknown"))
    } finally {
      if (
        !disposed &&
        scopeEpoch === epoch &&
        props.bridge === bridge &&
        props.sessionID === sessionID &&
        props.directory === directory
      )
        setState("busy", "")
    }
  }
  return (
    <Show when={visible().length > 0 || state.error}>
      <section
        class="flex min-h-0 max-h-[40%] shrink-0 flex-col border-t border-border-weak-base px-3 py-1"
        aria-label={text("title")}
      >
        <Button
          size="small"
          variant="ghost"
          class="w-full justify-between gap-2"
          icon={state.expanded ? "chevron-down" : "chevron-right"}
          aria-expanded={state.expanded}
          aria-controls={contentID}
          onClick={() => setState("expanded", (value) => !value)}
        >
          <span class="text-12-medium">
            {text(state.error ? "attention" : pending() ? "pendingConnections" : "title")}
          </span>
          <span class="text-12-regular text-text-weak">{visible().length || "!"}</span>
        </Button>
        <Show when={state.expanded}>
          <div id={contentID} class="flex min-h-0 flex-col gap-2 overflow-y-auto pb-2 pt-1">
            <p class="text-12-regular text-text-weak">{text("hint")}</p>
            <Show when={state.error}>
              <p role="alert" class="text-12-regular text-text-danger-base">
                {state.error}
              </p>
            </Show>
            <Show when={visible().length === 0}>
              <p class="text-12-regular text-text-weak">{text(state.loading ? "loading" : "empty")}</p>
            </Show>
            <For each={visible()}>
              {(view) => (
                <div
                  class="flex flex-col gap-2 rounded-md border border-border-weak-base p-2"
                  data-tui-attach-id={view.attachID}
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-12-medium text-text-base">{text(view.state)}</span>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!!state.busy || (view.state === "pending" && !view.streamLive)}
                      onClick={() => void act(view, view.state === "pending" ? "approve" : "detach")}
                    >
                      {text(state.busy === view.attachID ? "working" : view.state === "pending" ? "approve" : "detach")}
                    </Button>
                  </div>
                  <code class="break-all select-text text-12-regular text-text-base" aria-label={text("challenge")}>
                    {view.challengeHash}
                  </code>
                  <span class="break-all text-12-regular text-text-weak">{view.directory}</span>
                </div>
              )}
            </For>
            <Button
              size="small"
              variant="ghost"
              disabled={!!state.busy || state.loading}
              onClick={() => void refresh()}
            >
              {text("refresh")}
            </Button>
          </div>
        </Show>
      </section>
    </Show>
  )
}
