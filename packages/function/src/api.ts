import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { createHash, timingSafeEqual } from "node:crypto"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { ShareAuthorizationError, ShareStore, isValidSessionID, isValidShareID, shortName } from "./store"
import { Subscribers } from "./subscribers"

/**
 * Node-native share/GitHub-App/Feishu backend.
 *
 * Ported off Cloudflare Workers: the Durable Object + R2 bucket are replaced by
 * {@link ShareStore} (filesystem) and {@link Subscribers} (in-process fan-out),
 * and secrets come from `process.env` instead of SST's `Resource`. Route shapes
 * are unchanged so the web viewer (`/share_data`, `/share_poll`) keeps working.
 *
 * The WebSocket endpoint (`/share_poll`) is wired up in `server.ts` because
 * upgrades are handled by the `ws` server, not by hono itself.
 */
const SHARE_DIR = process.env.SHARE_DIR ?? "./.deepagent-share"
export const store = new ShareStore(SHARE_DIR)
export const subscribers = new Subscribers()

export function createApp(input: { store: ShareStore; subscribers: Subscribers; env?: (key: string) => string }) {
  const env = input.env ?? ((key: string) => process.env[key] ?? "")
  const webDomain = env("WEB_DOMAIN") || "localhost:4321"
  return (
    new Hono()
      .use(
        "*",
        bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Request body too large" }, 413) }),
      )
      .get("/", (c) => c.text("Hello, world!"))
      .post("/share_create", async (c) => {
        const createToken = env("SHARE_CREATE_TOKEN")
        if (!createToken) return c.json({ error: "Share creation is not configured" }, { status: 503 })
        const suppliedToken = c.req.header("Authorization")?.replace(/^Bearer /, "")
        if (!suppliedToken || !sameSecret(suppliedToken, createToken))
          return c.json({ error: "Invalid share creation credentials" }, { status: 401 })
        const body = await c.req.json<{ sessionID: string }>()
        if (!isValidSessionID(body.sessionID)) return c.json({ error: "Invalid session ID" }, { status: 400 })
        const sessionID = body.sessionID
        const short = shortName(sessionID)
        const secret = await input.store.share(sessionID)
        const scheme = webDomain.startsWith("localhost") ? "http" : "https"
        return c.json({
          secret,
          url: `${scheme}://${webDomain}/s/${short}`,
        })
      })
      .post("/share_delete", async (c) => {
        const body = await c.req.json<{ sessionID: string; secret: string }>()
        if (!isValidSessionID(body.sessionID) || typeof body.secret !== "string")
          return c.json({ error: "Invalid share credentials" }, { status: 400 })
        const short = shortName(body.sessionID)
        try {
          await input.store.clearAuthorized(short, body.secret)
        } catch (error) {
          if (error instanceof ShareAuthorizationError)
            return c.json({ error: "Invalid share credentials" }, { status: 401 })
          throw error
        }
        return c.json({})
      })
      .post("/share_delete_admin", async (c) => {
        const body = await c.req.json<{ sessionShortName: string; adminSecret: string }>()
        const adminSecret = env("ADMIN_SECRET")
        if (!adminSecret) return c.json({ error: "Admin delete is not configured" }, { status: 503 })
        if (typeof body.adminSecret !== "string" || !sameSecret(body.adminSecret, adminSecret))
          return c.json({ error: "Invalid admin secret" }, { status: 401 })
        if (!isValidShareID(body.sessionShortName)) return c.json({ error: "Invalid share ID" }, { status: 400 })
        await input.store.clear(body.sessionShortName)
        return c.json({})
      })
      .post("/share_sync", async (c) => {
        const body = await c.req.json<{
          sessionID: string
          secret: string
          key: string
          content: unknown
        }>()
        if (!isValidSessionID(body.sessionID) || typeof body.secret !== "string" || typeof body.key !== "string")
          return c.json({ error: "Invalid share update" }, { status: 400 })
        const short = shortName(body.sessionID)
        const entry = await input.store.publish(short, body.secret, body.key, body.content).catch((error) => {
          if (error instanceof ShareAuthorizationError) return
          throw error
        })
        if (!entry) return c.json({ error: "Invalid share credentials" }, { status: 401 })
        input.subscribers.publish(short, entry)
        return c.json({})
      })
      .get("/share_data", async (c) => {
        const id = c.req.query("id")
        if (!id) return c.text("Error: Share ID is required", { status: 400 })
        if (!isValidShareID(id)) return c.text("Error: Invalid share ID", { status: 400 })
        const data = await input.store.getData(id)

        let info: unknown
        const messages: Record<string, Record<string, unknown> & { parts: unknown[] }> = {}
        data.forEach((d) => {
          const [root, type] = d.key.split("/")
          if (root !== "session") return
          if (type === "info") {
            info = d.content
            return
          }
          if (type === "message" && isRecord(d.content) && typeof d.content.id === "string") {
            messages[d.content.id] = {
              parts: [],
              ...d.content,
            }
          }
        })
        data.forEach((d) => {
          const [root, type] = d.key.split("/")
          if (root !== "session" || type !== "part" || !isRecord(d.content)) return
          if (typeof d.content.messageID !== "string") return
          messages[d.content.messageID]?.parts.push(d.content)
        })

        return c.json({ info, messages })
      })
      .post("/feishu", async (c) => {
        const body = (await c.req.json()) as {
          token?: string
          challenge?: string
          header?: { token?: string }
          event?: {
            message?: {
              message_id?: string
              root_id?: string
              parent_id?: string
              chat_id?: string
              content?: string
            }
          }
        }
        const verificationToken = env("FEISHU_VERIFICATION_TOKEN")
        if (!verificationToken) return c.json({ error: "Feishu webhook is not configured" }, { status: 503 })
        const suppliedToken = body.header?.token ?? body.token
        if (typeof suppliedToken !== "string" || !sameSecret(suppliedToken, verificationToken))
          return c.json({ error: "Invalid Feishu verification token" }, { status: 401 })
        const challenge = body.challenge
        if (challenge) return c.json({ challenge })

        const content = body.event?.message?.content
        const parsed = parseFeishuContent(content)
        const text = typeof parsed?.text === "string" ? parsed.text : typeof content === "string" ? content : ""

        let message = text.trim().replace(/^@_user_\d+\s*/, "")
        message = message.replace(/^aiden,?\s*/i, "<@759257817772851260> ")
        if (!message) return c.json({ ok: true })

        const threadId = body.event?.message?.root_id || body.event?.message?.message_id
        if (threadId) message = `${message} [${threadId}]`
        const discordChannel = env("DISCORD_SUPPORT_CHANNEL_ID")
        const discordToken = env("DISCORD_SUPPORT_BOT_TOKEN")
        if (!discordChannel || !discordToken)
          return c.json({ error: "Discord relay is not configured" }, { status: 503 })

        const response = await fetch(`https://discord.com/api/v10/channels/${discordChannel}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${discordToken}`,
          },
          body: JSON.stringify({ content: message }),
        })

        if (!response.ok) {
          console.error(await response.text())
          return c.json({ error: "Discord bot message failed" }, { status: 502 })
        }

        return c.json({ ok: true })
      })
      /**
       * Used by the GitHub action to get GitHub installation access token given the OIDC token
       */
      .post("/exchange_github_app_token", async (c) => {
        const EXPECTED_AUDIENCE = "deepagent-code-github-action"
        const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
        const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`

        // get Authorization header
        const token = c.req.header("Authorization")?.replace(/^Bearer /, "")
        if (!token) return c.json({ error: "Authorization header is required" }, { status: 401 })

        // verify token
        const JWKS = createRemoteJWKSet(new URL(JWKS_URL))
        let owner: string
        let repo: string
        try {
          const { payload } = await jwtVerify(token, JWKS, {
            issuer: GITHUB_ISSUER,
            audience: EXPECTED_AUDIENCE,
          })
          const sub = payload.sub // e.g. 'repo:my-org/my-repo:ref:refs/heads/main'
          const repository = typeof sub === "string" ? /^repo:([^/:]+)\/([^:]+):/.exec(sub) : undefined
          if (!repository || !isRepositoryComponent(repository[1]) || !isRepositoryComponent(repository[2]))
            throw new Error("OIDC subject does not identify a repository")
          owner = repository[1]
          repo = repository[2]
        } catch (err) {
          console.error("Token verification failed:", err)
          return c.json({ error: "Invalid or expired token" }, { status: 403 })
        }

        // Create app JWT token
        const github = githubCredentials(env)
        if (!github) return c.json({ error: "GitHub App is not configured" }, { status: 503 })
        const auth = createAppAuth(github)
        const appAuth = await auth({ type: "app" })

        // Lookup installation
        const octokit = new Octokit({ auth: appAuth.token })
        const { data: installation } = await octokit.apps.getRepoInstallation({
          owner,
          repo,
        })

        // Get installation token
        const installationAuth = await auth({
          type: "installation",
          installationId: installation.id,
        })

        return c.json({ token: installationAuth.token })
      })
      /**
       * Used by the GitHub action to get GitHub installation access token given user PAT token (used when testing `deepagent-code github run` locally)
       */
      .post("/exchange_github_app_token_with_pat", async (c) => {
        const body = await c.req.json<{ owner: string; repo: string }>()
        const owner = body.owner
        const repo = body.repo
        if (!isRepositoryComponent(owner) || !isRepositoryComponent(repo))
          return c.json({ error: "Invalid repository" }, { status: 400 })
        const github = githubCredentials(env)
        if (!github) return c.json({ error: "GitHub App is not configured" }, { status: 503 })

        try {
          // get Authorization header
          const authHeader = c.req.header("Authorization")
          const token = authHeader?.replace(/^Bearer /, "")
          if (!token) throw new Error("Authorization header is required")

          // Verify permissions
          const userClient = new Octokit({ auth: token })
          const { data: repoData } = await userClient.repos.get({ owner, repo })
          if (!repoData.permissions?.admin && !repoData.permissions?.push && !repoData.permissions?.maintain)
            throw new Error("User does not have write permissions")

          // Get installation token
          const auth = createAppAuth(github)
          const appAuth = await auth({ type: "app" })

          // Lookup installation
          const appClient = new Octokit({ auth: appAuth.token })
          const { data: installation } = await appClient.apps.getRepoInstallation({
            owner,
            repo,
          })

          // Get installation token
          const installationAuth = await auth({
            type: "installation",
            installationId: installation.id,
          })

          return c.json({ token: installationAuth.token })
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : "GitHub authorization failed" },
            { status: 401 },
          )
        }
      })
      /**
       * Used by the deepagent-code CLI to check if the GitHub app is installed
       */
      .get("/get_github_app_installation", async (c) => {
        const owner = c.req.query("owner")
        const repo = c.req.query("repo")
        if (!owner || !repo || !isRepositoryComponent(owner) || !isRepositoryComponent(repo))
          return c.json({ error: "Invalid repository" }, { status: 400 })
        const github = githubCredentials(env)
        if (!github) return c.json({ error: "GitHub App is not configured" }, { status: 503 })

        const auth = createAppAuth(github)
        const appAuth = await auth({ type: "app" })

        // Lookup installation
        const octokit = new Octokit({ auth: appAuth.token })
        try {
          await octokit.apps.getRepoInstallation({ owner, repo })
        } catch (err) {
          if (err instanceof Error && err.message.includes("Not Found")) return c.json({ installed: false })
          throw err
        }

        return c.json({ installed: true })
      })
      .all("*", (c) => c.text("Not Found"))
  )
}

export const app = createApp({ store, subscribers })

export default app

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameSecret(actual: string, expected: string) {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest())
}

function parseFeishuContent(content: unknown): { text?: string } | undefined {
  if (typeof content !== "string" || !content.trim().startsWith("{")) return
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) return
    return { text: typeof parsed.text === "string" ? parsed.text : undefined }
  } catch {
    return
  }
}

function isRepositoryComponent(value: string) {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== "." && value !== ".."
}

function githubCredentials(env: (key: string) => string) {
  const appId = env("GITHUB_APP_ID")
  const privateKey = env("GITHUB_APP_PRIVATE_KEY")
  if (!appId || !privateKey) return
  return { appId, privateKey }
}
