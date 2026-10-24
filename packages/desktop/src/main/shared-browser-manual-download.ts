import type { DownloadItem, Session, WebContents } from "electron"

/** Keeps the original Chromium download alive for the human's stock Save dialog.
 * No path, filename, or file bytes cross into Agent custody. */
export function createSharedBrowserManualDownloads(input: {
  partition: Session
  current: () => { state: string; manualEnabled: boolean; manualEpoch: number }
  owns: (contents: WebContents) => boolean
  approvedOrigins: ReadonlyArray<string> | (() => ReadonlyArray<string>)
}) {
  const downloads = new Map<DownloadItem, { epoch: number; unknown: boolean; done: Promise<void> }>()
  let enabled: { epoch: number; startedAt: number } | undefined
  let closed = false
  const approved = (value: string) => {
    if (!URL.canParse(value) || Buffer.byteLength(value) > 2048) return false
    const url = new URL(value)
    return ["http:", "https:", "blob:"].includes(url.protocol) && !url.username && !url.password &&
      (typeof input.approvedOrigins === "function" ? input.approvedOrigins() : input.approvedOrigins).includes(url.origin)
  }
  input.partition.on("will-download", (event, item, contents) => {
    const current = input.current()
    if (closed || current.state !== "human_owned" || !current.manualEnabled || !enabled ||
      current.manualEpoch !== enabled.epoch || !contents || contents.isDestroyed() || !input.owns(contents) ||
      downloads.size >= 4) { event.preventDefault(); return }
    try {
      const urls = item.getURLChain()
      // The network epoch was quiesced before this manual epoch enabled. An
      // already-created old item cannot acquire the new human ownership later.
      if (!approved(contents.getURL()) || urls.length === 0 || urls.length > 9 || !urls.every(approved) ||
        item.getStartTime() * 1000 < enabled.startedAt) { event.preventDefault(); return }
      const done = Promise.withResolvers<void>()
      const record = { epoch: current.manualEpoch, unknown: false, done: done.promise }
      downloads.set(item, record)
      item.once("done", (_event, state) => {
        if (!["completed", "cancelled", "interrupted"].includes(state)) { record.unknown = true; return }
        downloads.delete(item)
        done.resolve()
      })
      item.on("updated", (_event, state) => { if (state === "interrupted") record.unknown = true })
      // Do not pause, supply a destination, or resume: Electron owns its original
      // synchronous will-download → native Save → same-item terminal sequence.
    } catch {
      event.preventDefault()
    }
  })
  return {
    enable(epoch: number) {
      if (!closed && enabled?.epoch !== epoch) enabled = { epoch, startedAt: Date.now() }
    },
    status(): "active" | "unknown" | undefined {
      if ([...downloads.values()].some((value) => value.unknown)) return "unknown"
      return downloads.size ? "active" : undefined
    },
    async close() {
      closed = true
      const pending = [...downloads].map(([item, value]) => {
        try { item.cancel() }
        catch { value.unknown = true }
        return value.done
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([Promise.all(pending).then(() => downloads.size === 0),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])
      } finally { clearTimeout(timer) }
    },
  }
}
