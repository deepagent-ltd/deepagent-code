import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ReleasePackageManifests } from "./prepare-release-files"
import { resolvePublishVersion } from "./resolve-publish-version"

const repository = path.resolve(import.meta.dir, "..")
const workflow = Bun.YAML.parse(await Bun.file(path.join(repository, ".github/workflows/publish.yml")).text()) as {
  jobs: Record<
    string,
    { steps?: { id?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }[] }
  >
}

test("main push and empty main dispatch feed the committed version into the existing release script", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-publish-version-"))
  try {
    const resolver = workflow.jobs.version.steps!.find((step) => step.id === "version-input")!
    const version = workflow.jobs.version.steps!.find((step) => step.id === "version")!
    expect(resolver.run).toBe("bun script/resolve-publish-version.ts")
    expect(resolver.env).toEqual({
      DAC_PUBLISH_REF: "${{ github.ref }}",
      DAC_PUBLISH_VERSION: "${{ inputs.version }}",
      DAC_PUBLISH_BUMP: "${{ inputs.bump }}",
    })
    expect(workflow.jobs.version.steps!.indexOf(resolver)).toBeLessThan(workflow.jobs.version.steps!.indexOf(version))
    expect(version.run?.trim()).toBe("./script/version.ts")
    expect(version.env?.DEEPAGENT_CODE_VERSION).toBe("${{ steps.version-input.outputs.version }}")
    expect(version.env?.DEEPAGENT_CODE_CHANNEL).toBe("${{ steps.version-input.outputs.channel }}")
    expect(version.env?.DEEPAGENT_CODE_BUMP).toBe("${{ steps.version-input.outputs.bump }}")
    const committed = (await Bun.file(path.join(repository, "packages/deepagent-code/package.json")).json()).version
    for (const input of [{}, { DAC_PUBLISH_VERSION: "", DAC_PUBLISH_BUMP: "" }]) {
      const output = path.join(root, `output-${Object.keys(input).length}`)
      const child = Bun.spawn([process.execPath, "script/resolve-publish-version.ts"], {
        cwd: repository,
        env: { PATH: Bun.env.PATH, DAC_PUBLISH_REF: "refs/heads/main", GITHUB_OUTPUT: output, ...input },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      expect(await Bun.file(output).text()).toBe(`version=${committed}\nchannel=latest\nbump=\n`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("automatic candidate and tag creation uses the job token without changing later publisher identities", () => {
  expect(workflow.jobs.version.steps!.find((step) => step.id === "committer")?.with).toBeUndefined()
  expect(workflow.jobs.version.steps!.find((step) => step.id === "version")?.env?.GH_TOKEN).toBe(
    "${{ steps.committer.outputs.token }}",
  )
  const downstream = Object.entries(workflow.jobs)
    .filter((entry) => entry[0] !== "version")
    .flatMap((entry) => entry[1].steps?.filter((step) => step.id === "committer") ?? [])
  expect(downstream.length).toBeGreaterThan(0)
  for (const step of downstream)
    expect(step.with).toEqual({
      "deepagent-code-app-id": "${{ vars.DEEPAGENT_CODE_APP_ID }}",
      "deepagent-code-app-secret": "${{ secrets.DEEPAGENT_CODE_APP_SECRET }}",
    })
})

test("tag, explicit version and explicit bump keep precedence while beta and branch previews remain previews", async () => {
  for (const entry of [
    {
      input: { ref: "refs/tags/v3.1.0", version: "9.0.0", bump: "minor" },
      result: { version: "3.1.0", channel: "latest", bump: "" },
    },
    {
      input: { ref: "refs/heads/main", version: "v3.1.0", bump: "major" },
      result: { version: "3.1.0", channel: "latest", bump: "" },
    },
    { input: { ref: "refs/heads/main", bump: "PATCH" }, result: { version: "", channel: "latest", bump: "patch" } },
    { input: { ref: "refs/heads/beta" }, result: { version: "", channel: "beta", bump: "" } },
    {
      input: { ref: "refs/heads/beta", version: "0.0.0-beta-example" },
      result: { version: "0.0.0-beta-example", channel: "beta", bump: "" },
    },
    { input: { ref: "refs/heads/beta", bump: "minor" }, result: { version: "", channel: "beta", bump: "minor" } },
    { input: { ref: "refs/heads/dev" }, result: { version: "", channel: "dev", bump: "" } },
    { input: { ref: "refs/heads/dev", version: "3.1.0" }, result: { version: "3.1.0", channel: "latest", bump: "" } },
  ])
    expect(await resolvePublishVersion({ ...entry.input, repository: "/nonexistent-release-fixture" })).toEqual(
      entry.result,
    )
})

test("invalid release versions, refs and bump inputs fail before creating Actions output", async () => {
  for (const version of ["2.0", "02.0.4", "0.0.0", "2.0.4-rc.1", "2.0.4+build", "2.0.4\nchannel=beta"])
    await expect(resolvePublishVersion({ ref: "refs/heads/main", version })).rejects.toThrow(
      "invalid latest release version",
    )
  await expect(resolvePublishVersion({ ref: "refs/tags/v2.0.4-rc.1" })).rejects.toThrow(
    "invalid latest release version",
  )
  await expect(resolvePublishVersion({ ref: "refs/heads/main", bump: "unknown" })).rejects.toThrow(
    "invalid release bump",
  )
  await expect(resolvePublishVersion({ ref: "refs/heads/main\nOTHER=value" })).rejects.toThrow("branch or tag ref")
  await expect(resolvePublishVersion({ ref: "" })).rejects.toThrow("branch or tag ref")
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-publish-rejected-"))
  try {
    const output = path.join(root, "output")
    const child = Bun.spawn([process.execPath, "script/resolve-publish-version.ts"], {
      cwd: repository,
      env: {
        PATH: Bun.env.PATH,
        DAC_PUBLISH_REF: "refs/heads/main",
        DAC_PUBLISH_VERSION: "invalid",
        GITHUB_OUTPUT: output,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).not.toBe(0)
    expect(await Bun.file(output).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("main rejects release-package drift, wrong identity and preview manifests without changing source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-publish-manifests-"))
  try {
    await Promise.all(
      ReleasePackageManifests.map((entry) =>
        Bun.write(
          path.join(root, entry[0]),
          JSON.stringify({
            name: entry[1],
            version: "2.0.4",
            dependencies: { fixture: "1.0.0" },
          }),
        ),
      ),
    )
    expect(await resolvePublishVersion({ ref: "refs/heads/main", repository: root })).toEqual({
      version: "2.0.4",
      channel: "latest",
      bump: "",
    })
    for (const entry of [
      { name: "@deepagent-code/desktop", version: "2.0.5", error: "Committed release package versions disagree" },
      { name: "unexpected-upstream", version: "2.0.4", error: "Unexpected release package identity" },
      { name: "@deepagent-code/desktop", version: "0.0.0-main-20261014", error: "invalid latest release version" },
    ]) {
      const file = path.join(root, "packages/desktop/package.json")
      await Bun.write(file, JSON.stringify({ name: entry.name, version: entry.version }))
      const before = await Promise.all(
        ReleasePackageManifests.map((manifest) => Bun.file(path.join(root, manifest[0])).text()),
      )
      await expect(resolvePublishVersion({ ref: "refs/heads/main", repository: root })).rejects.toThrow(entry.error)
      expect(
        await Promise.all(ReleasePackageManifests.map((manifest) => Bun.file(path.join(root, manifest[0])).text())),
      ).toEqual(before)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
