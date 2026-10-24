import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { releaseCheckWorkflows } from "../../../../script/verify-release-checks"

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
const bash = Bun.which("bash")
const action = Bun.YAML.parse(await Bun.file(path.join(root, ".github/actions/package-desktop/action.yml")).text()) as {
  runs: { using: string; steps: Step[] }
}
const workflows = await Promise.all(
  ["publish", "desktop-build"].map(async (name) => ({
    name,
    document: Bun.YAML.parse(await Bun.file(path.join(root, `.github/workflows/${name}.yml`)).text()) as {
      on: {
        push: { branches: string[] }
        workflow_dispatch: { inputs: Record<string, { type: string; required?: boolean }> }
      }
      concurrency: { group: string }
      jobs: Record<
        string,
        {
          env?: Record<string, string>
          if?: string
          uses?: string
          with?: Record<string, string>
          permissions?: Record<string, string>
          secrets?: unknown
          "continue-on-error"?: boolean
          steps: Step[]
          needs?: string | string[]
          strategy?: { matrix: { include: { host: string; arch: string; rust_target: string }[] } }
        }
      >
    },
  })),
)

test("main pushes run isolated QA while manual production builds retain their owner gate", () => {
  const workflow = workflows[1].document
  expect(workflow.on.push.branches).toEqual(["main"])
  expect(workflow.jobs["test-candidate"].if).toBe("github.event_name == 'push' || inputs.artifact_mode == 'test'")
  for (const name of ["setup", "cleanup", "build"])
    expect(workflow.jobs[name].if).toBe("github.event_name == 'workflow_dispatch' && inputs.artifact_mode != 'test'")
  expect(workflow.jobs.release.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'")
  expect(workflow.jobs.release.needs).toBe("build")
  expect(workflow.concurrency.group).toContain("${{ github.event_name }}")
  expect(workflow.concurrency.group).toContain("${{ inputs.artifact_mode || 'test' }}")

  const groups = new Set<string>()
  for (const fixture of [
    { event: "push", mode: "", expected: [true, false, false, false, false] },
    { event: "workflow_dispatch", mode: "test", expected: [true, false, false, false, false] },
    { event: "workflow_dispatch", mode: "release", expected: [false, true, true, true, false] },
  ]) {
    // This evaluates only the exact boolean expressions asserted above, with
    // default needs-success gating. It is not a GitHub Actions scheduler.
    const runs = ["test-candidate", "setup", "cleanup", "build", "release"].reduce<Record<string, boolean>>(
      (results, name) => {
        const job = workflow.jobs[name]
        const needs = typeof job.needs === "string" ? [job.needs] : (job.needs ?? [])
        const condition = job
          .if!.replaceAll("github.event_name", JSON.stringify(fixture.event))
          .replaceAll("github.ref", JSON.stringify("refs/heads/main"))
          .replaceAll("inputs.artifact_mode", JSON.stringify(fixture.mode))
        results[name] = needs.every((dependency) => results[dependency]) && Function(`return (${condition})`)() === true
        return results
      },
      {},
    )
    expect(Object.values(runs)).toEqual(fixture.expected)
    groups.add(
      workflow.concurrency.group
        .replaceAll("${{ github.ref }}", "refs/heads/main")
        .replaceAll("${{ github.event_name }}", fixture.event)
        .replaceAll("${{ inputs.artifact_mode || 'test' }}", fixture.mode || "test"),
    )
  }
  expect(groups.size).toBe(3)
  expect(workflow.jobs["test-candidate"]["continue-on-error"]).toBeUndefined()
})

test("the automatic QA call builds the exact source with all targets and read-only permissions", async () => {
  const called = workflows[1].document.jobs["test-candidate"]
  const qa = Bun.YAML.parse(await Bun.file(path.join(root, ".github/workflows/desktop-test-package.yml")).text()) as {
    on: { workflow_call: { inputs: { platforms: { default: string } } } }
    permissions: Record<string, string>
    jobs: {
      build: {
        env: Record<string, string>
        steps: Step[]
        strategy: { matrix: { include: { target: string }[] } }
        "continue-on-error"?: boolean
      }
    }
  }
  expect(called.uses).toBe("./.github/workflows/desktop-test-package.yml")
  expect(called.with).toEqual({ platforms: "${{ inputs.platforms || 'all' }}" })
  expect(called.permissions).toEqual({ contents: "read" })
  expect(called.secrets).toBeUndefined()
  expect(qa.on.workflow_call.inputs.platforms.default).toBe("all")
  expect(qa.permissions).toEqual({ contents: "read" })
  expect(qa.jobs.build["continue-on-error"]).toBeUndefined()
  expect(qa.jobs.build.env.DEEPAGENT_CODE_CHANNEL).toBe("dev")
  expect(qa.jobs.build.env.DEEPAGENT_CODE_ALLOW_UNSIGNED).toBe("1")
  expect(qa.jobs.build.strategy.matrix.include.map((target) => target.target)).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "win32-x64",
  ])
  const steps = qa.jobs.build.steps
  expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual({ ref: "${{ github.sha }}" })
  expect(steps.find((step) => step.name === "Pin the source version for unsigned test artifacts")?.run).toContain(
    "DEEPAGENT_CODE_VERSION=0.0.0-dev.",
  )
  expect(steps.find((step) => step.name === "Build current Desktop")?.run).toBe("bun run build")
  expect(steps.find((step) => step.name === "Build unsigned native test installer")?.run).toContain("--publish never")
  const guard = steps.find((step) => step.name === "Require complete packaged Desktop and CLI Native build proofs")!
  expect(guard.run).toContain("test-native-publisher.ts guard")
  expect(guard["continue-on-error"]).toBeUndefined()
  for (const name of ["Build current Desktop", "Build unsigned native test installer", guard.name])
    expect(steps.find((step) => step.name === name)?.if).toBe(
      "inputs.platforms == 'all' || inputs.platforms == matrix.group",
    )
  expect(steps.some((step) => step.run?.includes("mint-owner-campaign") || step.run?.includes("gh release"))).toBe(
    false,
  )
})

test("both Desktop workflows use one verified package action before every artifact upload", () => {
  for (const workflow of workflows) {
    const steps = workflow.document.jobs[workflow.name === "publish" ? "build-electron" : "build"].steps
    const packaged = steps.flatMap((step, index) => (step.uses === "./.github/actions/package-desktop" ? [index] : []))
    expect(packaged).toHaveLength(1)
    const step = steps[packaged[0]]
    expect(step.with?.version).toContain("outputs.version")
    expect(step.with?.channel).toContain("'prod'")
    expect(step.with?.["platform-flags"]).toContain("platform_flag")
    expect(step["continue-on-error"]).toBeUndefined()
    expect(
      steps.filter((entry) =>
        entry.run?.match(/native-publisher\.ts|bun run build|scripts\/prepare\.ts|electron-builder/),
      ),
    ).toHaveLength(0)
    const uploads = steps.flatMap((entry, index) => (entry.uses?.startsWith("actions/upload-artifact@") ? [index] : []))
    expect(uploads.length).toBeGreaterThan(0)
    expect(uploads.every((index) => index > packaged[0])).toBe(true)
    expect(step.with?.prepare).toBe(workflow.name === "publish" ? "true" : undefined)
  }
})

test("published Desktop targets reuse the CLI release owner row and public pin before building", () => {
  const release = workflows[0].document.jobs
  const desktop = release["build-electron"]
  expect(desktop.needs).toContain("build-cli")
  const packaged = desktop.steps.findIndex((step) => step.uses === "./.github/actions/package-desktop")
  const inputs = [
    [
      "owner-authorization",
      "owner-auth",
      "owner-authorization.json",
      "DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE",
    ],
    [
      "release-owner-public-key",
      "owner-key",
      "release-owner-public-key.pem",
      "DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY",
    ],
  ] as const
  for (const [name, directory, file, variable] of inputs) {
    const uploaded = release["build-cli"].steps.filter(
      (step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === name,
    )
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0].with?.path).toBe(`\${{ runner.temp }}/${file}`)
    const downloaded = desktop.steps.flatMap((step, index) =>
      step.uses?.startsWith("actions/download-artifact@") && step.with?.name === name ? [{ step, index }] : [],
    )
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0].index).toBeLessThan(packaged)
    expect(downloaded[0].step.if).toBeUndefined()
    expect(downloaded[0].step.with?.path).toBe(`\${{ runner.temp }}/${directory}`)
    expect(desktop.steps[packaged].env?.[variable]).toBe(`\${{ runner.temp }}/${directory}/${file}`)
  }
  expect(desktop.steps.some((step) => step.run?.includes("mint-owner-campaign"))).toBe(false)
  expect(action.runs.steps.some((step) => step.run?.includes("mint-owner-campaign"))).toBe(false)
  expect(
    action.runs.steps.some(
      (step) =>
        step.env?.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY !== undefined ||
        step.env?.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE !== undefined,
    ),
  ).toBe(false)
})

test("standalone Desktop release packaging requires one existing publish issuance before cleanup and build", async () => {
  const workflow = workflows[1].document
  expect(workflow.on.workflow_dispatch.inputs.owner_issuance_run_id).toMatchObject({ type: "string", required: false })
  expect(workflow.jobs.cleanup.needs).toBe("setup")
  const required = workflow.jobs.setup.steps.find(
    (step) => step.name === "Require the existing publish owner issuance",
  )!
  expect(required.env?.OWNER_ISSUANCE_RUN_ID).toBe("${{ inputs.owner_issuance_run_id }}")
  expect(required.run).toContain('(.path | split("@")[0]) == ".github/workflows/publish.yml"')
  expect(required.run).toContain('.status == "completed" and .conclusion == "success"')
  expect(bash).not.toBeNull()
  for (const value of ["", "0", "other-workflow", "1/../../", "1\nOTHER=1"]) {
    const child = Bun.spawn([bash!, "-c", required.run!], {
      env: { PATH: "/nonexistent", OWNER_ISSUANCE_RUN_ID: value, REPOSITORY: "fixture/repository", GH_TOKEN: "unused" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
    expect(await child.exited).toBe(1)
    expect(output).toContain("Release Desktop packaging requires owner_issuance_run_id")
  }
  const steps = workflow.jobs.build.steps
  const packaged = steps.findIndex((step) => step.uses === "./.github/actions/package-desktop")
  const verified = steps.findIndex(
    (step) => step.name === "Verify the existing owner issuance for this Desktop version",
  )
  for (const [name, directory, file, variable] of [
    [
      "owner-authorization",
      "owner-auth",
      "owner-authorization.json",
      "DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE",
    ],
    [
      "release-owner-public-key",
      "owner-key",
      "release-owner-public-key.pem",
      "DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY",
    ],
  ] as const) {
    const downloaded = steps.flatMap((step, index) =>
      step.uses?.startsWith("actions/download-artifact@") && step.with?.name === name ? [{ step, index }] : [],
    )
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0].step.with).toMatchObject({
      path: `\${{ runner.temp }}/${directory}`,
      repository: "${{ github.repository }}",
      "github-token": "${{ github.token }}",
      "run-id": "${{ needs.setup.outputs.owner_issuance_run_id }}",
    })
    expect(downloaded[0].index).toBeLessThan(verified)
    expect(steps[verified].env?.[variable]).toBe(`\${{ runner.temp }}/${directory}/${file}`)
    expect(steps[packaged].env?.[variable]).toBe(steps[verified].env?.[variable])
  }
  expect(verified).toBeLessThan(packaged)
  expect(steps.some((step) => step.run?.includes("mint-owner-campaign"))).toBe(false)
})

test("the actual standalone issuance verifier accepts the signed version and rejects other versions or changed signatures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dac-owner-workflow-"))
  try {
    const step = workflows[1].document.jobs.build.steps.find(
      (entry) => entry.name === "Verify the existing owner issuance for this Desktop version",
    )!
    const version = "2.0.5"
    const authorization = path.join(directory, "owner-authorization.json")
    const pin = path.join(directory, "owner-public.pem")
    const minted = Bun.spawn(
      [
        process.execPath,
        "script/mint-owner-campaign.ts",
        "--ephemeral",
        "--build-identity",
        version,
        "--db",
        path.join(directory, "mint.db"),
        "--export",
        authorization,
      ],
      {
        cwd: path.join(root, "packages/deepagent-code"),
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const issued = await Promise.all([
      new Response(minted.stdout).text(),
      new Response(minted.stderr).text(),
      minted.exited,
    ])
    expect(issued[2]).toBe(0)
    const output = JSON.parse(issued[0]) as { public_key_pem: string }
    const row = (await Bun.file(authorization).json()) as { signature_digest: string }
    await writeFile(pin, output.public_key_pem)
    expect(bash).not.toBeNull()
    for (const [expectedVersion, signature, accepted] of [
      [version, row.signature_digest, true],
      ["2.0.6", row.signature_digest, false],
      [version, `${row.signature_digest.startsWith("0") ? "1" : "0"}${row.signature_digest.slice(1)}`, false],
    ] as const) {
      await writeFile(authorization, JSON.stringify({ ...row, signature_digest: signature }))
      const child = Bun.spawn([bash!, "-c", step.run!], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          DAC_OWNER_VERSION: expectedVersion,
          DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE: authorization,
          DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY: pin,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
      expect(await child.exited).toBe(accepted ? 0 : 1)
      expect(output).toContain(
        accepted ? "verified_existing_owner_issuance" : "Existing owner issuance does not verify",
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the shared package action admits one publisher before either prebuild and guards before cleanup", () => {
  expect(action.runs.using).toBe("composite")
  expect(
    action.runs.steps.map((step) =>
      step.run?.includes("native-publisher.ts") ? step.run.trim().split(" ").at(-1) : step.name,
    ),
  ).toEqual([
    "Pin the Desktop build identity",
    "Verify Windows private storage preparation",
    "prepare",
    "Prepare the release package version",
    "Build renderer and Native assets",
    "Package",
    "guard",
    "cleanup",
  ])
  expect(action.runs.steps[1].if).toBe("runner.os == 'Windows'")
  expect(action.runs.steps[1].shell).toBe("pwsh")
  expect(action.runs.steps[1].run).toBe(
    "cargo test --locked --manifest-path packages/work-file-helper/Cargo.toml --lib windows_private_storage_bridge::storage::tests",
  )
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
        env: {
          ...Bun.env,
          GITHUB_ENV: file,
          RUNNER_OS: runner,
          DAC_DESKTOP_VERSION: "2.0.4",
          DAC_DESKTOP_CHANNEL: "beta",
          DAC_DESKTOP_MACOS_SIGNED: "false",
          DAC_DESKTOP_PREPARE: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      expect(await Bun.file(file).text()).toBe(
        "DEEPAGENT_CODE_VERSION=2.0.4\nDEEPAGENT_CODE_CHANNEL=beta\n" +
          (runner === "Linux" ? "DEEPAGENT_CODE_BUILD_LINUX_NATIVE_ASSETS=1\n" : ""),
      )
    }
    for (const invalid of [
      { DAC_DESKTOP_VERSION: "2.0.4\nOTHER=1" },
      { DAC_DESKTOP_CHANNEL: "dev" },
      { DAC_DESKTOP_MACOS_SIGNED: "true" },
      { DAC_DESKTOP_PREPARE: "typo" },
    ]) {
      const file = path.join(directory, "rejected.env")
      const child = Bun.spawn(["bash", "-c", action.runs.steps[0].run!], {
        env: {
          ...Bun.env,
          GITHUB_ENV: file,
          RUNNER_OS: "Linux",
          DAC_DESKTOP_VERSION: "2.0.4",
          DAC_DESKTOP_CHANNEL: "prod",
          DAC_DESKTOP_MACOS_SIGNED: "false",
          DAC_DESKTOP_PREPARE: "false",
          ...invalid,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(file).exists()).toBe(false)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Mac-only credentials cannot skip Linux sealing and configured Windows signing stays enabled", () => {
  const release = workflows[0].document.jobs["build-electron"].steps.find(
    (step) => step.uses === "./.github/actions/package-desktop",
  )!
  expect(release.with?.["macos-signed"]).toContain("runner.os == 'macOS' && needs.version.outputs.release != ''")
  for (const name of ["CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])
    expect(release.env?.[name]).toContain("runner.os == 'macOS' && needs.version.outputs.release != ''")
  expect(release.env?.CSC_NAME).toContain("secrets.APPLE_CSC_NAME")
  const desktop = workflows[1].document.jobs.build.steps.find(
    (step) => step.uses === "./.github/actions/package-desktop",
  )!
  expect(desktop.env?.DEEPAGENT_CODE_ALLOW_UNSIGNED).toContain(
    "matrix.group == 'win' && env.HAS_TRUSTED_SIGNING == 'true'",
  )
  expect(desktop.with?.["macos-signed"]).toContain("env.HAS_APPLE_CERT == 'true' && env.HAS_APPLE_NOTARY == 'true'")
  for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    expect(release.env?.[name]).toContain(`secrets.${name}`)
    expect(desktop.env?.[name]).toContain(`secrets.${name}`)
  }
  expect(release.env?.APPLE_API_KEY).toBeUndefined()
  expect(
    workflows[0].document.jobs["build-electron"].steps.some((step) => step.run?.includes("apple-api-key.p8")),
  ).toBe(false)
})

test("formal Mac signing rejects incomplete credentials before certificate import without exposing values", async () => {
  const steps = workflows[0].document.jobs["build-electron"].steps
  const guard = steps.find((step) => step.name === "Validate macOS release signing credentials")!
  const certificate = steps.find((step) => step.uses?.startsWith("apple-actions/import-codesign-certs@"))!
  expect(guard.if).toBe("runner.os == 'macOS' && needs.version.outputs.release != ''")
  expect(certificate.if).toBe(guard.if)
  expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(certificate))
  const names = [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_CSC_NAME",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]
  const credentials = Object.fromEntries(names.map((name) => [name, "test-only-value-do-not-log"]))
  for (const missing of [undefined, ...names]) {
    const child = Bun.spawn(["bash", "-c", guard.run!], {
      env: { ...Bun.env, ...credentials, ...(missing ? { [missing]: "" } : {}) },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
    expect(await child.exited).toBe(missing ? 1 : 0)
    expect(output).not.toContain("test-only-value-do-not-log")
    if (missing) expect(output).toContain(`Missing macOS release signing credential: ${missing}`)
  }
})

test("formal Windows publishing preserves the existing optional Desktop signing policy", () => {
  const release = workflows[0].document.jobs
  const desktop = workflows[1].document.jobs.build
  for (const name of ["build-cli-windows", "build-electron"]) {
    expect(release[name].env?.HAS_TRUSTED_SIGNING).toBe(desktop.env?.HAS_TRUSTED_SIGNING)
    expect(release[name].env?.AZURE_CLIENT_ID).toBe("${{ secrets.AZURE_TRUSTED_SIGNING_CLIENT_ID }}")
    expect(release[name].env?.AZURE_TENANT_ID).toBe("${{ secrets.AZURE_TRUSTED_SIGNING_TENANT_ID }}")
    expect(release[name].env?.AZURE_SUBSCRIPTION_ID).toBe("${{ secrets.AZURE_TRUSTED_SIGNING_SUBSCRIPTION_ID }}")
    expect(release[name].steps.find((step) => step.uses?.startsWith("azure/login@"))?.if).toContain(
      "env.HAS_TRUSTED_SIGNING == 'true'",
    )
  }
  const cli = release["sign-cli-windows"].steps
  expect(
    release["build-cli-windows"].steps.find((step) => step.uses?.startsWith("azure/artifact-signing-action@"))?.if,
  ).toBe("env.HAS_TRUSTED_SIGNING == 'true'")
  expect(cli.some((step) => step.uses?.startsWith("azure/artifact-signing-action@"))).toBe(false)
  expect(cli.find((step) => step.name === "Verify Windows CLI signatures")?.if).toBe(
    "env.HAS_TRUSTED_SIGNING == 'true'",
  )
  expect(cli.find((step) => step.name === "Repack Windows CLI archives")?.if).toBeUndefined()
  expect(
    cli.filter((step) => step.uses?.startsWith("actions/upload-artifact@")).map((step) => step.with?.name),
  ).toEqual(["deepagent-code-cli-signed-windows", "deepagent-code-cli-signed-windows-archives"])
  expect(cli.find((step) => step.name === "Report unsigned Windows artifacts")?.if).toBe(
    "env.HAS_TRUSTED_SIGNING != 'true'",
  )
  const electron = release["build-electron"].steps
  expect(electron.find((step) => step.name === "Verify signed Windows Electron artifacts")?.if).toBe(
    "runner.os == 'Windows' && env.HAS_TRUSTED_SIGNING == 'true'",
  )
  const packaging = electron.find((step) => step.uses === "./.github/actions/package-desktop")!
  expect(packaging.env?.DEEPAGENT_CODE_ALLOW_UNSIGNED).toBe(
    "${{ runner.os == 'Windows' && env.HAS_TRUSTED_SIGNING != 'true' && '1' || '0' }}",
  )
  expect(packaging.if).toBeUndefined()
  expect(packaging["continue-on-error"]).toBeUndefined()
  expect([...cli, ...electron].every((step) => !step["continue-on-error"])).toBe(true)
})

test("all nine release CLI targets retain native host prerequisites and sign before same-job sealing", () => {
  const release = workflows[0].document.jobs
  const linux = release["build-cli"].steps
  const tools = linux.find((step) => step.name === "Prepare Linux CLI Rust targets and musl linker")!
  const built = linux.find((step) => step.name === "Build (release identity pinned)")!
  expect(linux.indexOf(tools)).toBeLessThan(linux.indexOf(built))
  expect(tools.run).toContain("rustup target add x86_64-unknown-linux-gnu x86_64-unknown-linux-musl")
  expect(tools.run).toContain("musl-tools")
  expect(built.env?.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER).toBe("/usr/bin/musl-gcc")
  expect(built.run).toContain("script/build.ts --exclude-win32 --exclude-darwin")
  expect(built.run).toContain("./packages/cli/script/build.ts")
  const mac = release["build-cli-macos"]
  expect(mac.strategy?.matrix.include).toEqual([
    { host: "macos-15-intel", arch: "x64", rust_target: "x86_64-apple-darwin" },
    { host: "macos-26", arch: "arm64", rust_target: "aarch64-apple-darwin" },
  ])
  const macSeal = mac.steps.find((step) => step.run?.includes("native-publisher.ts seal-cli"))!
  expect(macSeal.run).toContain(
    "for file in packages/deepagent-code/dist/deepagent-code-darwin-*/bin/deepagent-code; do",
  )
  expect(macSeal.run).toContain('dir="${file%/bin/deepagent-code}"')
  expect(macSeal.run).not.toContain("for dir in packages/deepagent-code/dist/deepagent-code-darwin-*; do")
  for (const job of [mac, release["build-cli-windows"]]) {
    const stages = job.steps
    const prepared = stages.findIndex((step) => step.run?.endsWith("native-publisher.ts prepare"))
    const build = stages.findIndex((step) => step.run?.includes("script/build.ts --single --baseline"))
    const sealed = stages.findIndex((step) => step.run?.includes("native-publisher.ts seal-cli"))
    const cleanup = stages.findIndex((step) => step.run?.endsWith("native-publisher.ts cleanup"))
    expect(prepared).toBeGreaterThan(0)
    expect(build).toBeGreaterThan(prepared)
    expect(sealed).toBeGreaterThan(build)
    expect(cleanup).toBeGreaterThan(sealed)
    expect(stages[cleanup].if).toBe("always()")
    expect(stages[sealed].env?.DEEPAGENT_CODE_CANDIDATE_COMMIT).toContain("outputs.candidate_commit")
    expect(stages[sealed].env?.DEEPAGENT_CODE_CANDIDATE_TREE).toContain("outputs.candidate_tree")
    expect(stages[build].env?.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE).toContain(
      "owner-auth/owner-authorization.json",
    )
    expect(stages[build].env?.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY).toContain(
      "owner-key/release-owner-public-key.pem",
    )
    const uploads = stages.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
    expect(uploads.every((step) => !JSON.stringify(step).includes("publisher-private"))).toBe(true)
  }
  const win = release["build-cli-windows"].steps
  expect(win.findIndex((step) => step.uses?.startsWith("azure/artifact-signing-action@"))).toBeLessThan(
    win.findIndex((step) => step.run?.includes("native-publisher.ts seal-cli")),
  )
  expect(release.publish.needs).toContain("build-cli-macos")
  expect(
    release.publish.steps.find((step) => step.with?.pattern === "deepagent-code-cli-darwin-*")?.with?.[
      "merge-multiple"
    ],
  ).toBe(true)
})

test("main distribution binds existing checks before upload and never downgrades reviewed qualification", () => {
  expect(releaseCheckWorkflows).toEqual(["test.yml", "branding-check.yml", "generate.yml", "desktop-build.yml"])
  const steps = workflows[0].document.jobs.publish.steps
  const checks = steps.find((step) => step.name === "Verify existing checks for this exact main source")!
  const gate = steps.find((step) => step.name === "Verify distribution integrity and archive qualification status")!
  expect(checks.if).toBe(
    "needs.version.outputs.release && github.ref == 'refs/heads/main' && inputs.qualification_run_id == ''",
  )
  expect(checks.run).toBe("bun script/verify-release-checks.ts")
  expect(checks.env?.RELEASE_SOURCE_COMMIT).toBe("${{ github.sha }}")
  expect(checks.env?.RELEASE_CANDIDATE_COMMIT).toBe("${{ needs.version.outputs.candidate_commit }}")
  expect(checks.env?.RELEASE_CANDIDATE_TREE).toBe("${{ needs.version.outputs.candidate_tree }}")
  expect(gate.run).toContain('--standard-distribution --source-checks "$RUNNER_TEMP/ri51-source-checks.json"')
  expect(gate.run).toContain("elif [[ \"$RELEASE_REF\" == 'refs/heads/main' ]]")
  expect(gate.run!.indexOf('if [[ -n "$QUALIFICATION_RUN_ID" ]]')).toBeLessThan(
    gate.run!.indexOf("--standard-distribution"),
  )
  expect(gate.run).toContain("Non-main release requires an explicit reviewed qualification run")
  expect(gate.run).not.toContain("|| true")
  expect(gate["continue-on-error"]).toBeUndefined()
  const firstUpload = steps.findIndex((step) => step.name?.startsWith("Upload "))
  expect(steps.indexOf(checks)).toBeLessThan(steps.indexOf(gate))
  expect(steps.indexOf(gate)).toBeLessThan(firstUpload)
})
