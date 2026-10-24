import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { inspectTestInstallers } from "./assert-test-package"

test("Linux x64 accepts only the runner's Debian amd64 filename and retains physical file guards", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-test-installer-name-"))
  const filename = path.join(directory, "deepagent-code-desktop-linux-amd64.deb")
  // Naming and physical-byte inspection only; these fixture bytes do not
  // attest Debian installability or execute any packaged runtime.
  const bytes = Buffer.alloc(512, 0x61)
  try {
    await Bun.write(filename, bytes)
    expect(await inspectTestInstallers({ directory, target: "linux-x64" })).toEqual([
      { filename: path.basename(filename), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ])
    await fs.rename(filename, path.join(directory, "deepagent-code-desktop-linux-x64.deb"))
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("Test installer target mismatch")
    await Bun.write(filename, bytes)
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("Test installer target mismatch")
    await fs.rm(path.join(directory, "deepagent-code-desktop-linux-x64.deb"))
    await Bun.write(path.join(directory, "foreign.deb"), bytes)
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("Test installer target mismatch")
    await fs.rm(path.join(directory, "foreign.deb"))
    await expect(inspectTestInstallers({ directory, target: "linux-arm64" })).rejects.toThrow("Unsupported native test package target")
    await fs.link(filename, path.join(directory, "second-link"))
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("bounded physical file")
    await fs.rm(path.join(directory, "second-link"))
    await fs.rename(filename, path.join(directory, "source-bytes"))
    await fs.symlink(path.join(directory, "source-bytes"), filename)
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("bounded physical file")
    await fs.rm(filename)
    await Bun.write(filename, bytes.subarray(0, 511))
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("bounded physical file")
    await Bun.write(filename, bytes)
    expect((await inspectTestInstallers({ directory, target: "linux-x64" }))[0]?.bytes).toBe(bytes.length)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("unsigned QA artifacts use matching source versions and the actual run identity", async () => {
  const root = path.resolve(import.meta.dir, "../../..")
  const version = (await Bun.file(path.join(root, "packages/desktop/package.json")).json()).version
  const { V2ProviderTurn } = await import("@deepagent-code/core/session/runner/v2-provider-turn")
  const workflow = Bun.YAML.parse(await Bun.file(path.join(root, ".github/workflows/desktop-test-package.yml")).text()) as {
    jobs: { build: { env: Record<string, string>; steps: { name?: string; run?: string; if?: string; with?: { name?: string } }[] } }
  }
  const step = workflow.jobs.build.steps.find((item) => item.name === "Pin the source version for unsigned test artifacts")!
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-qa-source-version-"))
  try {
    await fs.mkdir(path.join(directory, "packages/desktop"), { recursive: true })
    await fs.mkdir(path.join(directory, "packages/deepagent-code"), { recursive: true })
    await fs.mkdir(path.join(directory, "dist"))
    await Bun.write(path.join(directory, "packages/desktop/package.json"), JSON.stringify({ version }))
    await Bun.write(path.join(directory, "packages/deepagent-code/package.json"), JSON.stringify({ version }))
    const file = path.join(directory, "candidate.env")
    await Bun.write(file, "EXISTING_STEP=preserved\n")
    const child = Bun.spawn(["bash", "-c", step.run!], {
      cwd: directory,
      env: { ...Bun.env, GITHUB_ENV: file, GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2" },
      stdout: "pipe", stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await Bun.file(file).text()).toBe(`EXISTING_STEP=preserved\nDAC_TEST_SOURCE_VERSION=${version}\nDEEPAGENT_CODE_VERSION=0.0.0-dev.${version}.123456.2\n`)
    const runtimeVersion = (await Bun.file(file).text()).split("\n").find((line) => line.startsWith("DEEPAGENT_CODE_VERSION="))!.slice("DEEPAGENT_CODE_VERSION=".length)
    expect(V2ProviderTurn.isDevBuildVersion(runtimeVersion)).toBe(true)
    expect(V2ProviderTurn.isDevBuildVersion(`${version}-dev.123456.2`)).toBe(false)
    expect(workflow.jobs.build.env.DEEPAGENT_CODE_VERSION).toBeUndefined()
    expect(workflow.jobs.build.steps.find((item) => item.run === "bun test ./scripts/assert-test-package-linux.test.ts")?.if)
      .toBe("(inputs.platforms == 'all' || inputs.platforms == matrix.group) && matrix.group == 'linux'")
    expect(workflow.jobs.build.steps.filter((item) => item.with?.name?.startsWith("dac-")).map((item) => item.with?.name))
      .toEqual([
        "dac-${{ env.DAC_TEST_SOURCE_VERSION }}-test-${{ matrix.target }}-${{ github.run_id }}",
        "dac-${{ env.DAC_TEST_SOURCE_VERSION || 'unresolved' }}-diagnostic-report-${{ matrix.target }}-${{ github.run_id }}",
      ])
    await fs.rm(file)
    await Bun.write(path.join(directory, "packages/deepagent-code/package.json"), JSON.stringify({ version: "0.0.0" }))
    const mismatched = Bun.spawn(["bash", "-c", step.run!], {
      cwd: directory,
      env: { ...Bun.env, GITHUB_ENV: file, GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2" },
      stdout: "pipe", stderr: "pipe",
    })
    expect(await mismatched.exited).not.toBe(0)
    expect(await Bun.file(file).exists()).toBe(false)
    await Bun.write(path.join(directory, "dist/deepagent-code-desktop-linux-amd64.deb"), Buffer.alloc(512, 0x61))
    const manifest = path.join(directory, "dist/test-package-checksums.json")
    for (const candidate of ["0.0.0-dev-204.123456.2", `${version}-dev.123456.2`, "0.0.0-dev.2.0.4.123456.2", runtimeVersion]) {
      const inspected = Bun.spawn([process.execPath, path.join(import.meta.dir, "assert-test-package.ts")], {
        cwd: directory,
        env: { ...Bun.env, DAC_TEST_PACKAGE_TARGET: "linux-x64", DEEPAGENT_CODE_VERSION: candidate },
        stdout: "pipe", stderr: "pipe",
      })
      expect(await inspected.exited).toBe(candidate === runtimeVersion ? 0 : 1)
      if (candidate !== runtimeVersion) {
        expect(await Bun.file(manifest).exists()).toBe(false)
        continue
      }
      const result = await Bun.file(manifest).json()
      expect(result.version).toBe(version)
      expect(result.runtimeVersion).toBe(runtimeVersion)
      expect(result.target).toBe("linux-x64")
      expect(result.files[0].bytes).toBe(512)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
