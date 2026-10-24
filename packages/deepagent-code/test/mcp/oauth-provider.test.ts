import { test, expect, describe } from "bun:test"
import { McpOAuthProvider, OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, currentEntry } from "../../src/mcp/oauth-provider"
import { Effect } from "effect"
import type { McpAuth } from "../../src/mcp/auth"

// Stub auth — only synchronous getters are exercised in these tests
const stubAuth = {} as McpAuth.Interface

const makeProvider = (config: ConstructorParameters<typeof McpOAuthProvider>[2]) =>
  new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", config, { onRedirect: async () => {} }, stubAuth)

describe("McpOAuthProvider.redirectUrl", () => {
  test("defaults to 127.0.0.1:19876/mcp/oauth/callback", () => {
    const provider = makeProvider({})
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`)
  })

  test("uses callbackPort when set", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`)
  })

  test("redirectUri takes precedence over callbackPort", () => {
    const provider = makeProvider({
      callbackPort: 6620,
      redirectUri: "http://127.0.0.1:9999/custom/callback",
    })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:9999/custom/callback")
  })

  test("uses explicit redirectUri when set without callbackPort", () => {
    const provider = makeProvider({ redirectUri: "http://127.0.0.1:8080/oauth/callback" })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8080/oauth/callback")
  })
})

describe("McpOAuthProvider.clientMetadata", () => {
  test("includes redirect_uris from redirectUrl", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.clientMetadata.redirect_uris).toEqual([`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`])
  })

  test("includes scope when set in config", () => {
    const provider = makeProvider({ scope: "openid offline_access" })
    expect(provider.clientMetadata.scope).toBe("openid offline_access")
  })

  test("omits scope when not set in config", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.scope).toBeUndefined()
  })

  test("sets token_endpoint_auth_method to client_secret_post when clientSecret provided", () => {
    const provider = makeProvider({ clientSecret: "secret" })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  })

  test("sets token_endpoint_auth_method to none when no clientSecret", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none")
  })
})

describe("McpOAuthProvider scoped current entry", () => {
  const url = "https://mcp.example.com/mcp"
  const entry: McpAuth.Entry = {
    serverUrl: url,
    authorizationGeneration: "generation-current",
    tokens: { accessToken: "synthetic-token", issuer: "https://issuer.example.com" },
    clientInfo: { clientId: "synthetic-client", issuer: "https://issuer.example.com" },
  }

  test("uses one freshly fenced entry for each token and client read without caching", async () => {
    const reads = { count: 0 }
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      {},
      {
        onRedirect: async () => {},
        authorizationGeneration: entry.authorizationGeneration,
        currentEntry: async () => {
          reads.count++
          return { ...entry }
        },
      },
      stubAuth,
    )
    expect((await provider.tokens())?.access_token).toBe("synthetic-token")
    expect(reads.count).toBe(1)
    expect((await provider.clientInformation())?.client_id).toBe("synthetic-client")
    expect(reads.count).toBe(2)
    expect((await provider.tokens())?.access_token).toBe("synthetic-token")
    expect(reads.count).toBe(3)
  })

  test("rejects missing or mismatched generation and a mismatched resource", async () => {
    for (const value of [
      undefined,
      { ...entry, authorizationGeneration: "old" },
      { ...entry, serverUrl: "https://other.example/mcp" },
    ]) {
      const provider = new McpOAuthProvider(
        "test-server",
        url,
        {},
        {
          onRedirect: async () => {},
          authorizationGeneration: entry.authorizationGeneration,
          currentEntry: async () => value,
        },
        stubAuth,
      )
      await expect(provider.tokens()).rejects.toThrow("MCP OAuth flow was revoked")
    }
  })

  test("propagates a failed fenced read without a fallback or stale credential", async () => {
    const reads = { fallback: 0 }
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      {},
      {
        onRedirect: async () => {},
        authorizationGeneration: entry.authorizationGeneration,
        currentEntry: async () => {
          throw new Error("scope-read-failed")
        },
      },
      {
        ...stubAuth,
        getForUrl: () =>
          Effect.sync(() => {
            reads.fallback++
            return entry
          }),
      },
    )
    await expect(provider.tokens()).rejects.toThrow("scope-read-failed")
    expect(reads.fallback).toBe(0)
  })

  test("checks invalid configuration before reading a scoped entry", async () => {
    const reads = { count: 0 }
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      { clientSecret: "synthetic-secret" },
      {
        onRedirect: async () => {},
        currentEntry: async () => {
          reads.count++
          return entry
        },
      },
      stubAuth,
    )
    await expect(provider.tokens()).rejects.toThrow("oauth.clientId")
    expect(reads.count).toBe(0)
  })

  test("preserves the legacy current and getForUrl checks", async () => {
    const reads = { scope: 0, entry: 0 }
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      {},
      {
        onRedirect: async () => {},
        authorizationGeneration: entry.authorizationGeneration,
        current: async () => {
          reads.scope++
          return true
        },
      },
      {
        ...stubAuth,
        getForUrl: (name, resource) =>
          Effect.sync(() => {
            expect(name).toBe("test-server")
            expect(resource).toBe(url)
            reads.entry++
            return entry
          }),
      },
    )
    expect((await provider.tokens())?.access_token).toBe("synthetic-token")
    expect(reads.scope).toBe(2)
    expect(reads.entry).toBe(3)
  })

  test("rejects an already revoked owner before the actual scoped read", async () => {
    const reads = { count: 0 }
    const read = currentEntry(
      async () => {
        reads.count++
        return entry
      },
      () => false,
    )
    await expect(read()).rejects.toThrow("MCP OAuth flow was revoked")
    expect(reads.count).toBe(0)
  })

  test("rejects owner revocation during the actual awaited scoped read", async () => {
    const owner = { current: true }
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<McpAuth.Entry | undefined>()
    const read = currentEntry(
      () => {
        started.resolve()
        return pending.promise
      },
      () => owner.current,
    )
    const result = read()
    await started.promise
    owner.current = false
    pending.resolve(entry)
    await expect(result).rejects.toThrow("MCP OAuth flow was revoked")
  })

  test("propagates the scoped reader failure before any stale success", async () => {
    const read = currentEntry(
      async () => {
        throw new Error("scoped-entry-closed")
      },
      () => true,
    )
    await expect(read()).rejects.toThrow("scoped-entry-closed")
  })
})

describe("McpOAuthProvider scoped readonly entry", () => {
  const url = "https://mcp.example.com/mcp"
  const entry: McpAuth.Entry = {
    serverUrl: url,
    authorizationGeneration: "generation-current",
    codeVerifier: "synthetic-verifier",
    oauthState: "synthetic-state",
  }

  test("reuses one scoped entry per verifier, state and empty discovery read without legacy lookups", async () => {
    const reads = { entry: 0, lookup: 0 }
    const lookup = () =>
      Effect.sync(() => {
        reads.lookup++
        return entry
      })
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      {},
      {
        onRedirect: async () => {},
        authorizationGeneration: entry.authorizationGeneration,
        currentEntry: async () => {
          reads.entry++
          return entry
        },
      },
      { ...stubAuth, get: lookup, getForUrl: lookup },
    )
    expect(await provider.codeVerifier()).toBe("synthetic-verifier")
    expect(reads.entry).toBe(1)
    expect(await provider.state()).toBe("synthetic-state")
    expect(reads.entry).toBe(2)
    expect(await provider.discoveryState()).toBeUndefined()
    expect(reads.entry).toBe(3)
    expect(reads.lookup).toBe(0)
  })

  test("keeps legacy get for verifier/state and URL lookup for discovery with both current fences", async () => {
    const reads = { get: 0, url: 0, current: 0 }
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      {},
      {
        onRedirect: async () => {},
        current: async () => {
          reads.current++
          return true
        },
      },
      {
        ...stubAuth,
        get: (name) =>
          Effect.sync(() => {
            expect(name).toBe("test-server")
            reads.get++
            return entry
          }),
        getForUrl: (name, resource) =>
          Effect.sync(() => {
            expect(name).toBe("test-server")
            expect(resource).toBe(url)
            reads.url++
            return entry
          }),
      },
    )
    expect(await provider.codeVerifier()).toBe("synthetic-verifier")
    expect(await provider.state()).toBe("synthetic-state")
    expect(await provider.discoveryState()).toBeUndefined()
    expect(reads).toEqual({ get: 2, url: 1, current: 6 })
  })

  test("performs a fresh current check after actual asynchronous discovery parsing", async () => {
    const reads = { count: 0 }
    const discovered = { ...entry, discoveryState: { authorizationServerUrl: "https://issuer.example.com" } }
    const provider = new McpOAuthProvider(
      "test-server",
      url,
      {},
      {
        onRedirect: async () => {},
        authorizationGeneration: entry.authorizationGeneration,
        currentEntry: async () => {
          reads.count++
          if (reads.count > 1) throw new Error("MCP OAuth flow was revoked")
          return discovered
        },
      },
      stubAuth,
    )
    await expect(provider.discoveryState()).rejects.toThrow("MCP OAuth flow was revoked")
    expect(reads.count).toBe(2)
  })
})
