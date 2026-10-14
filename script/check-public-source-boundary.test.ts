import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const script = resolve(import.meta.dir, "check-public-source-boundary.ts")
// A temporary repository must not inherit the host worktree/index or user hooks/signing config.
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
}

async function repository(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(resolve(tmpdir(), "dac-public-boundary-"))
  try {
    // Git for Windows cannot read node:os.devNull as a config pathname.
    await Bun.write(resolve(root, ".fixture-gitconfig"), "")
    git(root, ["init", "--quiet"])
    git(root, ["config", "user.name", "deepagent-ai"])
    git(root, ["config", "user.email", "deepagent-ai@deepagent.ltd"])
    await Bun.write(resolve(root, "public.md"), "Public upstream content\n")
    await Bun.write(resolve(root, ".github/public-source-policy.json"), JSON.stringify({ version: 2, public_document_paths: ["public.md"], private_document_paths: ["internal-test-contract.md"] }))
    await Bun.write(resolve(root, ".gitignore"), "docs/\n.fixture-gitconfig\n")
    git(root, ["add", "."])
    git(root, ["commit", "--quiet", "-m", "test: public source"])
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...environment, GIT_CONFIG_GLOBAL: resolve(root, ".fixture-gitconfig") }, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

function check(root: string, args: string[]) {
  return Bun.spawnSync([process.execPath, script, ...args], { cwd: root, env: { ...environment, GIT_CONFIG_GLOBAL: resolve(root, ".fixture-gitconfig") }, stdout: "pipe", stderr: "pipe" })
}

test("verified public documents and ignored private archives pass", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "docs/private.md"), "Local private archive\n")
    expect(check(root, ["--worktree", "--history"]).exitCode).toBe(0)
  })
})

test("normal edits to approved public DAC documentation are allowed", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "public.md"), "Unapproved replacement\n")
    expect(check(root, ["--worktree"]).exitCode).toBe(0)
  })
})

test("new unstaged Markdown cannot bypass the policy", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "new.MDX"), "Unapproved new document\n")
    expect(check(root, ["--worktree"]).exitCode).toBe(1)
  })
})

test("force-added root docs are rejected", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "docs/private.md"), "Private history\n")
    git(root, ["add", "-f", "docs/private.md"])
    git(root, ["commit", "--quiet", "-m", "test: private document"])
    expect(check(root, []).exitCode).toBe(1)
  })
})

test("clean current tree does not conceal private ancestor documents", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "docs/private.md"), "Private ancestor\n")
    git(root, ["add", "-f", "docs/private.md"])
    git(root, ["commit", "--quiet", "-m", "test: private ancestor"])
    git(root, ["rm", "--quiet", "docs/private.md"])
    git(root, ["commit", "--quiet", "-m", "test: clean current tree"])
    expect(check(root, []).exitCode).toBe(0)
    expect(check(root, ["--history"]).exitCode).toBe(1)
  })
})

test("approved public documents may evolve through ordinary history", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "public.md"), "Unapproved historic body\n")
    git(root, ["add", "public.md"])
    git(root, ["commit", "--quiet", "-m", "test: unapproved history"])
    await Bun.write(resolve(root, "public.md"), "Public upstream content\n")
    git(root, ["add", "public.md"])
    git(root, ["commit", "--quiet", "-m", "test: public restoration"])
    expect(check(root, []).exitCode).toBe(0)
    expect(check(root, ["--history"]).exitCode).toBe(0)
  })
})

test("internal test contracts cannot be republished through a clean current tree", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "internal-test-contract.md"), "Internal acceptance record\n")
    git(root, ["add", "internal-test-contract.md"])
    git(root, ["commit", "--quiet", "-m", "test: internal record"])
    git(root, ["rm", "--quiet", "internal-test-contract.md"])
    git(root, ["commit", "--quiet", "-m", "test: current tree cleanup"])
    expect(check(root, []).exitCode).toBe(0)
    expect(check(root, ["--history"]).exitCode).toBe(1)
  })
})

test("private backend source exports are rejected even without Markdown", async () => {
  await repository(async (root) => {
    await Bun.write(resolve(root, "release/source-closure/kernel/server.go"), "package server\n")
    git(root, ["add", "release/source-closure/kernel/server.go"])
    git(root, ["commit", "--quiet", "-m", "test: private backend export"])
    expect(check(root, []).exitCode).toBe(1)
  })
})
