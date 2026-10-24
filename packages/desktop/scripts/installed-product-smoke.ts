#!/usr/bin/env bun
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { _electron } from "@playwright/test"

if (process.platform !== "darwin") throw new Error("Installed product smoke currently supports packaged macOS .app only")
const expectedVersion: unknown =
  process.env.DEEPAGENT_CODE_SMOKE_EXPECTED_VERSION ??
  (await Bun.file(new URL("../package.json", import.meta.url)).json()).version
if (typeof expectedVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(expectedVersion))
  throw new Error(
    "Installed smoke requires a release version from DEEPAGENT_CODE_SMOKE_EXPECTED_VERSION or the Desktop manifest",
  )

const executable = process.env.DEEPAGENT_CODE_DESKTOP_EXECUTABLE
if (!executable || !path.isAbsolute(executable) || (await fs.realpath(executable)) !== executable)
  throw new Error("Installed smoke requires the canonical private candidate executable")
const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-installed-product-"))
await fs.chmod(root, 0o700)
const environment: Record<string, string> = Object.fromEntries(
  ["PATH", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]!]] : [],
  ),
)
Object.assign(environment, {
  HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  DEEPAGENT_CODE_TEST_ONBOARDING: "1",
  DEEPAGENT_CODE_TEST_ROOT: root,
  DEEPAGENT_CODE_DB: path.join(root, "database.sqlite"),
  DEEPAGENT_CODE_DISABLE_CHANNEL_DB: "1",
  DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
  DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
  DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1",
  DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1",
  DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
  DEEPAGENT_CODE_DISABLE_SHELL_ENV: "1",
  DEEPAGENT_ENABLED: "false",
})
await Promise.all(["home", "tmp", "data", "config", "cache", "state"].map((name) => fs.mkdir(path.join(root, name))))
console.log(`Installed product smoke started in ${root}`)

const started = performance.now()
const app = await _electron.launch({ executablePath: executable, args: [], env: environment, timeout: 45_000 })
try {
  const actual = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    executable: process.execPath,
    application: app.getAppPath(),
    userData: app.getPath("userData"),
  }))
  assert.equal(actual.version, expectedVersion)
  assert.equal(actual.packaged, true)
  assert.equal(actual.executable, executable)
  assert.ok(actual.application.endsWith("/Contents/Resources/app.asar"))
  assert.ok(actual.userData.startsWith(`${root}${path.sep}`))
  const page = await app.firstWindow({ timeout: 45_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { api?: unknown }).api), undefined, {
    timeout: 45_000,
  })
  const server = await Promise.race([
    page.evaluate(() =>
      (
        window as unknown as {
          api: { awaitInitialization(): Promise<{ url: string; username: string | null; password: string | null }> }
        }
      ).api.awaitInitialization(),
    ),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Installed sidecar readiness timeout")), 90_000)
      timer.unref()
    }),
  ])
  assert.equal(new URL(server.url).hostname, "127.0.0.1")
  assert.ok(server.username && server.password)
  const health = await fetch(new URL("/global/health", server.url), {
    headers: { authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(health.status, 200)
  const body = (await health.json()) as { healthy?: boolean; version?: string }
  assert.equal(body.healthy, true)
  assert.equal(body.version, expectedVersion)
  await page.waitForFunction(() => document.readyState === "complete" && document.body.innerText.trim().length > 0, undefined, {
    timeout: 30_000,
  })
  const renderer = await page.evaluate(() => ({
    title: document.title,
    uri: location.href,
    text: document.body.innerText.slice(0, 4096),
    elements: document.body.querySelectorAll("*").length,
  }))
  assert.equal(new URL(renderer.uri).protocol, "oc:")
  assert.equal(new URL(renderer.uri).host, "renderer")
  assert.ok(renderer.elements > 0)
  await page.screenshot({ path: path.join(root, "installed-renderer.png"), fullPage: true })
  const startupMs = Math.round(performance.now() - started)
  const db = new Database(environment.DEEPAGENT_CODE_DB!, { readonly: true })
  const tables = [
    "session_input",
    "session_v2_provider_turn_receipt",
    "session_v2_tool_effect_admission",
    "session_v2_tool_effect",
    "work_execution",
    "work_dispatch_reservation",
    "task_run",
    "task_admission",
  ]
  const inventory = Object.fromEntries(
    tables.map((table) => {
      const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
      assert.equal(row.count, 0, `Installed startup admitted or executed ${table}`)
      return [table, row.count]
    }),
  )
  db.close()
  await app.close()
  const cli = process.env.DEEPAGENT_CODE_CLI_EXECUTABLE
  const cliResult = cli
    ? await (async () => {
        assert.ok(path.isAbsolute(cli) && (await fs.realpath(cli)) === cli)
        const child = Bun.spawn([cli, "--version"], {
          env: { ...environment, DEEPAGENT_CODE_DB: path.join(environment.HOME!, ".deepagent/code/cli-smoke.sqlite") },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        })
        const result = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        assert.equal(result[0], 0)
        assert.equal(result[1].trim(), expectedVersion)
        const bytes = await fs.readFile(cli)
        return {
          version: result[1].trim(),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }
      })()
    : undefined
  await fs.writeFile(
    path.join(root, "safe-result.json"),
    JSON.stringify(
      {
        version: expectedVersion,
        expectedVersionSource:
          process.env.DEEPAGENT_CODE_SMOKE_EXPECTED_VERSION === undefined ? "desktop-manifest" : "explicit-smoke-expectation",
        actual,
        renderer,
        healthy: body.healthy,
        startupMs,
        inventory,
        cli: cliResult,
        limits: [
          "macOS packaged .app only; not Windows/Linux installation acceptance",
          "single startup sample; not SLO or soak acceptance",
          "no provider/Task/Work execution",
          "local candidate; Developer ID/notarization/release publication assessed separately",
        ],
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ state: "passed", root, version: actual.version, startupMs, inventory, cli: cliResult }))
} finally {
  await app.close().catch(() => undefined)
  console.log(`Installed smoke artifacts retained at ${root}`)
}
