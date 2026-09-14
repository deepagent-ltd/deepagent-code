import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"
import { finalizeSessionWork } from "@/deepagent/session-finalizer"

// G2 unified finalizer regression: the abs failure mode ("implemented but never committed → the
// verifier graded an empty diff") must be impossible — but ONLY the EXPLICIT "validated" verdict
// ever commits (review round 5: the boolean|null contract let "unverified" ride the null branch
// and commit anyway). "validation_failed" and "unverified" both withhold; the tree keeps the
// work (delivery defers, never loses); only the session's own touched paths are ever staged.

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-finalizer-"))
  const git = (args: string) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString()
  git('init -q -b main 2>/dev/null || git init -q')
  git('-c user.name=t -c user.email=t@t commit --no-gpg-sign --allow-empty -m base -q')
  return dir
}

const gitAt = (dir: string, args: string) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString()

describe("session finalizer", () => {
  test("validated: commits the session's touched work with the runtime identity", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "feature.go"), "package x")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["feature.go"],
    })
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    expect(outcome.files).toBe(1)
    expect(gitAt(dir, "diff --name-only HEAD~1 HEAD").trim()).toBe("feature.go")
    expect(gitAt(dir, "log -1 --format=%an").trim()).toBe("coauthor-deepagent")
    expect(gitAt(dir, "status --porcelain").trim()).toBe("")
  })

  test("unverified: NEVER commits — no evidence means withhold, not deliver (review round 5)", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "feature.go"), "package x")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "unverified",
      touchedPaths: ["feature.go"],
    })
    expect(outcome.kind).toBe("unverified")
    // No commit happened; the work stays in the tree.
    expect(gitAt(dir, "log --oneline").trim().split("\n")).toHaveLength(1)
    expect(gitAt(dir, "status --porcelain").trim()).not.toBe("")
  })

  test("validation_failed: withholds (diagnostic evidence for the next round)", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "feature.go"), "package x")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validation_failed",
      touchedPaths: ["feature.go"],
    })
    expect(outcome.kind).toBe("validation_failed")
    expect(gitAt(dir, "log --oneline").trim().split("\n")).toHaveLength(1)
    expect(gitAt(dir, "status --porcelain").trim()).not.toBe("")
  })

  test("NEVER commits the user's unrelated uncommitted work (no git add -A)", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "session-file.ts"), "export {}")
    writeFileSync(path.join(dir, "user-notes.md"), "the user's own draft")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["session-file.ts"],
    })
    expect(outcome.kind).toBe("committed")
    expect(gitAt(dir, "diff --name-only HEAD~1 HEAD").trim()).toBe("session-file.ts")
    expect(gitAt(dir, "status --porcelain").trim()).toContain("user-notes.md")
  })

  test("no attributable paths skips delivery instead of committing blindly", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "anything.txt"), "x")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: [],
    })
    expect(outcome.kind).toBe("skipped")
    expect(outcome.kind === "skipped" && outcome.reason).toBe("no_attributable_paths")
    expect(gitAt(dir, "status --porcelain").trim()).not.toBe("")
  })

  test("reports no_changes for a clean tree of touched paths (never fabricates delivery)", async () => {
    const dir = makeRepo()
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["already-committed.go"],
    })
    expect(outcome.kind).toBe("no_changes")
  })

  test("skips (without touching anything) outside a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deepagent-finalizer-nogit-"))
    writeFileSync(path.join(dir, "loose.txt"), "x")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["loose.txt"],
    })
    expect(outcome.kind).toBe("skipped")
    expect(outcome.kind === "skipped" && outcome.reason).toBe("not_a_git_repo")
  })
})
