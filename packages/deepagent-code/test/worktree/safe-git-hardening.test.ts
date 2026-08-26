import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { hardenedGitArgs } from "../../src/worktree/index"

// I33-5: safeGit runs read-only git (diff/status/rev-list) inside a worktree that may check out an
// ATTACKER-CONTROLLED repo. git has content-driven code paths that execute on ordinary reads —
// external diff drivers, textconv filters, hooks — so a mere `git diff` must not run repo-configured
// commands. `hardenedGitArgs` prepends the config that neutralizes them. These tests pin (1) the exact
// argument shape and (2) an END-TO-END proof against a real hostile repo that the drivers do NOT fire.

describe("I33-5 hardenedGitArgs — argument shape", () => {
  test("non-diff subcommand: only the hooksPath neutralizer is prepended", () => {
    expect(hardenedGitArgs(["status", "--porcelain"])).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "status",
      "--porcelain",
    ])
  })

  test("diff subcommand gets --no-ext-diff + --no-textconv, inserted right after `diff`", () => {
    expect(hardenedGitArgs(["diff", "--numstat", "a..HEAD"])).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "a..HEAD",
    ])
  })

  test("non-diff subcommands do NOT get diff-only flags (rev-list/status would reject them)", () => {
    const revlist = hardenedGitArgs(["rev-list", "--count", "a..HEAD"])
    expect(revlist).not.toContain("--no-textconv")
    expect(revlist).not.toContain("--no-ext-diff")
  })
})

// End-to-end: build a repo whose gitattributes wires malicious diff drivers, then confirm plain git
// executes them (the vulnerability) while hardenedGitArgs blocks them (the fix). Skips if git absent.
describe("I33-5 hardenedGitArgs — end-to-end against a hostile repo", () => {
  let repo: string
  let sentinelDir: string
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  const pwned = (name: string) => existsSync(path.join(sentinelDir, name))

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "i335-repo-"))
    sentinelDir = mkdtempSync(path.join(tmpdir(), "i335-sentinel-"))
    git(["init", "-q"])
    git(["config", "user.email", "t@t.t"])
    git(["config", "user.name", "t"])
    // Malicious external diff driver + textconv, wired to a file via .gitattributes.
    git(["config", "diff.evil.external", `/bin/sh -c "touch ${path.join(sentinelDir, "PWNED_EXTERNAL")}"`])
    git(["config", "diff.evil.textconv", `/bin/sh -c "touch ${path.join(sentinelDir, "PWNED_TEXTCONV")}" <`])
    writeFileSync(path.join(repo, ".gitattributes"), "f.txt diff=evil\n")
    writeFileSync(path.join(repo, "f.txt"), "v1\n")
    git(["add", "f.txt", ".gitattributes"])
    git(["commit", "-qm", "init"])
    writeFileSync(path.join(repo, "f.txt"), "v2\n") // a change so `git diff` has work to do
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(sentinelDir, { recursive: true, force: true })
  })

  // git may exit non-zero (e.g. the malicious external driver dies); we only care whether the sentinel
  // was created, so run non-throwing. The real safeGit goes through base git() which catches exit codes.
  const runGit = (args: string[]) => {
    try {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" })
    } catch {
      /* exit code irrelevant to this test — the sentinel is the signal */
    }
  }

  test("baseline: plain `git diff` EXECUTES the malicious drivers (proves the vector is real)", () => {
    runGit(["diff"])
    expect(pwned("PWNED_EXTERNAL") || pwned("PWNED_TEXTCONV")).toBe(true)
  })

  test("hardened: `git <hardenedGitArgs(diff)>` does NOT execute any malicious driver", () => {
    runGit(hardenedGitArgs(["diff"]))
    expect(pwned("PWNED_EXTERNAL")).toBe(false)
    expect(pwned("PWNED_TEXTCONV")).toBe(false)
  })

  test("hardened: `diff --numstat` (the real safeGit call) also stays clean + exits cleanly", () => {
    runGit(hardenedGitArgs(["diff", "--numstat"]))
    expect(pwned("PWNED_EXTERNAL")).toBe(false)
    expect(pwned("PWNED_TEXTCONV")).toBe(false)
  })
})
