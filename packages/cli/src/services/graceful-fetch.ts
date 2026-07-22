const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

// Older daemons miss a few config endpoints; answer those 404s with empty
// defaults so the TUI still boots against them. Wraps any base fetch — the
// local daemon's or the server-mode gateway transport's.
export const gracefulFetch = (base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init)
      if (response.status !== 404) return response
      // Server-mode requests arrive under the bare /w proxy prefix; strip it so
      // the same legacy endpoints match in both daemon and gateway mode.
      const pathname = new URL(input instanceof Request ? input.url : input).pathname.replace(/^\/w(?=\/|$)/, "")
      const fallback = legacyDefaults[pathname]
      if (fallback === undefined) return response
      return Response.json(fallback)
    },
    { preconnect: fetch.preconnect },
  )

export * as GracefulFetch from "./graceful-fetch"
