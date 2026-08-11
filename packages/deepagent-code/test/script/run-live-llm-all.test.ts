import { describe, expect, test } from "bun:test"
import { chmod, mkdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadLiveLLMConfig, loadPlanLiveLLMConfig, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { directoryExists, liveSubprocessEnvironment, liveWorkspaceConfig } from "../../script/live-llm/runtime"
import { tmpdir } from "../fixture/fixture"
import {
  defaultModelsSnapshotFile,
  loadRealLLMSuiteInventory,
  parseEvaluationSummary,
  runnerEnvironment,
  selectSuites,
  suites,
  validateRunnerConfig,
  validateSuiteManifest,
} from "../../../../script/run-live-llm-all"

const config = {
  baseURL: "https://api.deepseek.com",
  apiKeyFile: "/secure/live-llm.key",
  model: "deepseek-v4-flash",
  modelRevision: "",
  requestTimeoutMs: 180_000,
  suiteTimeoutMs: 1_200_000,
  evalRuns: 5,
  installDependencies: true,
}

describe("all real LLM test runner", () => {
  test("selects every real suite by default and builds Desktop only once", async () => {
    const selected = selectSuites({
      headless: false,
      skipEval: false,
      skipInstall: false,
      installDependencies: true,
    })

    expect(selected.filter((suite) => suite.realLLM)).toHaveLength((await loadRealLLMSuiteInventory()).length)
    expect(selected.filter((suite) => suite.id === "setup:desktop-build")).toHaveLength(1)
    expect(new Set(selected.map((suite) => suite.id)).size).toBe(selected.length)
    expect(
      selected
        .slice(
          0,
          selected.findIndex((suite) => suite.realLLM),
        )
        .every((suite) => suite.gate),
    ).toBe(true)
  })

  test("headless and skip flags remove only their requested groups", () => {
    const selected = selectSuites({
      headless: true,
      skipEval: true,
      skipInstall: true,
      installDependencies: true,
    })

    expect(selected.some((suite) => suite.desktop)).toBe(false)
    expect(selected.some((suite) => suite.eval)).toBe(false)
    expect(selected.some((suite) => suite.install)).toBe(false)
    expect(selected.some((suite) => suite.id === "live:subagent-foreground")).toBe(true)
    expect(selected.some((suite) => suite.id === "ext:multi-agent-parallel-worktrees")).toBe(true)
    expect(selected.some((suite) => suite.id === "ext:multi-agent-pr-collaboration")).toBe(true)
  })

  test("validates the official DeepSeek configuration without retaining an empty revision", () => {
    expect(validateRunnerConfig(config)).toEqual({
      ...config,
      modelRevision: undefined,
    })
  })

  test("rejects placeholders and non-official endpoints before spawning tests", () => {
    expect(() => validateRunnerConfig({ ...config, apiKeyFile: "" })).toThrow("apiKeyFile")
    const legacyKey = `legacy-${crypto.randomUUID()}`
    expect(() => validateRunnerConfig({ ...config, apiKey: legacyKey })).toThrow(
      /^Legacy live LLM JSON field apiKey is not accepted; move the key to a chmod 600 one-line file and set apiKeyFile \(recommended: ~\/\.deepagent\/code\/tmp\/live-llm-deepseek\.key\)$/,
    )
    expect(() => validateRunnerConfig({ ...config, baseURL: "https://example.com" })).toThrow(
      "official https://api.deepseek.com",
    )
  })

  test("passes only the explicit host environment allowlist to child suites", () => {
    const hostEnvironment = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      USER: "test-user",
      LOGNAME: "test-user",
      DISPLAY: ":99",
      MODELS_DEV_API_JSON: "/isolated/models.json",
      HOME: "/host/home",
      SSH_AUTH_SOCK: "/host/agent.sock",
      AWS_SECRET_ACCESS_KEY: "host-secret",
      HTTPS_PROXY: "http://host-proxy.invalid",
      DEEPAGENT_CODE_AUTH_CONTENT: "host-auth",
    }

    expect(runnerEnvironment(config, hostEnvironment)).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      USER: "test-user",
      LOGNAME: "test-user",
      DISPLAY: ":99",
      MODELS_DEV_API_JSON: "/isolated/models.json",
    })
    expect(runnerEnvironment(config, hostEnvironment, true)).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      USER: "test-user",
      LOGNAME: "test-user",
      DISPLAY: ":99",
      MODELS_DEV_API_JSON: "/isolated/models.json",
      DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
      DEEPAGENT_CODE_LIVE_LLM_BASE_URL: config.baseURL,
      DEEPAGENT_CODE_LIVE_LLM_MODEL: config.model,
      DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS: String(config.requestTimeoutMs),
      DEEPAGENT_CODE_LIVE_LLM_EVAL_RUNS: String(config.evalRuns),
    })
  })

  test("pins the repository models snapshot when the host does not provide one", () => {
    expect(runnerEnvironment(config, { PATH: "/usr/bin:/bin" })).toEqual({
      PATH: "/usr/bin:/bin",
      MODELS_DEV_API_JSON: defaultModelsSnapshotFile,
    })
  })

  test("passes only the explicit host environment allowlist to CLI live subprocesses", () => {
    expect(
      liveSubprocessEnvironment(
        { HOME: "/isolated/home", DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: "/secure/live-llm.key" },
        {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          HOME: "/host/home",
          SSH_AUTH_SOCK: "/host/agent.sock",
          AWS_SECRET_ACCESS_KEY: "host-secret",
          GOOGLE_APPLICATION_CREDENTIALS: "/host/google.json",
          HTTPS_PROXY: "http://host-proxy.invalid",
          DATABASE_URL: "postgres://host-secret",
          DEEPAGENT_CODE_AUTH_CONTENT: "host-auth",
        },
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/isolated/home",
      DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: "/secure/live-llm.key",
    })
  })

  test("recognizes child worktree directories without treating them as Bun files", async () => {
    await using directory = await tmpdir()
    const worktree = path.join(directory.path, "worktree")
    const file = path.join(directory.path, "file")
    await mkdir(worktree)
    await Bun.write(file, "not a directory")

    expect(await directoryExists(worktree)).toBe(true)
    expect(await directoryExists(file)).toBe(false)
    expect(await directoryExists(path.join(directory.path, "missing"))).toBe(false)
  })

  test("loads credentials only from a protected live-test key file", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "deepseek.key")
    await Bun.write(file, "file-only-key\n")
    await chmod(file, 0o600)

    const loaded = await loadLiveLLMConfig({
      DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: file,
      DEEPAGENT_CODE_LIVE_LLM_MODEL: "deepseek-v4-flash",
    })
    expect(loaded.apiKey).toBe("file-only-key")
    expect(loaded.apiKeyFile).toBe(await realpath(file))
    const kimi = await loadPlanLiveLLMConfig({
      DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: file,
      DEEPAGENT_CODE_PLAN_LIVE_LLM_PROVIDER: "kimi",
    })
    expect(kimi).toMatchObject({
      providerID: "kimi",
      modelID: "kimi-k3",
      baseURL: "https://api.moonshot.ai/v1",
    })
    await expect(loadLiveLLMConfig({ DEEPSEEK_API_KEY: "ambient-user-key" })).rejects.toThrow(
      "Raw API key environment variables are not accepted",
    )
    await expect(loadPlanLiveLLMConfig({ MOONSHOT_API_KEY: "ambient-user-key" })).rejects.toThrow(
      "Raw API key environment variables are not accepted",
    )
    await expect(
      loadPlanLiveLLMConfig({
        DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: file,
        DEEPAGENT_CODE_PLAN_LIVE_LLM_PROVIDER: "kimi",
        DEEPAGENT_CODE_LIVE_LLM_BASE_URL: "https://example.com",
      }),
    ).rejects.toThrow("Official Kimi live tests require https://api.moonshot.ai/v1")

    await chmod(file, 0o644)
    await expect(loadLiveLLMConfig({ DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: file })).rejects.toThrow("chmod 600")
    await chmod(file, 0o600)
    await Bun.write(file, "first-line\nsecond-line\n")
    await expect(loadLiveLLMConfig({ DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: file })).rejects.toThrow(
      "exactly one non-empty line",
    )
  })

  test("injects a file reference into production provider config without serializing the key", () => {
    const apiKey = `raw-${crypto.randomUUID()}`
    const workspaceConfig = liveWorkspaceConfig(
      {
        providerID: "deepseek",
        modelID: config.model,
        baseURL: config.baseURL,
        apiKey,
        apiKeyFile: config.apiKeyFile,
        timeoutMs: config.requestTimeoutMs,
        artifactDirectory: "/isolated/artifacts",
      },
      { "*": "deny" },
    )
    const serialized = JSON.stringify(workspaceConfig)
    expect(serialized).toContain(`{file:${config.apiKeyFile}}`)
    expect(serialized).not.toContain(apiKey)
    expect(workspaceConfig.provider?.["live-deepseek"]?.env).toEqual([])

    const kimi = liveWorkspaceConfig(
      {
        providerID: "kimi",
        modelID: "kimi-k3",
        baseURL: "https://api.moonshot.ai/v1",
        apiKey,
        apiKeyFile: config.apiKeyFile,
        timeoutMs: config.requestTimeoutMs,
        artifactDirectory: "/isolated/artifacts",
      },
      { "*": "deny" },
    )
    expect(JSON.stringify(kimi)).not.toContain(apiKey)
    expect(kimi.provider?.["live-kimi"]?.models?.["kimi-k3"]).toMatchObject({
      reasoning: true,
      temperature: false,
      options: { reasoningEffort: "low" },
    })
  })

  test("overwrites a stale provider success artifact when configuration fails", async () => {
    await using directory = await tmpdir()
    const artifact = path.join(directory.path, "provider-smoke.json")
    await Bun.write(artifact, `${JSON.stringify({ status: "passed", stale: true })}\n`)
    const subprocess = Bun.spawn(
      [process.execPath, "run", path.resolve(import.meta.dir, "../../../llm/script/live-llm/provider-smoke.ts")],
      {
        cwd: path.resolve(import.meta.dir, "../../../llm"),
        env: {
          PATH: process.env.PATH,
          DEEPAGENT_CODE_LIVE_LLM_ARTIFACT_DIR: directory.path,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    expect(await subprocess.exited).not.toBe(0)
    const failed: unknown = await Bun.file(artifact).json()
    expect(failed).toMatchObject({ status: "failed", phase: "configuration" })
    expect(JSON.stringify(failed)).not.toContain("stale")
  })

  test("redacts host paths and credentials from shared live artifacts", async () => {
    await using directory = await tmpdir()
    const apiKey = `secret-${crypto.randomUUID()}`
    const hostPath = path.join(os.tmpdir(), `host-${crypto.randomUUID()}`, "fixture.txt")
    await writeLiveArtifact({ artifactDirectory: directory.path, apiKey }, "redaction", {
      apiKey,
      hostPath,
      homePath: process.env.HOME ? path.join(process.env.HOME, "project") : undefined,
    })

    const artifact = await Bun.file(path.join(directory.path, "redaction.json")).text()
    expect(artifact).not.toContain(apiKey)
    expect(artifact).not.toContain(os.tmpdir())
    if (process.env.HOME) expect(artifact).not.toContain(process.env.HOME)
    expect(artifact).toContain("<redacted>")
    expect(artifact).toContain("<tmp>")
  })

  test("redacts suite-owned hidden markers and large synthetic prompt bodies", async () => {
    await using directory = await tmpdir()
    const marker = `hidden-${crypto.randomUUID()}`
    const padding = `padding-${crypto.randomUUID()}`.repeat(1_000)
    await writeLiveArtifact(
      { artifactDirectory: directory.path },
      "suite-redaction",
      { marker, padding },
      {
        redactions: [
          { value: marker, replacement: "<hidden-marker>" },
          { value: padding, replacement: `<padding hash=${Bun.hash(padding).toString(16)}>` },
        ],
      },
    )

    const artifact = await Bun.file(path.join(directory.path, "suite-redaction.json")).text()
    expect(artifact).not.toContain(marker)
    expect(artifact).not.toContain(padding)
    expect(artifact).toContain("<hidden-marker>")
    expect(artifact.length).toBeLessThan(1_000)
  })

  test("binds live artifacts to source, runtime, route, and oracle hashes", async () => {
    await using directory = await tmpdir()
    await writeLiveArtifact(
      { artifactDirectory: directory.path },
      "provenance",
      { status: "passed" },
      {
        harnessFiles: ["packages/deepagent-code/script/live-llm/routes.ts", "packages/llm/script/live-llm/config.ts"],
        oracleVersion: "provenance-test-v1",
      },
    )

    const artifact: unknown = await Bun.file(path.join(directory.path, "provenance.json")).json()
    expect(artifact).toMatchObject({
      status: "passed",
      provenance: {
        schema: "deepagent-live-evidence-v1",
        sourceCommit: expect.any(String),
        sourceTree: expect.any(String),
        sourceDirty: expect.any(Boolean),
        oracleVersion: "provenance-test-v1",
        oracleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        routeManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtime: { bun: expect.any(String), platform: process.platform, arch: process.arch },
        harnessFiles: expect.arrayContaining([
          {
            path: "packages/deepagent-code/script/live-llm/routes.ts",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ]),
      },
    })
  })

  test("suite manifest itself has no duplicate IDs", () => {
    expect(new Set(suites.map((suite) => suite.id)).size).toBe(suites.length)
  })

  test("registers every real LLM package script", async () => {
    await expect(validateSuiteManifest()).resolves.toBeUndefined()
  })

  test("reads normalized autonomous scores without turning partial credit into a gate", () => {
    expect(
      parseEvaluationSummary({
        report: {
          passed: 4,
          runs: 5,
          successRate: 0.8,
          score: { earnedPoints: 49, possiblePoints: 53, normalized: 49 / 53, outOf100: 92.45 },
        },
      }),
    ).toEqual({
      passed: 4,
      runs: 5,
      successRate: 0.8,
      score: { earnedPoints: 49, possiblePoints: 53, normalized: 49 / 53, outOf100: 92.45 },
    })
    const suite = suites.find((candidate) => candidate.id === "eval:autonomous")
    expect(suite?.eval).toBe(true)
    expect(suite?.gate).toBeUndefined()
  })
})
