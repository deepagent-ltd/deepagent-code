import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync, execSync } from "node:child_process"
import { finalizeSessionWork, finalizerGitState } from "@/deepagent/session-finalizer"
import { tmpRoot, tmpRootShared } from "../fixture/fixture"

// G2 unified finalizer regression: the abs failure mode ("implemented but never committed → the
// verifier graded an empty diff") must be impossible — but ONLY the EXPLICIT "validated" verdict
// ever commits (review round 5: the boolean|null contract let "unverified" ride the null branch
// and commit anyway). "validation_failed" and "unverified" both withhold promotion while exporting
// an attributable patch ref; only the session's own touched paths are ever staged or preserved.

const makeRepo = (): string => {
  const dir = mkdtempSync(tmpRootShared())
  const git = (args: string) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString()
  git("init -q -b main 2>/dev/null || git init -q")
  git("-c user.name=t -c user.email=t@t commit --no-gpg-sign --allow-empty -m base -q")
  return dir
}

const gitAt = (dir: string, args: string) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString()
const patchAt = (dir: string, ref: string) => execFileSync("git", ["show", ref], { cwd: dir }).toString()

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
    if (outcome.kind !== "unverified") return
    expect(outcome.recoveryRef.startsWith("refs/deepagent-code/recovery/patch-")).toBe(true)
    const patch = patchAt(dir, outcome.recoveryRef)
    expect(patch).toContain("+++ b/feature.go")
    const replay = makeRepo()
    execFileSync("git", ["apply", "--binary", "-"], { cwd: replay, input: patch })
    expect(readFileSync(path.join(replay, "feature.go"), "utf8")).toBe("package x")
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
    if (outcome.kind !== "validation_failed") return
    expect(patchAt(dir, outcome.recoveryRef)).toContain("+++ b/feature.go")
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

  test("unverified patch contains only attributable paths and treats pathspec magic literally", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "feature[1].ts"), "export const attributable = true")
    writeFileSync(path.join(dir, "feature1.ts"), "export const unrelated = true")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "unverified",
      touchedPaths: ["feature[1].ts"],
    })
    expect(outcome.kind).toBe("unverified")
    if (outcome.kind !== "unverified") return
    const patch = patchAt(dir, outcome.recoveryRef)
    expect(patch).toContain("feature[1].ts")
    expect(patch).not.toContain("feature1.ts")
    expect(patch).not.toContain("unrelated")
    expect(gitAt(dir, "diff --cached --name-only").trim()).toBe("")
  })

  test("unverified patch preserves an explicitly touched ignored file without staging it", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, ".gitignore"), "generated/\n")
    gitAt(dir, "add .gitignore")
    gitAt(dir, '-c user.name=t -c user.email=t@t commit --no-gpg-sign -m "ignore generated" -q')
    writeFileSync(path.join(dir, "generated.txt"), "not ignored")
    mkdirSync(path.join(dir, "generated"))
    writeFileSync(path.join(dir, "generated", "result.bin"), "salvage me", { flag: "w" })
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "unverified",
      touchedPaths: ["generated/result.bin"],
    })
    expect(outcome.kind).toBe("unverified")
    if (outcome.kind !== "unverified") return
    const patch = patchAt(dir, outcome.recoveryRef)
    expect(patch).toContain("generated/result.bin")
    expect(patch).toContain("salvage me")
    expect(patch).not.toContain("generated.txt")
    expect(gitAt(dir, "diff --cached --name-only").trim()).toBe("")
  })

  test("NEVER consumes an unrelated file already staged before finalization", async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "session-file.ts"), "export {}")
    writeFileSync(path.join(dir, "user-notes.md"), "the user's staged draft")
    gitAt(dir, "add -- user-notes.md")
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["session-file.ts"],
    })
    expect(outcome.kind).toBe("committed")
    expect(gitAt(dir, "diff --name-only HEAD~1 HEAD").trim()).toBe("session-file.ts")
    // The caller's staged draft survives the runtime commit for the caller to finish later.
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

  // Round-7 abs C2: the model followed the task instruction ("work on this in a new branch from main
  // and commit everything"), committed to a side branch, and checked the original branch back out.
  // The attributable paths were then clean and the runtime reported `no changes to deliver` — true
  // about the worktree, blind to the fact that the work existed one branch away. The verdict must
  // say so and hand back a reference, never claim there was nothing.
  test("a clean attributable set with a moved branch/HEAD reports work off this delivery surface", async () => {
    const dir = makeRepo()
    const before = await finalizerGitState(dir)
    const headBefore = before.head!
    // The activity: create the file and commit it on a SIDE branch, then return to the base branch
    // with no uncommitted residue (exactly what the round-7 trace shows: "Committed 4a25593 on
    // branch add-slice-step; working tree clean").
    gitAt(dir, "checkout -q -b add-slice-step")
    writeFileSync(path.join(dir, "stepped.go"), "package x")
    // (the file is created AFTER switching branches: creating it on the base branch first would
    // make the base branch "hold" the work and the checkout-back a no-op)
    gitAt(dir, "add stepped.go")
    gitAt(dir, '-c user.name=m -c user.email=m@m commit --no-gpg-sign -m "feature" -q')
    gitAt(dir, "checkout -q main")

    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["stepped.go"],
      headBefore,
      branchBefore: "main",
      refsBefore: before.refs,
    })

    expect(outcome.kind).toBe("no_changes_on_this_branch")
    if (outcome.kind !== "no_changes_on_this_branch") return
    expect(outcome.branch).toBe("main")
    expect(outcome.headBefore).toBe(headBefore)
    // The recovery reference names the branch that actually holds the work.
    expect(outcome.recoveryRef.startsWith("add-slice-step@")).toBe(true)
    // The runtime must NOT have committed anything on the graded branch, and the work must survive.
    expect(gitAt(dir, "rev-parse HEAD").trim()).toBe(headBefore)
    expect(gitAt(dir, "rev-parse --verify add-slice-step").trim().length).toBeGreaterThan(0)
    expect(gitAt(dir, "show --name-only --format= add-slice-step").trim()).toBe("stepped.go")
    expect(gitAt(dir, "rev-parse --abbrev-ref HEAD").trim()).toBe("main")
  })

  test("a clean set with no branch or HEAD movement stays an honest no_changes", async () => {
    const dir = makeRepo()
    const headBefore = gitAt(dir, "rev-parse HEAD").trim()
    const outcome = await finalizeSessionWork({
      directory: dir,
      validation: "validated",
      touchedPaths: ["already-committed.go"],
      headBefore,
      branchBefore: "main",
    })
    expect(outcome.kind).toBe("no_changes")
  })

  test("skips (without touching anything) outside a git repo", async () => {
    const dir = mkdtempSync(tmpRootShared())
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
