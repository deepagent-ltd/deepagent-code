import { Schema } from "effect"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client"
import { McpAuthStore } from "./auth-store"

export const Uri = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    if (
      Buffer.byteLength(value, "utf8") > 8192 ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      value.includes("#") ||
      !URL.canParse(value)
    )
      return false
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash
  }),
)
export const Issuer = Uri.check(Schema.makeFilter((value) => !value.includes("?")))

export const RegisteredRedirectUris = Schema.Array(Uri).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
  Schema.makeFilter(
    (value) =>
      new Set(value).size === value.length &&
      value.reduce((total, uri) => total + Buffer.byteLength(uri, "utf8"), 0) <= 16384,
  ),
)

export function callbackUri(value: string) {
  if (!Schema.is(Uri)(value)) throw new Error("Invalid OAuth callback URI")
  const url = new URL(value)
  if (["code", "state", "iss", "error", "error_description"].some((key) => url.searchParams.has(key)))
    throw new Error("OAuth callback URI contains a reserved response parameter")
  return url
}

export function configurationError(config?: { clientId?: string; clientSecret?: string; expectedIssuer?: string }) {
  if (config?.clientSecret !== undefined && (!config.clientSecret || !config.clientId))
    return "Set oauth.clientId and a non-empty oauth.clientSecret for this MCP server."
  if (config?.clientSecret !== undefined && !config.expectedIssuer)
    return "Set oauth.expectedIssuer to the authorization server issuer URL before using oauth.clientSecret."
  if (config?.expectedIssuer !== undefined && !Schema.is(Issuer)(config.expectedIssuer))
    return "Set oauth.expectedIssuer to an HTTP(S) issuer URL without credentials, query or fragment."
}

export class IssuerError extends Error {
  constructor() {
    super("OAuth issuer differs from oauth.expectedIssuer; verify configuration before authenticating.")
    this.name = "McpOAuthIssuerError"
  }
}

export const Discovery = Schema.Struct({
  authorizationServerUrl: Issuer,
  authorizationServerMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  resourceMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  resourceMetadataUrl: Schema.optional(Uri),
})
export type Discovery = typeof Discovery.Type

/** The SDK's actual public OAuth/OpenID schemas own metadata semantics. Persisted cache is
 * untrusted input; a typed JSON record alone is never a validated issuer or endpoint. */
export async function parse(input: unknown): Promise<OAuthDiscoveryState> {
  if (!Schema.is(Discovery)(input)) throw new McpAuthStore.Error("invalid")
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32768) throw new McpAuthStore.Error("capacity")
  const { OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema, OAuthProtectedResourceMetadataSchema } =
    await import("@modelcontextprotocol/core")
  const metadata =
    input.authorizationServerMetadata === undefined
      ? undefined
      : OAuthMetadataSchema.or(OpenIdProviderDiscoveryMetadataSchema).safeParse(input.authorizationServerMetadata)
  const resource =
    input.resourceMetadata === undefined
      ? undefined
      : OAuthProtectedResourceMetadataSchema.safeParse(input.resourceMetadata)
  if (metadata?.success === false || resource?.success === false) throw new McpAuthStore.Error("invalid")
  if (metadata?.success && !sameIssuer(metadata.data.issuer, input.authorizationServerUrl))
    throw new McpAuthStore.Error("invalid")
  if (metadata?.success && !Schema.is(Issuer)(metadata.data.issuer)) throw new McpAuthStore.Error("invalid")
  if (
    metadata?.success &&
    [metadata.data.authorization_endpoint, metadata.data.token_endpoint, metadata.data.registration_endpoint].some(
      (value) => value !== undefined && !Schema.is(Uri)(value),
    )
  )
    throw new McpAuthStore.Error("invalid")
  if (
    resource?.success &&
    [resource.data.resource, ...(resource.data.authorization_servers ?? [])].some((value) => !Schema.is(Uri)(value))
  )
    throw new McpAuthStore.Error("invalid")
  return {
    authorizationServerUrl: input.authorizationServerUrl,
    ...(metadata?.success ? { authorizationServerMetadata: metadata.data } : {}),
    ...(resource?.success ? { resourceMetadata: resource.data } : {}),
    ...(input.resourceMetadataUrl !== undefined ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
  }
}

export function sameIssuer(left: string, right: string) {
  return (
    left === right ||
    (left.endsWith("/") && left.slice(0, -1) === right) ||
    (right.endsWith("/") && right.slice(0, -1) === left)
  )
}

export function digest(state: Discovery) {
  return createHash("sha256").update(CanonicalJson.stringify(state)).digest("hex")
}

export * as McpOAuthState from "./oauth-state"
