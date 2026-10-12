import { expect, test } from "bun:test"
import { Schema } from "effect"
import { McpOAuthState } from "../../src/mcp/oauth-state"

test("actual SDK metadata schemas reject unsafe persisted OAuth discovery before reuse", async () => {
  const state = {
    authorizationServerUrl: "https://issuer.example",
    authorizationServerMetadata: {
      issuer: "https://issuer.example",
      authorization_endpoint: "https://issuer.example/authorize",
      token_endpoint: "https://issuer.example/token",
      response_types_supported: ["code"],
    },
  }
  expect(await McpOAuthState.parse(state)).toEqual(state)
  for (const value of [
    { ...state, authorizationServerUrl: "https://user:secret@issuer.example" },
    { ...state, authorizationServerUrl: "https://issuer.example#" },
    { ...state, authorizationServerUrl: "https://issuer.example?" },
    { ...state, authorizationServerUrl: "file:///tmp/provider" },
    { ...state, authorizationServerUrl: "https://issuer.example\n" },
    {
      ...state,
      authorizationServerMetadata: { ...state.authorizationServerMetadata, issuer: "https://other.example" },
    },
    {
      ...state,
      authorizationServerMetadata: {
        ...state.authorizationServerMetadata,
        token_endpoint: "https://user:secret@issuer.example/token",
      },
    },
    {
      ...state,
      resourceMetadata: { resource: "https://issuer.example/mcp", authorization_servers: ["file:///tmp/provider"] },
    },
    {
      ...state,
      authorizationServerMetadata: { ...state.authorizationServerMetadata, scopes_supported: ["界".repeat(12000)] },
    },
  ])
    await expect(McpOAuthState.parse(value)).rejects.toBeInstanceOf(Error)
})

test("callback discovery digest covers complete canonical metadata and matches reordered fields", () => {
  const state = {
    authorizationServerUrl: "https://issuer.example",
    authorizationServerMetadata: { issuer: "https://issuer.example", token_endpoint: "https://issuer.example/token" },
  }
  const reordered = {
    authorizationServerMetadata: { token_endpoint: "https://issuer.example/token", issuer: "https://issuer.example" },
    authorizationServerUrl: "https://issuer.example",
  }
  expect(McpOAuthState.digest(state)).toBe(McpOAuthState.digest(reordered))
  expect(McpOAuthState.digest(state)).not.toBe(
    McpOAuthState.digest({
      ...state,
      authorizationServerMetadata: {
        ...state.authorizationServerMetadata,
        token_endpoint: "https://other.example/token",
      },
    }),
  )
})

test("registered callback proof is bounded by URI count, UTF8 bytes and exact unique addresses", () => {
  const valid = Array.from({ length: 8 }, (_, index) => `http://127.0.0.1:1234/callback/${index}`)
  expect(Schema.is(McpOAuthState.RegisteredRedirectUris)(valid)).toBe(true)
  for (const value of [
    [],
    [...valid, "http://127.0.0.1:1234/ninth"],
    [valid[0], valid[0]],
    ["http://user:password@localhost/callback"],
    ["http://127.0.0.1/callback?" + "x".repeat(8192)],
    [0, 1, 2].map((index) => `https://example.invalid/${index}?${"x".repeat(6000)}`),
    ["https://example.invalid/" + "界".repeat(2800)],
  ])
    expect(Schema.is(McpOAuthState.RegisteredRedirectUris)(value)).toBe(false)
  for (const field of ["code", "state", "iss", "error", "error_description"])
    expect(() => McpOAuthState.callbackUri(`http://127.0.0.1/callback?${field}=reserved`)).toThrow()
  expect(McpOAuthState.callbackUri("https://example.invalid/manual?fixed=value").protocol).toBe("https:")
})
