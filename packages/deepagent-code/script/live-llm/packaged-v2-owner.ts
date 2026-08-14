import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  loadLiveLLMConfig,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../llm/script/live-llm/config"
import { liveSubprocessEnvironment, liveWorkspaceConfig } from "./runtime"

const binary = process.env.DEEPAGENT_CODE_TEST_BINARY?.trim()
if (!binary || !(await Bun.file(binary).exists())) {
  throw new Error("DEEPAGENT_CODE_TEST_BINARY must reference the built DeepAgentCode binary")
}

const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const ownerMode = process.env.DEEPAGENT_CODE_PACKAGED_OWNER === "legacy" ? "legacy" : "v2"
const runtimeProviderID = "deepseek"
const root = await mkdtemp(path.join(os.tmpdir(), `deepagent-code-packaged-${ownerMode}-owner-`))
const workspace = path.join(root, "workspace")
const home = path.join(root, "home")
const data = path.join(root, "deepagent-home")
const databasePath = path.join(data, "packaged-v2-owner.sqlite")
const marker = `packaged-v2-${crypto.randomUUID()}`
const startedAt = Date.now()
let passed = false

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(data, { recursive: true }),
  ])
  await runGit(workspace, "init")
  await runGit(workspace, "config", "user.email", "packaged-v2@deepagent-code.test")
  await runGit(workspace, "config", "user.name", "Packaged V2")
  await Bun.write(path.join(workspace, "README.md"), "packaged V2 owner fixture\n")
  await runGit(workspace, "add", "README.md")
  await runGit(workspace, "commit", "-m", "test fixture")

  const workspaceConfig = liveWorkspaceConfig(config, { "*": "deny" }, { "*": "deny" }, undefined, {
    primaryPrompt: "Answer the user's exact marker request without tools.",
    modelMaxTokens: 128,
    maxProviderTurns: 1,
  })
  const environment = liveSubprocessEnvironment({
    HOME: home,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    DEEPAGENT_CODE_TEST_HOME: home,
    DEEPAGENT_CODE_HOME: data,
    DEEPAGENT_CODE_DB: databasePath,
    DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify({
      ...workspaceConfig,
      enabled_providers: [runtimeProviderID],
      model: `${runtimeProviderID}/${config.modelID}`,
    }),
    DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG: "1",
    DEEPAGENT_CODE_PURE: "1",
    DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
    DEEPAGENT_CODE_DISABLE_AUTOCOMPACT: "1",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
    DEEPAGENT_CODE_AUTH_CONTENT: JSON.stringify({
      [runtimeProviderID]: { type: "api", key: (await Bun.file(config.apiKeyFile).text()).trim() },
    }),
    DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
    ...(ownerMode === "legacy" ? { DEEPAGENT_CODE_CORE_V2_EXECUTION_OWNER: "false" } : {}),
    DEEPAGENT_CODE_CONTEXT_FEDERATION_ROLLOUT_STAGE: "all",
    DEEPAGENT_ENABLED: "false",
    DEEPAGENT_MODE: "general",
  })
  const child = Bun.spawn(
    [
      binary,
      ...(process.env.DEEPAGENT_CODE_KEEP_LIVE_TMP === "1" ? ["--print-logs", "--log-level", "DEBUG"] : []),
      "run",
      `Reply with exactly ${marker}`,
      "--model",
      `${runtimeProviderID}/${config.modelID}`,
      "--agent",
      "live-test",
      "--format",
      "json",
      "--dangerously-skip-permissions",
    ],
    { cwd: workspace, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const timeout = setTimeout(() => child.kill("SIGKILL"), config.timeoutMs * 2)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (exitCode !== 0)
    throw new Error(`Packaged V2 CLI exited ${exitCode}: stdout=${stdout.slice(-4_000)} stderr=${stderr.slice(-4_000)}`)
  if (!stdout.includes(marker)) throw new Error("Packaged V2 response did not contain the runtime marker")

  const database = new Database(databasePath, { readonly: true })
  const receipts = database
    .query(
      `SELECT receipt_id, owner_mode, state, prepared_turn_hash, wire_request_hash, outcome_hash, error_code
         FROM session_v2_provider_turn_receipt
        ORDER BY created_at, receipt_id`,
    )
    .all() as Array<{
    receipt_id: string
    owner_mode: string
    state: string
    prepared_turn_hash: string | null
    wire_request_hash: string | null
    outcome_hash: string | null
    error_code: string | null
  }>
  const legacyReceipts = database
    .query(
      `SELECT receipt_id, provider_state, prepared_turn_hash, wire_request_hash, response_fingerprint, request_error_code
         FROM session_tool_request_receipt
        ORDER BY created_at, receipt_id`,
    )
    .all() as Array<{
    receipt_id: string
    provider_state: string
    prepared_turn_hash: string | null
    wire_request_hash: string | null
    response_fingerprint: string | null
    request_error_code: string | null
  }>
  const legacyActive = database
    .query(
      `SELECT count(*) AS count FROM session_tool_request_receipt
        WHERE provider_state IN ('preparing','prepared','dispatching','streaming')`,
    )
    .get() as { count: number }
  database.close()
  if (ownerMode === "v2") {
    if (
      receipts.length !== 1 ||
      receipts[0]?.owner_mode !== "v2" ||
      receipts[0].state !== "settled" ||
      !receipts[0].prepared_turn_hash ||
      !receipts[0].wire_request_hash ||
      !receipts[0].outcome_hash ||
      receipts[0].error_code !== null
    ) {
      throw new Error(`Packaged C4 did not produce one sealed terminal V2 receipt: ${JSON.stringify(receipts)}`)
    }
    if (legacyReceipts.length !== 0) {
      throw new Error(`Packaged C4 unexpectedly used the legacy owner: ${JSON.stringify(legacyReceipts)}`)
    }
  }
  if (ownerMode === "legacy") {
    if (receipts.length !== 0) {
      throw new Error(`Packaged rollback unexpectedly used the V2 owner: ${JSON.stringify(receipts)}`)
    }
    if (
      legacyReceipts.length !== 1 ||
      legacyReceipts[0]?.provider_state !== "settled" ||
      !legacyReceipts[0].prepared_turn_hash ||
      !legacyReceipts[0].wire_request_hash ||
      !legacyReceipts[0].response_fingerprint ||
      legacyReceipts[0].request_error_code !== null
    ) {
      throw new Error(
        `Packaged rollback did not produce one sealed terminal legacy receipt: ${JSON.stringify(legacyReceipts)}`,
      )
    }
  }
  if (legacyActive.count !== 0) throw new Error("Packaged C4 left an active legacy provider owner")

  const binaryBytes = await Bun.file(binary).bytes()
  await writeLiveArtifact(
    config,
    `packaged-${ownerMode}-owner`,
    {
      suite: `packaged-${ownerMode}-owner`,
      mode: "live",
      stack: ownerMode === "v2" ? "packaged-cli-c4" : "packaged-cli-c4-rollback",
      status: "passed",
      fingerprint: { ...modelFingerprint(config), runtimeProviderID },
      preflight: { durationMs: preflight.durationMs },
      binary: {
        sha256: new Bun.CryptoHasher("sha256").update(binaryBytes).digest("hex"),
        bytes: binaryBytes.byteLength,
      },
      flags: {
        source: ownerMode === "v2" ? "packaged-default" : "packaged-kill-switch",
        contextFederationShadow: true,
        locationIndexesV2Shadow: true,
        contextProjectionV2: true,
        contextQueryToolsV2: true,
        coreV2ExecutionOwner: ownerMode === "v2",
      },
      receipts: receipts.map((receipt) => ({
        receiptID: receipt.receipt_id,
        ownerMode: receipt.owner_mode,
        state: receipt.state,
        preparedTurnHash: receipt.prepared_turn_hash,
        wireRequestHash: receipt.wire_request_hash,
        outcomeHash: receipt.outcome_hash,
      })),
      legacyActiveReceipts: legacyActive.count,
      legacyReceipts: legacyReceipts.map((receipt) => ({
        receiptID: receipt.receipt_id,
        state: receipt.provider_state,
        preparedTurnHash: receipt.prepared_turn_hash,
        wireRequestHash: receipt.wire_request_hash,
        responseFingerprint: receipt.response_fingerprint,
      })),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    },
    { redactions: [{ value: marker, replacement: "<packaged-v2-marker>" }] },
  )
  passed = true
  console.log(
    `packaged-${ownerMode}-owner: passed (${runtimeProviderID}/${config.modelID}, ${receipts.length + legacyReceipts.length} receipt)`,
  )
} finally {
  if (passed || process.env.DEEPAGENT_CODE_KEEP_LIVE_TMP !== "1") {
    await rm(root, { recursive: true, force: true })
  } else {
    console.error(`packaged-${ownerMode}-owner: preserved failed fixture at ${root}`)
  }
}

async function runGit(workspace: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const stderr = new Response(child.stderr).text()
  if ((await child.exited) !== 0) throw new Error(`git ${args[0]} failed: ${(await stderr).trim()}`)
}
