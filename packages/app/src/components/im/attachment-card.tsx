import { createEffect, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { useIMClient } from "@/utils/im-client"
import type { IMAttachment } from "./types"

export function AttachmentCard(props: { attachmentID: string }) {
  const language = useLanguage()
  const client = useIMClient()
  const [state, setState] = createStore({
    attachment: undefined as IMAttachment | undefined,
    url: undefined as string | undefined,
    preview: false,
    busy: false,
    failed: false,
    expired: false,
  })
  let generation = 0
  let disposed = false
  let cacheTimer: ReturnType<typeof setTimeout> | undefined

  const release = () => {
    if (cacheTimer !== undefined) clearTimeout(cacheTimer)
    cacheTimer = undefined
    const value = state.url
    if (value) URL.revokeObjectURL(value)
    setState("url", undefined)
    setState("preview", false)
  }

  createEffect(() => {
    const id = props.attachmentID
    const run = ++generation
    setState({ attachment: undefined, failed: false, expired: false, busy: false })
    untrack(release)
    void client
      .getAttachment(id)
      .then((value) => {
        if (disposed || run !== generation) return
        setState("attachment", value)
      })
      .catch(() => {
        if (!disposed && run === generation) setState("failed", true)
      })
  })
  createEffect(() => {
    const value = state.attachment
    if (!value) return
    const expire = () => {
      release()
      setState("expired", true)
    }
    if (value.expiresAt <= Date.now()) {
      untrack(expire)
      return
    }
    const timer = setTimeout(expire, value.expiresAt - Date.now())
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => {
    disposed = true
    generation++
    release()
  })

  async function open(previewOnly: boolean) {
    // Store values are live proxies; keep this request bound to an immutable descriptor snapshot.
    const value = state.attachment && { ...state.attachment }
    if (!value || state.expired || state.busy) return
    const run = generation
    setState("busy", true)
    setState("failed", false)
    const current = await client.getAttachment(value.id).catch(() => undefined)
    if (disposed || run !== generation) return
    if (!current || current.checksum !== value.checksum || current.expiresAt <= Date.now()) {
      release()
      setState("busy", false)
      setState("failed", true)
      return
    }
    const loaded =
      state.url ??
      (await client
        .downloadAttachment(value)
        .then((blob) => {
          if (disposed || run !== generation || value.expiresAt <= Date.now()) return
          const next = URL.createObjectURL(blob)
          setState("url", next)
          cacheTimer = setTimeout(release, Math.min(60_000, value.expiresAt - Date.now()))
          return next
        })
        .catch(() => undefined))
    if (disposed || run !== generation) return
    setState("busy", false)
    if (!loaded || value.expiresAt <= Date.now()) {
      setState("failed", true)
      return
    }
    if (previewOnly) {
      setState("preview", true)
      return
    }
    const link = document.createElement("a")
    link.href = loaded
    link.download = value.filename
    link.click()
  }

  return (
    <div class="flex flex-col gap-2 min-w-0" aria-label={language.t("im.media.attachment")}>
      <Show
        when={state.attachment}
        fallback={<span role="status">{language.t(state.failed ? "im.media.unavailable" : "im.loading")}</span>}
      >
        {(value) => (
          <>
            <p class="text-11-regular text-text-weak break-all">
              {value().mime} · {value().sizeBytes.toLocaleString()} B
            </p>
            <Show when={state.expired}>
              <p role="status">{language.t("im.media.expired")}</p>
            </Show>
            <Show when={state.failed}>
              <p role="alert">{language.t("im.media.unavailable")}</p>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Button size="small" disabled={state.busy || state.expired} onClick={() => void open(false)}>
                {language.t("im.media.download")}
              </Button>
              <Show
                when={value().preview && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value().mime)}
              >
                <Button size="small" disabled={state.busy || state.expired} onClick={() => void open(true)}>
                  {language.t("im.media.preview")}
                </Button>
              </Show>
            </div>
            <Show when={state.preview && state.url}>
              {(source) => (
                <img
                  src={source()}
                  alt={value().filename}
                  class="max-w-full max-h-64 object-contain rounded-md"
                  onError={() => {
                    release()
                    setState("failed", true)
                  }}
                />
              )}
            </Show>
            <p class="text-11-regular text-text-weak">{language.t("im.media.localOnly")}</p>
          </>
        )}
      </Show>
    </div>
  )
}
