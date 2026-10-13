import { Effect } from "effect"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"

/** The SDK, provider and credential file are real. Only desktop opening is separately replaced
 * by browser-event tests, so these fixtures never launch the user's browser or external account. */
export const oauthHttp = Effect.gen(function* () {
  const control: { open: boolean; resourcesOnly: boolean } = { open: false, resourcesOnly: false }
  const methods: string[] = []
  const requests: string[] = []
  const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const callbackPort = callback.port!
  yield* Effect.promise(() => callback.stop(true))
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname.includes("oauth-protected-resource"))
        return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
      if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration"))
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      if (url.pathname === "/token")
        return Response.json({ access_token: "synthetic-fixture-token", token_type: "Bearer", expires_in: 600 })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (request.method === "GET") return new Response(null, { status: 405 })
      if (!control.open)
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          },
        })
      const body = (await request.json()) as { id?: number; method: string }
      methods.push(body.method)
      if (body.id === undefined) return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: control.resourcesOnly ? { resources: {} } : { tools: {} },
                serverInfo: { name: "oauth-fixture", version: "1" },
              }
            : body.method === "resources/list"
              ? { resources: [{ name: "docs", uri: "docs://readme" }] }
              : body.method === "tools/list"
                ? { tools: [] }
                : {},
      })
    },
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await McpOAuthCallback.stop()
      await listener.stop(true)
    }),
  )
  return {
    control,
    methods,
    requests,
    config: {
      type: "remote" as const,
      url: new URL("/mcp", listener.url).href,
      oauth: { clientId: "fixture-client", callbackPort },
      timeout: 1500,
    },
  }
})
