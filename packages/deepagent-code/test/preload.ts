// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// Set XDG env vars FIRST, before any src/ imports
const dir = path.join(os.tmpdir(), "deepagent-code-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })

// Best-effort sweep of orphaned test tmpdirs from interrupted prior runs. The fixture
// disposes its `deepagent-code-test-<rand>` instance dirs on scope close, but a hard
// interrupt (Ctrl-C, CI/agent timeout) leaves them — each holds a git repo, and hundreds
// of them measurably slow filesystem/search-heavy tests (grep/glob). Only remove entries
// older than a grace window so we never touch a sibling run that is currently executing.
{
  const STALE_MS = 60 * 60 * 1000 // 1h: comfortably older than any live run
  const tmp = os.tmpdir()
  const now = Date.now()
  const entries = await fs.readdir(tmp, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && /^deepagent-code-test-/.test(e.name) && e.name !== path.basename(dir))
      .map(async (e) => {
        const p = path.join(tmp, e.name)
        const stat = await fs.stat(p).catch(() => null)
        if (!stat || now - stat.mtimeMs < STALE_MS) return
        await fs.rm(p, { recursive: true, force: true }).catch(() => undefined)
      }),
  )
}

afterAll(async () => {
  const { AppRuntime } = await import("../src/effect/app-runtime")
  await AppRuntime.dispose()

  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1 && process.platform !== "win32") throw error
      if (left <= 1) return
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["DEEPAGENT_CODE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
process.env["DEEPAGENT_CODE_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES"] = "true"

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["DEEPAGENT_CODE_TEST_HOME"] = testHome

// Pre-seed the ripgrep binary into the isolated test bin dir so NO test pays a first-use download.
// ripgrep resolution (core/src/filesystem/ripgrep.ts) is: PATH → Global.Path.bin/rg → DOWNLOAD from
// GitHub. Tests run with an isolated DEEPAGENT_CODE_TEST_HOME, so Global.Path.bin
// (<home>/.deepagent/code/cache/bin) is empty and the FIRST search test in the process (grep/glob/
// skill/file/sdk) triggers a network download; under full-suite load that download is slow/flaky and
// blows the per-test timeout → the first search test times out nondeterministically. Copy an already-
// present rg from a known cache into the test bin dir up front (offline, once). Best-effort: if no
// cached rg exists on this machine, do nothing and the original download path still applies, so this
// never breaks a fresh environment — it only removes the flake where a binary is already available.
{
  const rgName = process.platform === "win32" ? "rg.exe" : "rg"
  const testBinDir = path.join(testHome, ".deepagent", "code", "cache", "bin")
  const testBinRg = path.join(testBinDir, rgName)
  const alreadySeeded = await fs
    .stat(testBinRg)
    .then(() => true)
    .catch(() => false)
  if (!alreadySeeded) {
    const candidates = [
      process.env["DEEPAGENT_CODE_RG_PATH"] ?? "",
      path.join(os.homedir(), ".cache", "deepcode", "bin", rgName),
      path.join(os.homedir(), ".deepagent", "code", "cache", "bin", rgName),
    ].filter(Boolean)
    for (const src of candidates) {
      const ok = await fs
        .stat(src)
        .then((s) => s.isFile())
        .catch(() => false)
      if (!ok) continue
      await fs.mkdir(testBinDir, { recursive: true }).catch(() => undefined)
      await fs.copyFile(src, testBinRg).catch(() => undefined)
      await fs.chmod(testBinRg, 0o755).catch(() => undefined)
      break
    }
  }
}

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "deepagent-code")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["DEEPAGENT_CODE_SERVER_PASSWORD"]
delete process.env["DEEPAGENT_CODE_SERVER_USERNAME"]
delete process.env["DEEPAGENT_CODE_EXPERIMENTAL"]
delete process.env["DEEPAGENT_CODE_ENABLE_EXPERIMENTAL_MODELS"]
delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
delete process.env["OTEL_EXPORTER_OTLP_HEADERS"]
delete process.env["OTEL_RESOURCE_ATTRIBUTES"]

// Use in-memory sqlite
process.env["DEEPAGENT_CODE_DB"] = ":memory:"

// Now safe to import from src/
const { Log } = await import("@deepagent-code/core/util/log")
const { initProjectors } = await import("../src/server/projectors")

void Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

initProjectors()
