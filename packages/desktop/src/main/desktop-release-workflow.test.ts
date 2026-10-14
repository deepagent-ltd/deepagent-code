import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Step = {
  name?: string
  uses?: string
  run?: string
  shell?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
  "continue-on-error"?: boolean
}

const root = path.resolve(import.meta.dir, "../../../..")
const action = Bun.YAML.parse(await Bun.file(path.join(root, ".github/actions/package-desktop/action.yml")).text()) as {
  runs: { using: string; steps: Step[] }
}
const workflows = await Promise.all(["publish", "desktop-build"].map(async (name) => ({
  name,
  document: Bun.YAML.parse(await Bun.file(path.join(root, `.github/workflows/${name}.yml`)).text()) as {
    jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>
  },
})))

test("both Desktop workflows use one verified package action before every artifact upload", () => {
  for (const workflow of workflows) {
    const steps = workflow.document.jobs[workflow.name === "publish" ? "build-electron" : "build"].steps
    const packaged = steps.flatMap((step, index) => step.uses === "./.github/actions/package-desktop" ? [index] : [])
    expect(packaged).toHaveLength(1)
    const step = steps[packaged[0]]
    expect(step.with?.version).toContain("outputs.version")
    expect(step.with?.channel).toContain("'prod'")
    expect(step.with?.["platform-flags"]).toContain("platform_flag")
    expect(step["continue-on-error"]).toBeUndefined()
    expect(steps.filter((entry) => entry.run?.match(/native-publisher\.ts|bun run build|scripts\/prepare\.ts|electron-builder/)))
      .toHaveLength(0)
    const uploads = steps.flatMap((entry, index) => entry.uses?.startsWith("actions/upload-artifact@") ? [index] : [])
    expect(uploads.length).toBeGreaterThan(0)
    expect(uploads.every((index) => index > packaged[0])).toBe(true)
    expect(step.with?.prepare).toBe(workflow.name === "publish" ? "true" : undefined)
  }
})

test("the shared package action admits one publisher before either prebuild and guards before cleanup", () => {
  expect(action.runs.using).toBe("composite")
  expect(action.runs.steps.map((step) => step.run?.includes("native-publisher.ts")
    ? step.run.trim().split(" ").at(-1)
    : step.name)).toEqual([
    "Pin the Desktop build identity", "Verify Windows private storage preparation", "prepare", "Prepare the release package version",
    "Build renderer and Native assets", "Package", "guard", "cleanup",
  ])
  expect(action.runs.steps[1].if).toBe("runner.os == 'Windows'")
  expect(action.runs.steps[1].shell).toBe("pwsh")
  expect(action.runs.steps[1].run).toBe("cargo test --locked --manifest-path packages/work-file-helper/Cargo.toml --lib windows_private_storage_bridge::storage::tests")
  expect(action.runs.steps[3].if).toBe("inputs.prepare == 'true'")
  expect(action.runs.steps[6].if).toBeUndefined()
  expect(action.runs.steps[7].if).toBe("always()")
  expect(action.runs.steps.every((step) => !step["continue-on-error"])).toBe(true)
  expect(action.runs.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false)
  expect(action.runs.steps[5].run).toContain('"${dac_platform_flags[@]}" --publish never')
})

test("the actual identity step propagates version, channel and Linux assets without running builds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dac-desktop-workflow-"))
  try {
    for (const runner of ["Linux", "macOS", "Windows"]) {
      const file = path.join(directory, `${runner}.env`)
      const child = Bun.spawn(["bash", "-c", action.runs.steps[0].run!], {
        env: { ...Bun.env, GITHUB_ENV: file, RUNNER_OS: runner, DAC_DESKTOP_VERSION: "2.0.4",
          DAC_DESKTOP_CHANNEL: "beta", DAC_DESKTOP_MACOS_SIGNED: "false", DAC_DESKTOP_PREPARE: "true" },
        stdout: "pipe", stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      expect(await Bun.file(file).text()).toBe("DEEPAGENT_CODE_VERSION=2.0.4\nDEEPAGENT_CODE_CHANNEL=beta\n" +
        (runner === "Linux" ? "DEEPAGENT_CODE_BUILD_LINUX_NATIVE_ASSETS=1\n" : ""))
    }
    for (const invalid of [{ DAC_DESKTOP_VERSION: "2.0.4\nOTHER=1" }, { DAC_DESKTOP_CHANNEL: "dev" },
      { DAC_DESKTOP_MACOS_SIGNED: "true" }, { DAC_DESKTOP_PREPARE: "typo" }]) {
      const file = path.join(directory, "rejected.env")
      const child = Bun.spawn(["bash", "-c", action.runs.steps[0].run!], {
        env: { ...Bun.env, GITHUB_ENV: file, RUNNER_OS: "Linux", DAC_DESKTOP_VERSION: "2.0.4",
          DAC_DESKTOP_CHANNEL: "prod", DAC_DESKTOP_MACOS_SIGNED: "false", DAC_DESKTOP_PREPARE: "false", ...invalid },
        stdout: "pipe", stderr: "pipe",
      })
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(file).exists()).toBe(false)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("Mac-only credentials cannot skip Linux sealing and configured Windows signing stays enabled", () => {
  const release = workflows[0].document.jobs["build-electron"].steps.find((step) => step.uses === "./.github/actions/package-desktop")!
  expect(release.with?.["macos-signed"]).toContain("runner.os == 'macOS' && needs.version.outputs.release != ''")
  for (const name of ["CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])
    expect(release.env?.[name]).toContain("runner.os == 'macOS' && needs.version.outputs.release != ''")
  expect(release.env?.CSC_NAME).toContain("secrets.APPLE_CSC_NAME")
  const desktop = workflows[1].document.jobs.build.steps.find((step) => step.uses === "./.github/actions/package-desktop")!
  expect(desktop.env?.DEEPAGENT_CODE_ALLOW_UNSIGNED).toContain("matrix.group == 'win' && env.HAS_TRUSTED_SIGNING == 'true'")
  expect(desktop.with?.["macos-signed"]).toContain("env.HAS_APPLE_CERT == 'true' && env.HAS_APPLE_NOTARY == 'true'")
  for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    expect(release.env?.[name]).toContain(`secrets.${name}`)
    expect(desktop.env?.[name]).toContain(`secrets.${name}`)
  }
  expect(release.env?.APPLE_API_KEY).toBeUndefined()
  expect(workflows[0].document.jobs["build-electron"].steps.some((step) => step.run?.includes("apple-api-key.p8")))
    .toBe(false)
})

test("formal Mac signing rejects incomplete credentials before certificate import without exposing values", async () => {
  const steps = workflows[0].document.jobs["build-electron"].steps
  const guard = steps.find((step) => step.name === "Validate macOS release signing credentials")!
  const certificate = steps.find((step) => step.uses?.startsWith("apple-actions/import-codesign-certs@"))!
  expect(guard.if).toBe("runner.os == 'macOS' && needs.version.outputs.release != ''")
  expect(certificate.if).toBe(guard.if)
  expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(certificate))
  const names = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_CSC_NAME", "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
  const credentials = Object.fromEntries(names.map((name) => [name, "test-only-value-do-not-log"]))
  for (const missing of [undefined, ...names]) {
    const child = Bun.spawn(["bash", "-c", guard.run!], {
      env: { ...Bun.env, ...credentials, ...(missing ? { [missing]: "" } : {}) },
      stdout: "pipe", stderr: "pipe",
    })
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text()
    expect(await child.exited).toBe(missing ? 1 : 0)
    expect(output).not.toContain("test-only-value-do-not-log")
    if (missing) expect(output).toContain(`Missing macOS release signing credential: ${missing}`)
  }
})

test("formal Windows publishing preserves the existing optional Desktop signing policy", () => {
  const release = workflows[0].document.jobs
  const desktop = workflows[1].document.jobs.build
  for (const name of ["sign-cli-windows", "build-electron"]) {
    expect(release[name].env?.HAS_TRUSTED_SIGNING).toBe(desktop.env?.HAS_TRUSTED_SIGNING)
    expect(release[name].env?.AZURE_CLIENT_ID).toBe("${{ secrets.AZURE_TRUSTED_SIGNING_CLIENT_ID }}")
    expect(release[name].env?.AZURE_TENANT_ID).toBe("${{ secrets.AZURE_TRUSTED_SIGNING_TENANT_ID }}")
    expect(release[name].env?.AZURE_SUBSCRIPTION_ID).toBe("${{ secrets.AZURE_TRUSTED_SIGNING_SUBSCRIPTION_ID }}")
    expect(release[name].steps.find((step) => step.uses?.startsWith("azure/login@"))?.if)
      .toContain("env.HAS_TRUSTED_SIGNING == 'true'")
  }
  const cli = release["sign-cli-windows"].steps
  expect(cli.find((step) => step.uses?.startsWith("azure/artifact-signing-action@"))?.if)
    .toBe("env.HAS_TRUSTED_SIGNING == 'true'")
  expect(cli.find((step) => step.name === "Verify Windows CLI signatures")?.if)
    .toBe("env.HAS_TRUSTED_SIGNING == 'true'")
  expect(cli.find((step) => step.name === "Repack Windows CLI archives")?.if).toBeUndefined()
  expect(cli.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
    .map((step) => step.with?.name)).toEqual(["deepagent-code-cli-signed-windows", "deepagent-code-cli-signed-windows-archives"])
  expect(cli.find((step) => step.name === "Report unsigned Windows artifacts")?.if)
    .toBe("env.HAS_TRUSTED_SIGNING != 'true'")
  const electron = release["build-electron"].steps
  expect(electron.find((step) => step.name === "Verify signed Windows Electron artifacts")?.if)
    .toBe("runner.os == 'Windows' && env.HAS_TRUSTED_SIGNING == 'true'")
  const packaging = electron.find((step) => step.uses === "./.github/actions/package-desktop")!
  expect(packaging.env?.DEEPAGENT_CODE_ALLOW_UNSIGNED)
    .toBe("${{ runner.os == 'Windows' && env.HAS_TRUSTED_SIGNING != 'true' && '1' || '0' }}")
  expect(packaging.if).toBeUndefined()
  expect(packaging["continue-on-error"]).toBeUndefined()
  expect([...cli, ...electron].every((step) => !step["continue-on-error"])).toBe(true)
})

test("main distribution binds existing checks before upload and never downgrades reviewed qualification", () => {
  const steps = workflows[0].document.jobs.publish.steps
  const checks = steps.find((step) => step.name === "Verify existing checks for this exact main source")!
  const gate = steps.find((step) => step.name === "Verify distribution integrity and archive qualification status")!
  expect(checks.if).toBe("needs.version.outputs.release && github.ref == 'refs/heads/main' && inputs.qualification_run_id == ''")
  expect(checks.run).toBe("bun script/verify-release-checks.ts")
  expect(checks.env?.RELEASE_SOURCE_COMMIT).toBe("${{ github.sha }}")
  expect(checks.env?.RELEASE_CANDIDATE_COMMIT).toBe("${{ needs.version.outputs.candidate_commit }}")
  expect(checks.env?.RELEASE_CANDIDATE_TREE).toBe("${{ needs.version.outputs.candidate_tree }}")
  expect(gate.run).toContain('--standard-distribution --source-checks "$RUNNER_TEMP/ri51-source-checks.json"')
  expect(gate.run).toContain('elif [[ "$RELEASE_REF" == \'refs/heads/main\' ]]')
  expect(gate.run!.indexOf('if [[ -n "$QUALIFICATION_RUN_ID" ]]')).toBeLessThan(gate.run!.indexOf("--standard-distribution"))
  expect(gate.run).toContain("Non-main release requires an explicit reviewed qualification run")
  expect(gate.run).not.toContain("|| true")
  expect(gate["continue-on-error"]).toBeUndefined()
  const firstUpload = steps.findIndex((step) => step.name?.startsWith("Upload "))
  expect(steps.indexOf(checks)).toBeLessThan(steps.indexOf(gate))
  expect(steps.indexOf(gate)).toBeLessThan(firstUpload)
})
