import type { OAuthClientProvider } from "@modelcontextprotocol/client"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientInformationContext,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/client"
import { Effect, Schema } from "effect"
import { McpAuth } from "./auth"
import { McpOAuthState } from "./oauth-state"
import * as Log from "@deepagent-code/core/util/log"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  expectedIssuer?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
  current?: () => boolean | Promise<boolean>
  authorizationGeneration?: string
  interactive?: boolean
}

export class McpOAuthProvider implements OAuthClientProvider {
  private writes = new Set<Promise<void>>()

  async settled(): Promise<void> {
    await Promise.allSettled([...this.writes])
  }

  private async requireCurrent() {
    const error = McpOAuthState.configurationError(this.config)
    if (error) throw new Error(error)
    if (this.callbacks.current && !(await this.callbacks.current())) throw new Error("MCP OAuth flow was revoked")
    if (this.callbacks.authorizationGeneration !== undefined) {
      const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
      if (entry?.authorizationGeneration !== this.callbacks.authorizationGeneration)
        throw new Error("MCP OAuth flow was revoked")
    }
  }

  private persist(effect: Effect.Effect<void>) {
    const write = this.requireCurrent().then(() => Effect.runPromise(effect))
    this.writes.add(write)
    return write.finally(() => this.writes.delete(write))
  }
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private auth: McpAuth.Interface,
  ) {}

  private requireIssuer(issuer: string) {
    if (this.config.expectedIssuer && !McpOAuthState.sameIssuer(this.config.expectedIssuer, issuer))
      throw new McpOAuthState.IssuerError()
  }

  get redirectUrl(): string {
    if (this.config.redirectUri) {
      return this.config.redirectUri
    }
    const port = this.config.callbackPort ?? OAUTH_CALLBACK_PORT
    return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "DeepAgent Code",
      client_uri: "https://ai.deepagent.ltd",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<OAuthClientInformation | undefined> {
    await this.requireCurrent()
    if (ctx) this.requireIssuer(ctx.issuer)
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    await this.requireCurrent()
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      const issuer =
        this.config.expectedIssuer ??
        (entry?.clientInfo?.clientId === this.config.clientId ? entry.clientInfo.issuer : undefined)
      if (issuer !== undefined && !Schema.is(McpOAuthState.Issuer)(issuer))
        throw new Error("Invalid pre-registered OAuth issuer")
      if (issuer && ctx && !McpOAuthState.sameIssuer(issuer, ctx.issuer)) throw new McpOAuthState.IssuerError()
      if (!issuer && ctx && this.callbacks.authorizationGeneration !== undefined) {
        const discovery = await this.discoveryState()
        const selected = discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl
        if (!selected || !McpOAuthState.sameIssuer(selected, ctx.issuer))
          throw new Error("OAuth issuer discovery is unavailable")
        await this.saveClientInformation({
          client_id: this.config.clientId,
          issuer: ctx.issuer,
          redirect_uris: [this.redirectUrl],
        })
        return { client_id: this.config.clientId, issuer: ctx.issuer }
      }
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...(issuer ? { issuer } : {}),
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    if (entry?.clientInfo?.issuer && (!ctx || McpOAuthState.sameIssuer(entry.clientInfo.issuer, ctx.issuer))) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
        issuer: entry.clientInfo.issuer,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    if (!Schema.is(McpOAuthState.Issuer)(info.issuer)) throw new Error("OAuth client issuer is required")
    this.requireIssuer(info.issuer)
    const registered = this.config.clientId
      ? undefined
      : Schema.decodeUnknownSync(McpOAuthState.RegisteredRedirectUris)(info.redirect_uris)
    if (registered && !registered.includes(this.redirectUrl))
      throw new Error("OAuth registration did not confirm the current callback URI")
    await this.persist(
      this.auth.updateClientInfo(
        this.mcpName,
        {
          clientId: info.client_id,
          clientSecret: info.client_secret,
          clientIdIssuedAt: info.client_id_issued_at,
          clientSecretExpiresAt: info.client_secret_expires_at,
          issuer: info.issuer,
          ...(registered ? { registeredRedirectUris: registered } : {}),
        },
        this.serverUrl,
        this.callbacks.authorizationGeneration,
      ),
    )
    log.info("saved dynamically registered client", { mcpName: this.mcpName })
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<OAuthTokens | undefined> {
    await this.requireCurrent()
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    await this.requireCurrent()
    if (!entry?.tokens?.issuer || (ctx && !McpOAuthState.sameIssuer(entry.tokens.issuer, ctx.issuer))) return undefined
    if (this.config.expectedIssuer && !McpOAuthState.sameIssuer(this.config.expectedIssuer, entry.tokens.issuer))
      return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in:
        entry.tokens.expiresAt !== undefined
          ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
          : undefined,
      scope: entry.tokens.scope,
      issuer: entry.tokens.issuer,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (!Schema.is(McpOAuthState.Issuer)(tokens.issuer)) throw new Error("OAuth token issuer is required")
    this.requireIssuer(tokens.issuer)
    await this.persist(
      this.auth.updateTokens(
        this.mcpName,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in !== undefined ? Date.now() / 1000 + tokens.expires_in : undefined,
          scope: tokens.scope,
          issuer: tokens.issuer,
        },
        this.serverUrl,
        this.callbacks.authorizationGeneration,
      ),
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.requireCurrent()
    if (this.callbacks.interactive === false) throw new Error("OAuth authorization must be started explicitly")
    if (!this.config.clientId) {
      const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
      if (!entry?.clientInfo?.registeredRedirectUris?.includes(this.redirectUrl))
        throw new Error(
          "OAuth callback registration is not verified; explicitly clear authentication before registering again",
        )
    }
    if (authorizationUrl.searchParams.get("redirect_uri") !== this.redirectUrl)
      throw new Error("OAuth authorization callback URI changed")
    if (this.callbacks.authorizationGeneration !== undefined)
      await this.persist(this.auth.freezeDiscovery(this.mcpName, this.callbacks.authorizationGeneration))
    log.info("redirecting to authorization", { mcpName: this.mcpName })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.persist(
      this.auth.updateCodeVerifier(this.mcpName, codeVerifier, this.serverUrl, this.callbacks.authorizationGeneration),
    )
  }

  async codeVerifier(): Promise<string> {
    await this.requireCurrent()
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    await this.requireCurrent()
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await this.persist(
      this.auth.updateOAuthState(this.mcpName, state, this.serverUrl, this.callbacks.authorizationGeneration),
    )
  }

  async state(): Promise<string> {
    await this.requireCurrent()
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    await this.requireCurrent()
    if (entry?.oauthState) {
      return entry.oauthState
    }

    // Generate a new state if none exists — the SDK calls state() as a
    // generator, not just a reader, so we need to produce a value even when
    // startAuth() hasn't pre-saved one (e.g. during automatic auth on first
    // connect).
    const newState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await this.persist(
      this.auth.updateOAuthState(this.mcpName, newState, this.serverUrl, this.callbacks.authorizationGeneration),
    )
    return newState
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.requireCurrent()
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    await this.requireCurrent()
    if (!entry?.discoveryState) return undefined
    const state = await McpOAuthState.parse(entry.discoveryState)
    this.requireIssuer(state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl)
    await this.requireCurrent()
    return state
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.requireCurrent()
    const parsed = await McpOAuthState.parse(state)
    this.requireIssuer(parsed.authorizationServerMetadata?.issuer ?? parsed.authorizationServerUrl)
    await this.requireCurrent()
    await this.persist(
      this.auth.updateDiscoveryState(this.mcpName, parsed, this.serverUrl, this.callbacks.authorizationGeneration),
    )
  }

  async validateCallback(iss?: string): Promise<void> {
    const discovery = await this.discoveryState()
    if (!discovery) throw new Error("MCP OAuth callback discovery is unavailable; restart authentication")
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    if (
      this.callbacks.authorizationGeneration !== undefined &&
      entry?.authorizationDiscoveryHash !== McpOAuthState.digest(discovery)
    )
      throw new Error("MCP OAuth callback discovery changed; restart authentication")
    const { validateAuthorizationResponseIssuer } = await import("@modelcontextprotocol/client")
    validateAuthorizationResponseIssuer({
      iss,
      expectedIssuer: discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl,
      issParameterSupported:
        discovery.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true,
    })
    await this.requireCurrent()
  }

  async invalidateCredentials(type: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.requireCurrent()
    log.info("invalidating credentials", { mcpName: this.mcpName, type })
    switch (type) {
      case "all":
        await this.persist(this.auth.clearCredentials(this.mcpName, this.callbacks.authorizationGeneration))
        break
      case "client":
        await this.persist(this.auth.clearClientInfo(this.mcpName, this.callbacks.authorizationGeneration))
        break
      case "tokens":
        await this.persist(this.auth.clearTokens(this.mcpName, this.callbacks.authorizationGeneration))
        break
      case "verifier":
        await this.persist(this.auth.clearCodeVerifier(this.mcpName, this.callbacks.authorizationGeneration))
        break
      case "discovery":
        await this.persist(this.auth.clearDiscoveryState(this.mcpName, this.callbacks.authorizationGeneration))
        break
    }
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }

/**
 * Parse a redirect URI to extract port and path for the callback server.
 * Returns defaults if the URI can't be parsed.
 */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }

  const url = McpOAuthState.callbackUri(redirectUri)
  const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
  const path = url.pathname || OAUTH_CALLBACK_PATH
  return { port, path }
}
