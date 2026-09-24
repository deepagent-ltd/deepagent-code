import { expect, test } from "bun:test"
import path from "node:path"

test("RI-51 gate precedes every release asset upload", async () => {
  const repository = path.resolve(import.meta.dir, "../../../..")
  const workflow = await Bun.file(path.join(repository, ".github/workflows/publish.yml")).text()
  const gate = workflow.indexOf("      - name: RI-51 authoritative ledger release gate")
  expect(gate).toBeGreaterThan(0)
  expect(workflow.slice(0, gate)).not.toContain("gh release upload")
  expect(workflow.slice(gate)).toContain("      - name: Upload CLI release assets")
  expect(workflow.slice(gate)).toContain("gh release upload")
  expect(workflow.slice(gate)).toContain("release-evidence-products.tar.gz")
  expect(workflow.slice(gate)).toContain("verify-ledger-products.ts")

  const build = workflow.slice(workflow.indexOf("  build-cli:"), workflow.indexOf("  sign-cli-windows:"))
  expect(build).toContain('DEEPAGENT_CODE_SKIP_RELEASE_UPLOAD: "1"')
  expect(build).toContain(
    "DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE: ${{ runner.temp }}/owner-authorization.json",
  )
  expect(build).toContain("name: deepagent-code-cli")
  expect(build).toContain("packages/deepagent-code/dist/deepagent-code-darwin*.zip")
  expect(build).toContain("packages/deepagent-code/dist/deepagent-code-linux*.tar.gz")
  const signing = workflow.slice(workflow.indexOf("  sign-cli-windows:"), workflow.indexOf("  build-electron:"))
  expect(signing).toContain("name: deepagent-code-cli-signed-windows-archives")
  expect(signing).toContain("packages/deepagent-code/dist/deepagent-code-windows*.zip")
  expect(workflow.slice(gate)).toContain('select(.kind == "cli")')
  expect(workflow.slice(gate)).toContain('select(.kind == "desktop")')

  const script = await Bun.file(path.join(repository, "packages/deepagent-code/script/build.ts")).text()
  expect(script).toContain('if (process.env.DEEPAGENT_CODE_SKIP_RELEASE_UPLOAD !== "1")')
  expect(script.indexOf("const ownerAuthorizationFile")).toBeLessThan(script.indexOf("if (Script.release)"))
})

test("release gate receives real packaged and reviewed evidence before byte-bound uploads", async () => {
  const repository = path.resolve(import.meta.dir, "../../../..")
  const workflow = await Bun.file(path.join(repository, ".github/workflows/publish.yml")).text()
  const probe = workflow.indexOf("      - name: Probe frozen packaged runtime")
  const qualification = workflow.indexOf("      - name: Download reviewed G0-G8 qualification")
  const stage = workflow.indexOf("      - name: Stage and verify final release archives")
  const gate = workflow.indexOf("      - name: RI-51 authoritative ledger release gate")
  const upload = workflow.indexOf("      - name: Upload CLI release assets")
  const readback = workflow.indexOf("      - name: Read back final release asset bytes")
  const publish = workflow.indexOf("      - run: ./script/publish.ts")
  expect(probe).toBeGreaterThan(0)
  expect(probe).toBeLessThan(qualification)
  expect(qualification).toBeLessThan(stage)
  expect(stage).toBeLessThan(gate)
  expect(gate).toBeLessThan(upload)
  expect(upload).toBeLessThan(readback)
  expect(readback).toBeLessThan(publish)
  expect(workflow.slice(probe, gate)).toContain("probe-packaged-runs.ts")
  expect(workflow.slice(probe, gate)).toContain("DEEPAGENT_CODE_OWNER_AUTHORIZATION=")
  expect(workflow.slice(gate, upload)).toContain("--package-dir")
  expect(workflow.slice(gate, upload)).toContain("--runs")
  expect(workflow.slice(gate, upload)).toContain("--evidence")
  expect(workflow.slice(gate, upload)).toContain("--asset-manifest")
  expect(workflow.slice(gate, upload)).toContain("--qualification-dir")
  expect(workflow).toContain("qualification_run_id:")
  expect(workflow).toContain("  actions: read")
  expect(workflow.slice(qualification, stage)).toContain("GH_TOKEN: ${{ github.token }}")
  expect(workflow).toContain('gh api "repos/$GH_REPO/actions/runs/$QUALIFICATION_RUN_ID"')
  expect(workflow.slice(upload, readback)).toContain("$RUNNER_TEMP/release-assets/$name")
  expect(workflow.slice(readback, publish)).toContain("gh release download")
  expect(workflow.slice(readback, publish)).toContain("release-assets.ts --verify")
  expect(workflow.slice(readback, publish)).toContain("--allow-ledger-assets")
  expect(workflow.slice(readback, publish)).toContain('cmp -s "$RUNNER_TEMP/release-readback/ledger.json"')
})

test("release workflow builds and publishes one frozen candidate", async () => {
  const repository = path.resolve(import.meta.dir, "../../../..")
  const workflow = await Bun.file(path.join(repository, ".github/workflows/publish.yml")).text()
  const version = await Bun.file(path.join(repository, "script/version.ts")).text()
  const publish = await Bun.file(path.join(repository, "script/publish.ts")).text()
  const jobs = ["build-cli", "sign-cli-windows", "build-electron", "publish"]
  expect(workflow).toContain("candidate_commit: ${{ steps.version.outputs.candidate_commit }}")
  expect(workflow).toContain("candidate_tree: ${{ steps.version.outputs.candidate_tree }}")
  expect(workflow).toContain("channel: ${{ steps.version.outputs.channel }}")
  for (const job of jobs) {
    const body = workflow.split(`  ${job}:\n`)[1]?.split(/^  [a-z][\w-]*:\n/m)[0]
    expect(body).toBeDefined()
    expect(body).toContain("ref: ${{ needs.version.outputs.candidate_commit }}")
  }
  expect(version.indexOf("await prepareReleaseFiles(")).toBeLessThan(version.indexOf("gh release create"))
  expect(version.indexOf("ensureReleaseCandidateRef(")).toBeLessThan(version.indexOf("gh release create"))
  expect(version.indexOf('Script.channel !== "beta"')).toBeLessThan(version.indexOf("gh release create"))
  expect(workflow).toContain("DEEPAGENT_CODE_CHANNEL: ${{ (github.ref_name == 'beta' && 'beta')")
  expect(version).not.toContain('else if (Script.channel === "beta")')
  expect(version).toContain('if (!release.isDraft) throw new Error("release candidate is already published")')
  expect(version).toContain("await assertReleaseCandidate({")
  expect(workflow).toContain("DEEPAGENT_CODE_CHANNEL: ${{ needs.version.outputs.channel }}")
  expect(workflow).toContain("DEEPAGENT_CODE_CANDIDATE_COMMIT: ${{ needs.version.outputs.candidate_commit }}")
  expect(publish).toContain("await assertReleaseCandidate({")
  expect(workflow.indexOf("Build SDK from frozen release candidate")).toBeLessThan(
    workflow.indexOf("RI-51 authoritative ledger release gate"),
  )
  expect(workflow).toContain("./packages/sdk/js/script/build.ts")
  expect(workflow).toContain("bun packages/sdk/js/script/verify-build.ts")
  expect(publish.indexOf("await verifySdkBuild(")).toBeLessThan(
    publish.indexOf("./packages/deepagent-code/script/publish.ts"),
  )
  expect(publish).toContain("await verifySdkBuild(")
  expect(workflow).toContain("RELEASE_ASSETS_DIR: ${{ runner.temp }}/release-assets")
  expect(publish.indexOf("await verifyUpdaterInputs(")).toBeLessThan(
    publish.indexOf("./packages/desktop/scripts/finalize-latest-json.ts"),
  )
  expect(publish.indexOf("await verifyUpdaterReadback(")).toBeLessThan(
    publish.indexOf("./packages/deepagent-code/script/publish.ts"),
  )
  expect(publish.indexOf("await verifyUpdaterReadback(")).toBeLessThan(publish.indexOf("gh release edit"))
  expect(publish).not.toContain("git tag -d")
  expect(publish).not.toContain("git push origin refs/tags/")
  expect(publish).not.toContain("git commit -am")
})

test("beta preview keeps build artifacts without creating or publishing a release", async () => {
  const repository = path.resolve(import.meta.dir, "../../../..")
  const workflow = await Bun.file(path.join(repository, ".github/workflows/publish.yml")).text()
  const version = await Bun.file(path.join(repository, "script/version.ts")).text()
  const channel = await Bun.file(path.join(repository, "packages/script/src/index.ts")).text()
  const build = workflow.split("  build-cli:\n")[1]?.split("  sign-cli-windows:\n")[0]
  const publish = workflow.split("  publish:\n")[1]
  expect(build).toContain("ref: ${{ needs.version.outputs.candidate_commit }}")
  expect(channel).toContain('const IS_PREVIEW = CHANNEL !== "latest"')
  expect(version).toContain('Script.channel !== "beta"')
  expect(version).toContain("if (!Script.preview) {")
  expect(version.slice(version.indexOf("if (!Script.preview) {"))).toContain("gh release create")
  expect(version).toContain("output.push(`candidate_commit=${candidateSha}`)")
  expect(version).toContain("output.push(`candidate_tree=${(await $`git rev-parse HEAD^{tree}`.text()).trim()}`)")
  expect(version).toContain("output.push(`channel=${Script.channel}`)")
  expect(publish).toContain("needs.version.outputs.channel != 'beta'")
})
