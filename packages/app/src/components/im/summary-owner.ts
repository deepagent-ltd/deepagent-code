import type { IMClient } from "@/utils/im-client"
import type { ServerConnection } from "@/context/server"
import { publishIMNavigation, retireIMNavigation, sameIMConnection } from "./navigation-state"

type PanelReader = { owner: object; refresh: () => Promise<unknown> }
type Registration = { scope: string; connection: ServerConnection.HttpBase; client: IMClient; reader: PanelReader }

// One lightweight observation owner survives the chat view. While the view is
// mounted it delegates to its original reader (which retains paging/proof rules).
// While hidden it observes only the first protected page, never a read cursor.
export function createIMSummaryOwner() {
  let active: { scope: string; connection: ServerConnection.HttpBase; serviceURL?: string | null } | undefined
  let source: Registration | undefined
  let reader: PanelReader | undefined
  let abort = new AbortController()
  let observing = false
  let again = false
  let timer: ReturnType<typeof setInterval> | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const owner = {}
  const current = (captured: Registration, signal: AbortSignal) =>
    !signal.aborted &&
    source === captured &&
    !!active &&
    active.scope === captured.scope &&
    active.serviceURL === captured.client.scope().serviceURL &&
    sameIMConnection(active.connection, captured.connection) &&
    sameIMConnection(captured.client.scope(), captured.connection)
  const refresh = async (): Promise<void> => {
    if (document.visibilityState === "hidden" || !source || !active) return
    if (observing) {
      again = true
      return
    }
    const captured = source
    const signal = abort.signal
    if (!current(captured, signal)) return
    const attached = reader
    observing = true
    try {
      if (attached) {
        await attached.refresh()
        return
      }
      const request = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      const status = await captured.client.facadeStatus(request)
      if (!current(captured, signal) || reader) return
      if (status.facade !== "active" || !status.identity) {
        publishIMNavigation({
          scope: captured.scope,
          connection: captured.connection,
          accountID: "unavailable",
          owner,
          connected: false,
          unread: false,
          current: true,
        })
        return
      }
      const started = performance.now()
      const page = await captured.client.listGroupPage("protected", undefined, request)
      if (!current(captured, signal) || reader) return
      if (!page.reader || (status.reader?.displayEpoch && status.reader.displayEpoch !== page.reader.displayEpoch))
        throw new Error("IM summary scope changed")
      const unread = page.groups.some((group) => {
        const count = group.reader?.liveUnread
        return typeof count === "number" ? count > 0 : typeof count === "string" && /^[1-9][0-9]*$/.test(count)
      })
      publishIMNavigation({
        scope: captured.scope,
        connection: captured.connection,
        accountID: status.service ? JSON.stringify([status.service.url, status.identity.uuid]) : status.identity.uuid,
        owner,
        connected: status.kernel === "connected",
        unread,
        current: unread || !page.hasMore,
      })
      if (expiry) clearTimeout(expiry)
      if (page.reader.nextExpiryAt !== null && page.reader.nextExpiryAt !== undefined) {
        const remaining =
          started + page.reader.nextExpiryAt - (page.reader.validatedServerNow ?? Infinity) - performance.now()
        if (!Number.isFinite(remaining) || remaining <= 0) {
          retireIMNavigation(owner)
          return
        }
        expiry = setTimeout(
          () => {
            retireIMNavigation(owner)
            void refresh()
          },
          Math.min(remaining, 2_147_483_647),
        )
      }
    } catch {
      if (current(captured, signal)) retireIMNavigation(owner)
    } finally {
      observing = false
      if (again) {
        again = false
        queueMicrotask(() => void refresh())
      }
    }
  }
  const visible = () => {
    if (document.visibilityState !== "hidden") void refresh()
  }
  const stop = () => {
    abort.abort()
    if (timer) clearInterval(timer)
    if (expiry) clearTimeout(expiry)
    document.removeEventListener("visibilitychange", visible)
    timer = undefined
    expiry = undefined
    retireIMNavigation(owner)
    if (source) retireIMNavigation(source.reader.owner)
    source = undefined
    reader = undefined
    active = undefined
  }
  return {
    activate(scope: string, connection?: ServerConnection.HttpBase, serviceURL?: string | null) {
      const next = connection ? { scope, connection: { ...connection }, serviceURL } : undefined
      if (
        source &&
        (!next ||
          source.scope !== next.scope ||
          active?.serviceURL !== next.serviceURL ||
          !sameIMConnection(source.connection, next.connection))
      )
        stop()
      active = next
    },
    attach(value: Registration) {
      // A replacement cancels the previous source before admitting new reads.
      stop()
      source = value
      reader = value.reader
      active = { scope: value.scope, connection: value.connection, serviceURL: value.client.scope().serviceURL }
      abort = new AbortController()
      timer = setInterval(() => void refresh(), 30_000)
      document.addEventListener("visibilitychange", visible)
      return () => {
        if (source !== value || reader !== value.reader) return
        reader = undefined
        if (observing) {
          again = true
          return
        }
        void refresh()
      }
    },
    refresh,
    stop,
  }
}

export const imSummaryOwner = createIMSummaryOwner()
