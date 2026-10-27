import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WindowsNativeCliCohort } from "./windows-native-cli-cohort"

export function windowsMcpFile(file: "auth-scope" | "oauth-auto-connect") {
  const repository = path.resolve(import.meta.dir, "../../../..")
  const shim = path.join(import.meta.dir, "compiled-test-registry.ts")
  const state: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}
  const expected = file === "auth-scope" ? 27 : 8
  beforeAll(async () => {
    const directory = path.join(repository, ".artifacts", "windows-native-mcp")
    await fs.mkdir(directory, { recursive: true })
    state.cohort = await WindowsNativeCliCohort.build({ directory: await fs.realpath(directory),
      businessEntry: path.join(import.meta.dir, "../mcp/fixture/windows-compiled-mcp-host.ts"),
      extraSources: [shim, path.join(import.meta.dir, "windows-mcp-file.ts"),
        path.join(import.meta.dir, "windows-mcp-storage.ts"), path.join(import.meta.dir, "mcp-oauth-http.ts"),
        path.join(import.meta.dir, "empty-settings.ts"), path.join(import.meta.dir, "../lib/llm-server.ts"),
        path.join(import.meta.dir, "../lib/seed-ripgrep.ts"), path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
        path.join(import.meta.dir, "../mcp/auth-scope.cases.ts"),
        path.join(import.meta.dir, "../mcp/oauth-auto-connect.cases.ts"),
        path.join(import.meta.dir, "../lib/effect.ts"), path.join(import.meta.dir, "fixture.ts")],
      plugins: [{
        name: "original-mcp-case-registration",
        setup(builder) {
          builder.onResolve({ filter: /^bun:test$/ }, (input) =>
            path.resolve(input.importer) === shim
              ? { path: "bun:test", external: true }
              : { path: shim })
        },
      }],
    })
  }, 240_000)
  afterAll(async () => { await state.cohort?.dispose() })
  test(`original ${file} bodies use actual compiled Windows Native custody`, async () => {
    const cohort = state.cohort!
    console.info("WINDOWS_MCP_COMPILED_EVIDENCE", cohort.root)
    const result = await cohort.run({ args: [file], env: { DAC_WINDOWS_MCP_ROOT: cohort.root,
      DEEPAGENT_CODE_DB: ":memory:",
      DEEPAGENT_CODE_MODELS_PATH: path.join(repository, "packages/deepagent-code/test/tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(cohort.root, "managed"),
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
    },
      milliseconds: expected * 30_000 + 30_000 })
    console.info("WINDOWS_MCP_COMPILED_RESULT", JSON.stringify(result))
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, timedOut: false })
    const coverage = await Bun.file(path.join(cohort.root, "original-mcp-cases.json")).json()
    expect(coverage).toMatchObject({ file, expected, registered: expected, executed: expected, pass: true,
      currentBeforeRetirement: true, retiredReadRejected: true })
    expect(coverage.rows).toHaveLength(expected)
    expect(coverage.rows.every((row: { ok: boolean; timedOut: boolean }) => row.ok && !row.timedOut)).toBe(true)
    expect(coverage.cleanup.every((row: { ok: boolean }) => row.ok)).toBe(true)
  }, expected * 30_000 + 60_000)
}
