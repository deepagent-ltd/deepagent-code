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

  const build = workflow.slice(workflow.indexOf("  build-cli:"), workflow.indexOf("  sign-cli-windows:"))
  expect(build).toContain('DEEPAGENT_CODE_SKIP_RELEASE_UPLOAD: "1"')
  expect(build).toContain("DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE: ${{ runner.temp }}/owner-authorization.json")
  expect(build).toContain("name: deepagent-code-cli")
  expect(build).toContain("packages/deepagent-code/dist/deepagent-code-darwin*.zip")
  expect(build).toContain("packages/deepagent-code/dist/deepagent-code-linux*.tar.gz")
  const signing = workflow.slice(workflow.indexOf("  sign-cli-windows:"), workflow.indexOf("  build-electron:"))
  expect(signing).toContain("name: deepagent-code-cli-signed-windows-archives")
  expect(signing).toContain("packages/deepagent-code/dist/deepagent-code-windows*.zip")
  expect(workflow.slice(gate)).toContain("windows=(/tmp/signed-cli-windows/deepagent-code-windows*.zip)")

  const script = await Bun.file(path.join(repository, "packages/deepagent-code/script/build.ts")).text()
  expect(script).toContain('if (process.env.DEEPAGENT_CODE_SKIP_RELEASE_UPLOAD !== "1")')
  expect(script.indexOf("const ownerAuthorizationFile")).toBeLessThan(script.indexOf("if (Script.release)"))
})
