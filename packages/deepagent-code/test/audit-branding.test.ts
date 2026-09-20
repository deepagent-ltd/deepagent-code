// Negative fixtures for the brand-residue audit gate (W11).
//
// The gate scans `git ls-files`, so every case runs the script inside a
// throwaway git repository that mirrors the script's expected path layout
// (packages/deepagent-code/script/audit-branding.ts). The brand tokens below
// are injected fixture data, not residue; this file is whole-file exempt in
// the gate itself.
import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { tmpRoot, tmpRootShared } from "./fixture/fixture"

const scriptRel = "packages/deepagent-code/script/audit-branding.ts"
const scriptSrc = path.resolve(import.meta.dir, "../script/audit-branding.ts")

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runAudit(files: Record<string, string>): number {
  const dir = mkdtempSync(tmpRootShared())
  tempDirs.push(dir)
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args])
  git(["init", "-q"])
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(path.dirname(path.join(dir, scriptRel)), { recursive: true })
  copyFileSync(scriptSrc, path.join(dir, scriptRel))
  git(["add", "-A"])
  const result = Bun.spawnSync(["bun", scriptRel], { cwd: dir })
  return result.exitCode ?? -1
}

describe("audit-branding gate", () => {
  test("fails on a brand token in a text file", () => {
    expect(runAudit({ "docs/note.md": "built with lessweb\n" })).toBe(1)
  })

  test("fails on a brand token in an mdx text file", () => {
    expect(runAudit({ "docs/guide.mdx": "To use the API with Opencode:\n" })).toBe(1)
  })

  test("fails on a brand token inside a source string", () => {
    expect(runAudit({ "packages/core/src/app.ts": 'export const s = "lessweb"\n' })).toBe(1)
  })

  test("fails on a brand token inside template-literal content", () => {
    expect(runAudit({ "packages/core/src/app.ts": "export const t = `lessweb`\n" })).toBe(1)
  })

  test("passes when identifiers in template expressions are the only occurrence", () => {
    expect(runAudit({ "packages/core/src/app.ts": 'export const t = `${fn("}")+lessweb}`\n' })).toBe(0)
  })

  test("passes when a brand word is only a bare identifier", () => {
    expect(runAudit({ "packages/core/src/app.ts": "export const x = lessweb\n" })).toBe(0)
  })

  test("passes when the only token is an exempt word on its bound marker line", () => {
    expect(
      runAudit({
        "README.md": "This project is derived from [opencode](https://opencode.ai).\n",
      }),
    ).toBe(0)
  })

  test("does not exempt an unbound word even on a marker line", () => {
    expect(
      runAudit({
        "README.md": "derived from opencode, and also uses lessweb\n",
      }),
    ).toBe(1)
  })

  test("records a text hit through the exemption marker when the word is unbound", () => {
    expect(
      runAudit({
        "README.md": "derived from lessweb\n",
      }),
    ).toBe(1)
  })

  test("passes on documented SDK compatibility export names in web docs", () => {
    expect(
      runAudit({
        "packages/web/src/content/docs/sdk.mdx": 'import { createOpencode } from "@deepagent-code/sdk"\n',
      }),
    ).toBe(0)
  })

  test("still fails on narrative text next to SDK export names in the same file", () => {
    expect(
      runAudit({
        "packages/web/src/content/docs/sdk.mdx":
          'import { createOpencode } from "@deepagent-code/sdk"\nbuild with Opencode today\n',
      }),
    ).toBe(1)
  })
})
