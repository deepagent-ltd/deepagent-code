import { describe, expect, test } from "bun:test"
import { validateReadOnlyGitArgs } from "../../src/tool/git_read"

describe("git_read argument boundary", () => {
  const allowedCases: ReadonlyArray<readonly string[]> = [
    ["log", "--oneline", "-20"],
    ["diff", "HEAD~1..HEAD", "--", "src/"],
    ["show", "HEAD:package.json"],
    ["branch", "--list", "feature/*"],
    ["tag", "--list", "v*"],
    ["remote", "-v"],
    ["reflog", "show", "HEAD"],
    ["stash", "list"],
    ["stash", "show", "stash@{0}"],
  ]

  for (const args of allowedCases) {
    test(`allows read-only command: git ${args.join(" ")}`, () => {
      expect(validateReadOnlyGitArgs(args)).toBeUndefined()
    })
  }

  const blockedCases: ReadonlyArray<readonly string[]> = [
    ["commit", "-m", "unexpected write"],
    ["branch", "feature/new"],
    ["branch", "-D", "feature/old"],
    ["tag", "v1.0.0"],
    ["tag", "--delete", "v1.0.0"],
    ["remote", "set-url", "origin", "example.invalid/repo"],
    ["remote", "prune", "origin"],
    ["reflog", "expire", "--all"],
    ["reflog", "delete", "HEAD@{0}"],
    ["stash"],
    ["stash", "push"],
    ["stash", "pop"],
    ["diff", "--output=/tmp/git-read-write"],
    ["log", "-o", "/tmp/git-read-write"],
    ["show", "--textconv", "HEAD:file"],
    ["grep", "--open-files-in-pager=sh", "needle"],
  ]

  for (const args of blockedCases) {
    test(`blocks mutating/process-executing command: git ${args.join(" ")}`, () => {
      expect(validateReadOnlyGitArgs(args)).toBeString()
    })
  }
})
