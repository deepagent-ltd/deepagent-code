import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { detectValidationSignals, inferValidationCommands, packageScriptRunner } from "../../src/deepagent/validation"
import { tmpRoot, tmpRootShared } from "../fixture/tmpdir"

describe("validation command inference", () => {
  test("recognizes Go modules used by Go coding tasks", () => {
    expect(
      inferValidationCommands({
        hasTypeScript: false,
        hasPython: false,
        hasGo: true,
      }),
    ).toEqual(["go test ./..."])
  })

  test("runs package scripts through the declared package manager", () => {
    const packageJson = { packageManager: "pnpm@9.1.0", scripts: { test: "vitest run" } }

    expect(packageScriptRunner(packageJson, "npm run")).toBe("pnpm run")
    expect(inferValidationCommands({ packageJson, hasTypeScript: false, hasPython: false })).toEqual(["pnpm run test"])
    expect(packageScriptRunner({ packageManager: "yarn@4.0.0" }, "npm run")).toBe("yarn")
    expect(packageScriptRunner({ packageManager: "unknown@1.0.0" }, "bun run")).toBe("bun run")
    expect(packageScriptRunner(undefined, "bun run")).toBe("bun run")
  })
})

describe("detectValidationSignals", () => {
  // The detector is synchronous on purpose (see its doc comment): the runner's prepare path must not
  // gain scheduler yield points between prompt admission and provider dispatch.
  test("reads the same workspace signals the V1 detector uses", () => {
    const directory = mkdtempSync(tmpRootShared())
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@9.1.0",
        scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
      }),
    )
    writeFileSync(path.join(directory, "pyproject.toml"), "[project]\nname = 'fixture'\n")
    writeFileSync(path.join(directory, "go.mod"), "module example.test/project\n\ngo 1.24\n")
    writeFileSync(path.join(directory, "AGENTS.md"), "- `task verify` - test\n")

    const signals = detectValidationSignals(directory)

    expect(signals.hasTypeScript).toBe(true)
    expect(signals.hasPython).toBe(true)
    expect(signals.hasGo).toBe(true)
    expect(signals.runner).toBe("pnpm run")
    expect(inferValidationCommands(signals)).toEqual([
      "pnpm run typecheck",
      "pnpm run test",
      "python -m compileall -q .",
      "go test ./...",
      "task verify",
    ])
  })

  test("reports absent markers as absent", () => {
    const directory = mkdtempSync(tmpRootShared())
    expect(detectValidationSignals(directory)).toEqual({
      packageJson: undefined,
      agentsMd: undefined,
      hasTypeScript: false,
      hasPython: false,
      hasGo: false,
      runner: "bun run",
    })
  })

  test("survives a malformed package.json", () => {
    const directory = mkdtempSync(tmpRootShared())
    writeFileSync(path.join(directory, "package.json"), "{ not json")
    const signals = detectValidationSignals(directory)
    expect(signals.packageJson).toBeUndefined()
    expect(inferValidationCommands(signals)).toEqual([])
  })
})
