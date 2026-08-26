import { strict as assert } from "node:assert"
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { execSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertModel,
  close,
  closeAll,
  createSession,
  launch,
  loadLiveConfig,
  messages,
  preflight,
  request,
  startPrompt,
  visibleText,
  writeArtifact,
  type Message,
  type Status,
} from "./runtime.ts"

// 1.4.8.rN r0 interactive REAL provider E2E against the packaged app (V2-only profile + campaign).
// The script mints an ephemeral Ed25519 issuance pair (node:crypto only — no package imports so
// node --experimental-strip-types resolves every module), signs the campaign payload with the SAME
// canonical payload the core verifier checks, and hands the app the verifier envs + the startup
// mint seam (DEEPAGENT_CODE_V2_DEV_CAMPAIGN). Requirements: DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE.
const suite = "r0-interactive"
// Load with the CORE-catalog provider id BEFORE loadLiveConfig snapshots the harness env —
// the config content, session model and the core config file must all agree on it.
process.env.DEEPAGENT_CODE_LIVE_LLM_PROVIDER = "deepseek"
const config = await loadLiveConfig()
assert.ok(
  process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE,
  "DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE must point at the DeepSeek key file",
)
const preflightResult = await preflight(config)
const startedAt = Date.now()

const repo = path.resolve(fileURLToPath(import.meta.url), "../../../..")
// The V2 runner resolves models through the CORE catalog (models.dev snapshot). The packaged
// sidecar disables models fetch (DEEPAGENT_CODE_DISABLE_MODELS_FETCH=1) and its cache root is
// fresh per launch, so hand the snapshot in: fetch models.dev's api.json once and point
// DEEPAGENT_CODE_MODELS_PATH at it (read before any fetch, exact same Provider shape).
const modelsPath = path.join(os.tmpdir(), "deepagent-code-live-models.json")
{
  const response = await fetch("https://gitee.com/deepagent-ai/models.dev/raw/main/api.json", {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`models.dev snapshot fetch failed: ${response.status}`)
  await (await import("node:fs/promises")).writeFile(modelsPath, await response.text())
}
const subjectCommit = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim()
const subjectTree = execSync("git rev-parse HEAD^{tree}", { cwd: repo }).toString().trim()
const campaignID = `r0-live-${randomUUID().slice(0, 8)}`
// Sorted-key object == CanonicalJson.stringify (sorted keys, no undefined).
const signable = {
  authorizationID: `auth_dev_${campaignID}`,
  campaignID,
  subjectCommit,
  subjectTree,
  schemaDigest: createHash("sha256").update(subjectCommit + subjectTree).digest("hex"),
  buildID: createHash("sha256").update("dev-local-packaged").digest("hex"),
  packageDigest: createHash("sha256").update(config.modelID).digest("hex"),
  validFrom: Date.now() - 1_000,
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
}
// Production signing seam: set DEEPAGENT_CODE_LIVE_LLM_OWNER_KEY_FILE to sign the campaign with
// an externally held production keypair (the verification public key is derived from it; the
// private key never leaves the machine). Without it, an ephemeral keypair is minted as before.
const ownerKeyFile = process.env.DEEPAGENT_CODE_LIVE_LLM_OWNER_KEY_FILE
let privateKey: Parameters<typeof sign>[2]
let privateKeyPem: string
let publicKeyPem: string
if (ownerKeyFile) {
  const pem = (await (await import("node:fs/promises")).readFile(ownerKeyFile, "utf8")).trim()
  privateKey = createPrivateKey(pem)
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString()
} else {
  const pair = generateKeyPairSync("ed25519")
  privateKey = pair.privateKey
  privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
}
// Sign the EXACT canonical bytes the core verifier checks: CanonicalJson.stringify
// (sorted keys, undefined filtered) — NOT raw JSON.stringify, whose key order is
// insertion order. Signing raw JSON made the live run refuse with
// v2_owner_unavailable (503) even though the row minted fine.
const canonicalize = (value: unknown): unknown => {
  if (value === null || value === undefined || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  )
}
const signatureDigest = sign(null, Buffer.from(JSON.stringify(canonicalize(signable))), privateKey).toString("hex")
assert.match(signatureDigest, /^[0-9a-f]{128}$/)

try {
  const runtime = await launch(suite, config, {
    environment: {
      DEEPAGENT_CODE_LIVE_LLM_DEBUG_LOG: "1",
      DEEPAGENT_CODE_CORE_V2_ONLY: "true",
      DEEPAGENT_CODE_LIVE_LLM_PROVIDER: "deepseek",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "0",
      DEEPAGENT_CODE_MODELS_URL: "https://gitee.com/deepagent-ai/models.dev/raw/main",
      DEEPAGENT_CODE_CORE_V2_EXECUTION_OWNER: "true",
      DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: campaignID,
      DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY: publicKeyPem,
      DEEPAGENT_CODE_V2_BUILD_IDENTITY: JSON.stringify({
        subjectCommit,
        subjectTree,
        schemaDigest: signable.schemaDigest,
        buildID: signable.buildID,
        packageDigest: signable.packageDigest,
      }),
      DEEPAGENT_CODE_V2_DEV_CAMPAIGN: JSON.stringify({
        campaignID,
        privateKeyPem,
        identity: {
          subjectCommit,
          subjectTree,
          schemaDigest: signable.schemaDigest,
          buildID: signable.buildID,
          packageDigest: signable.packageDigest,
        },
      }),
    },
  })
  try {
    runtime.page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        console.error(`[renderer ${message.type()}] ${message.text()}`)
      }
    })
    runtime.page.on("pageerror", (error) => console.error("[renderer pageerror]", error.message))
    runtime.page.on("requestfailed", (requestX) => {
      if (requestX.url().includes("/session/")) {
        console.error("[renderer requestfailed]", requestX.method(), requestX.url(), requestX.failure()?.errorText ?? "")
      }
    })
    runtime.page.on("response", (response) => {
      if (response.status() >= 400) {
        console.error("[renderer response]", response.status(), response.request().method(), response.url())
      }
    })
    const marker = randomUUID()
    const prompt = [
      "Reply with exactly one short sentence containing this marker and nothing else:",
      marker,
    ].join(" ")
    // The V2 runner resolves models through the CORE catalog. The core Config only reads config
    // files (Global.Path.config = $DEEPAGENT_CODE_TEST_HOME/.deepagent/code), so write a
    // core-format config.json carrying the live provider: its config-provider plugin then seeds
    // the catalog (provider + model request.apiKey + default model) inside the RUNNER's location
    // graph — exactly where model resolution happens.
    const coreConfigDir = path.join(runtime.root, "home", ".deepagent", "code")
    const fsPromises = await import("node:fs/promises")
    await fsPromises.mkdir(coreConfigDir, { recursive: true })
    await fsPromises.writeFile(
      path.join(coreConfigDir, "config.json"),
      JSON.stringify({
        model: `${config.providerID}/${config.modelID}`,
        providers: {
          [config.providerID]: {
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: config.baseURL },
            models: {
              [config.modelID]: {
                request: { body: { apiKey: config.apiKey } },
              },
            },
          },
        },
      }),
    )
    const session = await createSession(runtime, "DeepSeek V4 Flash r0 interactive", "r0-interactive")
    // Navigate the fresh app into the session view (same seeding the desktop-ui live script uses):
    // the page starts on home, so seed the last-project/session layout + the server endpoints first.
    const slug = Buffer.from(runtime.workspace).toString("base64url")
    const sessionKey = `local\u0000${slug}/${session.id}`
    await runtime.page.evaluate(
      async ({ layout, pageLayout, server }) => {
        const api = (window as unknown as { api: { storeSet(name: string, key: string, value: string): Promise<void> } }).api
        await api.storeSet("deepagent.global.dat", "layout", JSON.stringify(layout))
        await api.storeSet("deepagent.global.dat", "layout.page", JSON.stringify(pageLayout))
        await api.storeSet("deepagent.global.dat", "server", JSON.stringify(server))
      },
      {
        layout: { sessionView: { [sessionKey]: { scroll: {} } } },
        pageLayout: {
          lastProjectSession: { [runtime.workspace]: { directory: runtime.workspace, id: session.id, at: Date.now() } },
        },
        server: {
          list: [],
          projects: { local: [{ worktree: runtime.workspace, expanded: true }] },
          lastProject: { local: runtime.workspace },
        },
      },
    )
    await runtime.page.reload({ waitUntil: "domcontentloaded" })
    await runtime.page
      .getByRole("heading", { name: "DeepSeek V4 Flash r0 interactive" })
      .waitFor({ state: "visible", timeout: 60_000 })
    const editor = runtime.page.locator('[data-component="prompt-input"]')
    await editor.waitFor({ state: "visible", timeout: 60_000 })
    // The core catalog seeds asynchronously after the sidecar fetches the models.dev snapshot;
    // give the first populate a settled window before the turn resolves the model.
    await new Promise((resolve) => setTimeout(resolve, 12_000))
    await runtime.page.locator('[data-action="prompt-scenario-direct"]').click()
    await editor.fill(prompt)
    await runtime.page.locator('[data-action="prompt-submit"]').click()
    // If the UI admission does not land a durable user row within a short window, probe the
    // sidecar directly: a server-side 503 on prompt_async is then distinguishable from a
    // UI-side silent failure (same request, bypassing the renderer).
    let admitted = false
    const probeDeadline = Date.now() + 15_000
    while (Date.now() < probeDeadline) {
      if ((await messages(runtime, session.id)).some((message) => message.info.role === "user")) {
        admitted = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!admitted) {
      console.error("[diag] UI submit produced no user row after 15s; direct sidecar probe:")
      try {
        await startPrompt(runtime, session.id, prompt)
        console.error("[diag] direct promptAsync accepted")
      } catch (error) {
        console.error("[diag] direct promptAsync FAILED:", String(error))
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    const persisted = await waitForTurn(runtime, session.id, marker, startedAt)
    assert.ok(persisted, "waitForTurn returned without a persisted turn")
    assertModel(persisted, config.modelID, config.providerID)
    assert.match(visibleText(persisted), new RegExp(marker))
    assert.ok(
      persisted.some((message) => message.info.role === "user"),
      "mirrored user row missing",
    )
    await writeArtifact(suite, {
      sessionID: session.id,
      modelID: config.modelID,
      prompt,
      campaignID,
      subjectCommit,
      subjectTree,
      assistantParts: persisted
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .map((part) => ({ type: part.type })),
      preflight: preflightResult,
      elapsedMs: Date.now() - startedAt,
    })
  } finally {
    await close(runtime)
  }
} finally {
  await closeAll()
}

async function waitForTurn(
  runtime: ReturnType<typeof launch>,
  sessionID: string,
  marker: string,
  startedAt: number,
): Promise<Message[]> {
  const deadline = Date.now() + runtime.config.timeoutMs
  let lastLog = 0
  let lastFetchError = 0
  while (Date.now() < deadline) {
    const all = await messages(runtime, sessionID).catch((error) => {
      if (Date.now() - lastFetchError > 30_000) {
        lastFetchError = Date.now()
        console.error("[diag] message poll failed:", String(error))
      }
      return [] as Message[]
    })
    const assistants = all.filter((message) => message.info.role === "assistant")
    const latest = assistants.at(-1)
    const final = latest?.parts.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.includes(marker),
    )
    if (latest?.info.time.completed !== undefined && final) return all
    if (latest?.info.error) {
      console.error("[diag] assistant info.error", JSON.stringify(latest.info))
      throw new Error(`Assistant turn failed: ${JSON.stringify(latest.info)}`)
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now()
      const status = await request<Record<string, Status>>(runtime, "/session/status").catch(() => undefined)
      console.error(
        `[diag] t+${Math.round((Date.now() - startedAt) / 1000)}s status=${
          status?.[sessionID]?.type ?? "?"
        } messages=${all.length} assistants=${assistants.length}`,
      )
      if (latest) {
        console.error("[diag] last assistant:", JSON.stringify(latest.info))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const all = await messages(runtime, sessionID)
  const assistants = all.filter((message) => message.info.role === "assistant")
  const latest = assistants.at(-1)
  console.error("[diag] timeout final assistant:", JSON.stringify(latest?.info ?? null))
  console.error(
    "[diag] assistant parts:",
    JSON.stringify(
      assistants.flatMap((message) =>
        message.parts.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text.slice(0, 300), synthetic: part.synthetic, ignored: part.ignored }
            : { type: part.type },
        ),
      ),
    ),
  )
  return all
}