import { createEffect, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { useIMClient } from "@/utils/im-client"
import type { IMAttachment, IMRemoteAttachment } from "./types"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"

export function AttachmentCard(props: {
  attachmentID: string
  local?: { groupID: string; messageID: string }
  remote?: { groupID: string; messageID: string; attachmentID: string }
}) {
  const language = useLanguage()
  const client = useIMClient()
  const [state, setState] = createStore({
    attachment: undefined as IMAttachment | IMRemoteAttachment | undefined,
    url: undefined as string | undefined,
    preview: false,
    busy: false,
    failed: false,
    expired: false,
  })
  let generation = 0
  let disposed = false
  let cacheTimer: ReturnType<typeof setTimeout> | undefined
  let request = new AbortController()

  const release = () => {
    if (cacheTimer !== undefined) clearTimeout(cacheTimer)
    cacheTimer = undefined
    const value = state.url
    if (value) URL.revokeObjectURL(value)
    setState("url", undefined)
    setState("preview", false)
  }

  const lookup = async (signal: AbortSignal) => {
    const value = props.remote
      ? await client.getRemoteAttachment(props.remote, signal)
      : await client.getAttachment(props.attachmentID, signal)
    if (
      props.local &&
      (!("id" in value) || value.groupID !== props.local.groupID || value.messageID !== props.local.messageID)
    )
      throw new Error("media_scope_mismatch")
    return value
  }
  const previewAllowed = (value: IMAttachment | IMRemoteAttachment) =>
    "profile" in value ? ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mime) : value.preview
  createEffect(() => {
    props.attachmentID
    props.remote
    props.local
    client.scope?.()
    request.abort()
    request = new AbortController()
    const run = ++generation
    setState({ attachment: undefined, failed: false, expired: false, busy: false })
    untrack(release)
    void lookup(request.signal)
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
    request.abort()
    release()
  })

  async function open(previewOnly: boolean) {
    // Store values are live proxies; keep this request bound to an immutable descriptor snapshot.
    const value = state.attachment && { ...state.attachment }
    if (!value || state.expired || state.busy) return
    const run = generation
    setState("busy", true)
    setState("failed", false)
    const current = await lookup(request.signal).catch(() => undefined)
    if (disposed || run !== generation) return
    if (!current || JSON.stringify(current) !== JSON.stringify(value) || current.expiresAt <= Date.now()) {
      release()
      setState("busy", false)
      setState("failed", true)
      return
    }
    release()
    const download =
      "profile" in value && props.remote
        ? client.downloadRemoteAttachment(props.remote, value, request.signal)
        : "id" in value
          ? client.downloadAttachment(value, request.signal)
          : Promise.reject(new Error("Attachment is unavailable"))
    const loaded = await download
      .then(async (blob) => {
        if (disposed || run !== generation || value.expiresAt <= Date.now()) return
        if (blob.size !== value.sizeBytes || blob.size > AttachmentPreview.maxBytes) return
        if (previewOnly) {
          if (blob.size > AttachmentPreview.previewBytes) return
          const inspected = AttachmentPreview.inspect(new Uint8Array(await blob.arrayBuffer()))
          if (!inspected || inspected.mime !== value.mime || disposed || run !== generation) return
        }
        const next = URL.createObjectURL(blob)
        setState("url", next)
        cacheTimer = setTimeout(release, Math.min(60_000, value.expiresAt - Date.now()))
        return next
      })
      .catch(() => undefined)
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
    link.download = AttachmentPreview.displayName(value.filename)
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
                when={
                  previewAllowed(value()) &&
                  ["image/png", "image/jpeg"].includes(value().mime) &&
                  value().sizeBytes <= AttachmentPreview.previewBytes
                }
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
                  alt={AttachmentPreview.displayName(value().filename)}
                  class="max-w-full max-h-64 object-contain rounded-md"
                  onError={() => {
                    release()
                    setState("failed", true)
                  }}
                />
              )}
            </Show>
            <Show when={!props.remote}>
              <p class="text-11-regular text-text-weak">{language.t("im.media.localOnly")}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
