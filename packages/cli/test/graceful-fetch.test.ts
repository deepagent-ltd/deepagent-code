import { describe, expect, it } from "bun:test"
import { gracefulFetch } from "../src/services/graceful-fetch"

describe("gracefulFetch", () => {
  it("passes non-404 responses through untouched", async () => {
    const base = async () => Response.json({ ok: true })
    const response = await gracefulFetch(base)("http://localhost/config")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it("answers 404s on legacy config endpoints with empty defaults", async () => {
    const base = async () => new Response(null, { status: 404 })
    const fetcher = gracefulFetch(base)
    expect(await (await fetcher("http://localhost/config")).json()).toEqual({})
    expect(await (await fetcher("http://localhost/agent")).json()).toEqual([])
    expect(await (await fetcher("http://localhost/config/providers")).json()).toEqual({
      providers: [],
      default: {},
    })
  })

  it("returns the original 404 for paths without a legacy default", async () => {
    const base = async () => new Response("nope", { status: 404 })
    const response = await gracefulFetch(base)("http://localhost/session")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("nope")
  })

  it("resolves the URL when the input is a Request object", async () => {
    const base = async () => new Response(null, { status: 404 })
    const response = await gracefulFetch(base)(new Request("http://localhost/provider"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ all: [], default: {}, connected: [] })
  })

  it("delegates to the injected base fetch — the server-mode transport seam", async () => {
    const seen: string[] = []
    const base = async (input: RequestInfo | URL) => {
      seen.push(new URL(input instanceof Request ? input.url : input).pathname)
      return Response.json({ proxied: true })
    }
    const fetcher = gracefulFetch(base)
    const response = await fetcher("http://gateway/w/session", { method: "POST" })
    expect(seen).toEqual(["/w/session"])
    expect(await response.json()).toEqual({ proxied: true })
    // Bun's preconnect hint is preserved on the wrapper
    expect(fetcher.preconnect).toBe(fetch.preconnect)
  })
})
