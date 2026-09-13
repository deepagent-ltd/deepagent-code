import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"
import { finalizeSessionWork } from "@/deepagent/session-finalizer"

// G2 unified finalizer regression: the abs failure mode ("implemented but never committed → the
// verifier graded an empty diff") must be impossible — the runtime delivers the work; a failing
// validation withholds delivery (the tree is diagnostic evidence); a commit failure leaves the
// tree untouched (work is never lost); an empty diff is not reported as success.

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-finalizer-"))
  const git = (args: string) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString()
  git('init -q -b main 2>/dev/null || git init -q')
  git('-c user.name=t -c user.email=t@t commit --no-gpg-sign --allow-empty -m base -q')
  return dir
}

const gitAt = (dir: string, args: string) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString()

describe("session finalizer", () => {
  test("commits uncommitted work with the runtime identity", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "feature.go"), "package x")
    const outcome = await finalizeSessionWork({ directory: dir, validationPassed: null })
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    expect(outcome.files).toBe(1)
    // The diff the verifier grades is no longer empty.
    expect(gitAt(dir, "diff --name-only HEAD~1 HEAD").trim()).toBe("feature.go")
    expect(gitAt(dir, "log -1 --format=%an").trim()).toBe("coauthor-deepagent")
    expect(gitAt(dir, "status --porcelain").trim()).toBe("")
  })

  test("reports no_changes for a clean tree (never fabricates delivery)", async () => {
    const dir = makeRepo()
    const outcome = await finalizeSessionWork({ directory: dir, validationPassed: null })
    expect(outcome.kind).toBe("no_changes")
  })

  test("withholds the commit when the last validation failed", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "feature.go"), "package x")
    const outcome = await finalizeSessionWork({ directory: dir, validationPassed: false })
    expect(outcome.kind).toBe("validation_failed")
    // The tree is untouched — the work stays as diagnostic evidence for the next round.
    expect(gitAt(dir, "status --porcelain").trim()).not.toBe("")
  })

  test("skips (without touching anything) outside a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deepagent-finalizer-nogit-"))
    writeFileSync(path.join(dir, "loose.txt"), "x")
    const outcome = await finalizeSessionWork({ directory: dir, validationPassed: null })
    expect(outcome.kind).toBe("skipped")
    expect(outcome.kind === "skipped" && outcome.reason).toBe("not_a_git_repo")
  })
})
