import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeepAgentWorkspace } from "@/deepagent/workspace-context"

const roots: string[] = []

afterEach(async () => {
  roots.forEach(DeepAgentWorkspace.invalidate)
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function workspace(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

describe("DeepAgentWorkspace", () => {
  test("deduplicates concurrent detection by canonical directory", async () => {
    const root = await workspace("workspace-context-canonical")
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))

    const [left, right] = await Promise.all([
      DeepAgentWorkspace.detect(root),
      DeepAgentWorkspace.detect(path.join(root, ".")),
    ])

    expect(left).toBe(right)
    expect(DeepAgentWorkspace.getCached(root)).toBe(left)
  })

  test("bounds high-cardinality workspace snapshots", async () => {
    const directories = await Promise.all(Array.from({ length: 129 }, (_, index) => workspace(`workspace-${index}`)))
    for (const directory of directories) await DeepAgentWorkspace.detect(directory)

    expect(DeepAgentWorkspace.getCached(directories[0])).toBeNull()
    expect(DeepAgentWorkspace.getCached(directories.at(-1)!)).not.toBeNull()
  })

  test("detects common Python projects and the real git identity", async () => {
    const root = await workspace("workspace-context-git")
    await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = 'fixture'\n")
    const init = Bun.spawn(["git", "init", "-b", "audit-branch"], { cwd: root, stdout: "ignore", stderr: "ignore" })
    expect(await init.exited).toBe(0)

    const result = await DeepAgentWorkspace.detect(root)

    expect(result.hasPython).toBe(true)
    expect(result.gitBranch).toBe("audit-branch")
    expect(result.gitRoot).toBe(await fs.realpath(root))
  })

  test("detects Go modules and exposes their validation command", async () => {
    const root = await workspace("workspace-context-go")
    await fs.writeFile(path.join(root, "go.mod"), "module example.test/project\n\ngo 1.24\n")

    const result = await DeepAgentWorkspace.detect(root)

    expect(result.hasGo).toBe(true)
    expect(result.validationCommands).toContain("go test ./...")
  })
})
