// Negative fixtures for the brand-residue audit gate (W11).
//
// The gate scans `git ls-files`, so every case runs the script inside a
// throwaway git repository that mirrors the script's expected path layout
// (packages/deepagent-code/script/audit-branding.ts). The brand tokens below
// are injected fixture data, not residue; this file is whole-file exempt in
// the gate itself.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import path from "node:path"
import { tmpRoot, tmpRootShared } from "./fixture/fixture"

const scriptRel = "packages/deepagent-code/script/audit-branding.ts"
const scriptSrc = path.resolve(import.meta.dir, "../script/audit-branding.ts")

const attributionLines = [
  {
    file: "packages/app/src/components/settings-v2/about.tsx",
    line: '<Link href="https://github.com/anomalyco/opencode">OpenCode</Link>',
  },
  {
    file: "packages/app/src/i18n/en.ts",
    line: '"Derived from OpenCode under MIT. DeepAgent Code is distributed under AGPL-3.0-or-later; see the complete notices below.",',
  },
  {
    file: "packages/app/src/i18n/zh.ts",
    line: '"基于 MIT 许可的 OpenCode 派生。DeepAgent Code 以 AGPL-3.0-or-later 发布，完整归因见下方声明。",',
  },
  {
    file: "packages/app/src/i18n/zht.ts",
    line: '"基於 MIT 授權的 OpenCode 衍生。DeepAgent Code 以 AGPL-3.0-or-later 發布，完整歸屬聲明見下方。",',
  },
  {
    file: "packages/app/test/components/settings-content.test.tsx",
    line: 'it("uses authoritative license bytes and distinguishes product links from OpenCode attribution", async () => {',
  },
  {
    file: "packages/app/test/components/settings-content.test.tsx",
    line: 'fireEvent.click(screen.getByRole("link", { name: "OpenCode" }))',
  },
  {
    file: "packages/app/test/components/settings-content.test.tsx",
    line: 'expect(wiring.openLink).toHaveBeenLastCalledWith("https://github.com/anomalyco/opencode")',
  },
]

const reviewedLines = [
  {
    file: ".github/public-source-policy.json",
    line: '"review_scope": "Public product and developer documentation may evolve independently of OpenCode text. Newly added document paths require review. Internal plans, acceptance records and private backend exports remain private.",',
  },
  { file: ".github/public-source-policy.json", line: '"packages/console/app/.opencode/agent/css.md",' },
  { file: ".github/public-source-policy.json", line: '"specs/storage/remove-opencode-db.md"' },
  {
    file: "README.md",
    line: "DAC builds on [opencode](https://github.com/sst/opencode) and other open-source components. Original license notices and attribution are retained in [NOTICE](NOTICE) and the relevant packages. No endorsement by upstream projects or their contributors is implied.",
  },
  {
    file: "packages/deepagent-code/README.md",
    line: "The runtime builds on OpenCode and adds persistent task state, event-driven work coordination, document-based context, and domain packs. Tools, MCP integrations, and domain packs extend the existing agent runtime.",
  },
  {
    file: "packages/app/test/components/dialog-event-work.test.tsx",
    line: '"Content-Type,Authorization,x-opencode-directory,x-opencode-workspace,x-deepagent-code-directory,x-deepagent-code-workspace",',
  },
  {
    file: "packages/core/src/plugin/skill/customize-deepagent-code.md",
    line: "provided by DAC's platform path implementation; it is not OpenCode's XDG path.",
  },
  ...attributionLines,
]

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function runAudit(files: Record<string, string>): Promise<number> {
  const dir = mkdtempSync(tmpRootShared())
  tempDirs.push(dir)
  const phases: { phase: string; code?: number | null; signal?: string | null; stderr?: string }[] = []
  const run = async (phase: string, command: string, args: string[], cwd?: string) => {
    phases.push({ phase: `${phase}-spawn` })
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    const output = { stderr: "", error: undefined as string | undefined }
    child.stdout?.on("data", () => {})
    child.stderr?.on("data", (chunk: Buffer) => { output.stderr = (output.stderr + chunk.toString()).slice(-4096) })
    child.once("error", (error: NodeJS.ErrnoException) => { output.error = error.code ?? "spawn-error" })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })))
    try {
      const result = await closed
      phases.push({ phase: `${phase}-close`, ...result, stderr: output.stderr })
      if (output.error || result.code === null || result.signal)
        throw new Error(`Owned audit child failed: ${JSON.stringify({ phases, error: output.error })}`)
      return result.code
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
    }
  }
  if (await run("git-init", "git", ["-C", dir, "init", "-q"]) !== 0)
    throw new Error(`Owned audit git init failed: ${JSON.stringify(phases)}`)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(path.dirname(path.join(dir, scriptRel)), { recursive: true })
  const original = readFileSync(scriptSrc, "utf8")
  const markers = [
    { anchor: "const repoRoot = Bun.spawnSync(", phase: "entered" },
    { anchor: "if (!repoRoot) {", phase: "repo-root-ready" },
    { anchor: "const BRAND_WORDS = [", phase: "tracked-ready" },
  ]
  const instrumented = markers.reduce((source, marker) => {
    if (source.split(marker.anchor).length !== 2) throw new Error(`Owned audit phase anchor changed: ${marker.phase}`)
    return source.replace(marker.anchor, `console.error("DAC_AUDIT_PHASE ${marker.phase}")\n${marker.anchor}`)
  }, original)
  if (markers.reduce((source, marker) =>
    source.replace(`console.error("DAC_AUDIT_PHASE ${marker.phase}")\n`, ""), instrumented) !== original)
    throw new Error("Owned audit phase instrumentation changed the original scanning source")
  writeFileSync(path.join(dir, scriptRel), instrumented)
  if (await run("git-add", "git", ["-C", dir, "add", "-A"]) !== 0)
    throw new Error(`Owned audit git add failed: ${JSON.stringify(phases)}`)
  const code = await run("audit", "bun", [scriptRel], dir)
  if (code !== 0 && code !== 1) throw new Error(`Owned audit exited unexpectedly: ${JSON.stringify(phases)}`)
  return code
}

describe("audit-branding gate", () => {
  test("drains a real audit child finding stream beyond pipe capacity", async () => {
    expect(await runAudit({ "docs/large.md": "lessweb\n".repeat(20_000) })).toBe(1)
  })

  test("fails on a brand token in a text file", async () => {
    expect(await runAudit({ "docs/note.md": "built with lessweb\n" })).toBe(1)
  })

  test("fails on a brand token in an mdx text file", async () => {
    expect(await runAudit({ "docs/guide.mdx": "To use the API with Opencode:\n" })).toBe(1)
  })

  test("fails on a brand token inside a source string", async () => {
    expect(await runAudit({ "packages/core/src/app.ts": 'export const s = "lessweb"\n' })).toBe(1)
  })

  test("fails on a brand token inside template-literal content", async () => {
    expect(await runAudit({ "packages/core/src/app.ts": "export const t = `lessweb`\n" })).toBe(1)
  })

  test("passes when identifiers in template expressions are the only occurrence", async () => {
    expect(await runAudit({ "packages/core/src/app.ts": 'export const t = `${fn("}")+lessweb}`\n' })).toBe(0)
  })

  test("passes when a brand word is only a bare identifier", async () => {
    expect(await runAudit({ "packages/core/src/app.ts": "export const x = lessweb\n" })).toBe(0)
  })

  test("passes when the only token is an exempt word on its bound marker line", async () => {
    expect(
      await runAudit({
        "README.md": "This project is derived from [opencode](https://opencode.ai).\n",
      }),
    ).toBe(0)
  })

  test("does not exempt an unbound word even on a marker line", async () => {
    expect(
      await runAudit({
        "README.md": "derived from opencode, and also uses lessweb\n",
      }),
    ).toBe(1)
  })

  test("records a text hit through the exemption marker when the word is unbound", async () => {
    expect(
      await runAudit({
        "README.md": "derived from lessweb\n",
      }),
    ).toBe(1)
  })

  test("passes on documented SDK compatibility export names in web docs", async () => {
    expect(
      await runAudit({
        "packages/web/src/content/docs/sdk.mdx": 'import { createOpencode } from "@deepagent-code/sdk"\n',
      }),
    ).toBe(0)
  })

  test("still fails on narrative text next to SDK export names in the same file", async () => {
    expect(
      await runAudit({
        "packages/web/src/content/docs/sdk.mdx":
          'import { createOpencode } from "@deepagent-code/sdk"\nbuild with Opencode today\n',
      }),
    ).toBe(1)
  })

  test.each(reviewedLines)("passes the exact reviewed line in $file", async (entry) => {
    expect(await runAudit({ [entry.file]: `  ${entry.line}\n` })).toBe(0)
  })

  test.each(reviewedLines)("rejects extra residue next to the reviewed line in $file", async (entry) => {
    expect(await runAudit({ [entry.file]: `${entry.line}\n"OpenCode product branding"\n` })).toBe(1)
    expect(await runAudit({ [entry.file]: `${entry.line} "OpenCode product branding"\n` })).toBe(1)
  })

  test("does not allow reviewed context in another path or an unrelated brand on the same line", async () => {
    expect(await runAudit({ "other-policy.json": reviewedLines[0].line })).toBe(1)
    expect(await runAudit({ "README.md": `${reviewedLines[3].line} lessweb\n` })).toBe(1)
  })

  test.each(attributionLines)("rejects reviewed attribution outside its exact path in $file", async (entry) => {
    expect(await runAudit({ "packages/core/src/unreviewed-attribution.ts": `${entry.line}\n` })).toBe(1)
    expect(await runAudit({ [entry.file]: `${entry.line} "lessweb"\n` })).toBe(1)
  })
})
