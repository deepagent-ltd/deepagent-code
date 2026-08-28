/**
 * Local deployment only.
 *
 * The share/GitHub/Feishu backend, the docs site, and the web app all run
 * locally now — there are no Cloudflare (Worker, R2, Astro, StaticSite) or
 * other cloud resources to provision. Run them with their package scripts:
 *
 *   bun run --cwd packages/function start   # share backend (node, port 3099)
 *   bun run --cwd packages/web build && bun run --cwd packages/web preview
 *   bun run --cwd packages/app build        # static web app -> packages/app/dist
 *
 * Secrets for the backend are read from the environment (see
 * packages/function/src/api.ts): ADMIN_SECRET, GITHUB_APP_ID,
 * GITHUB_APP_PRIVATE_KEY, FEISHU_APP_ID, FEISHU_APP_SECRET,
 * DISCORD_SUPPORT_BOT_TOKEN, DISCORD_SUPPORT_CHANNEL_ID.
 */
export {}
