import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { indexWorkspace } from "../../src/code-intelligence/typescript-workspace-adapter"
import { indexMarkdown } from "../../src/document-intelligence/markdown-adapter"
import { isRepoDocument, scan } from "../../src/location-index/manifest"
import { tmpdir } from "../fixture/fixture"

describe("Location index adapters", () => {
  test("builds TS/JS workspace symbols, module resolution, exports, and calls", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "src"))
    await Bun.write(
      path.join(tmp.path, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
    )
    await Bun.write(path.join(tmp.path, "src/a.ts"), "export function alpha(value: number) { return value + 1 }\n")
    await Bun.write(
      path.join(tmp.path, "src/b.ts"),
      'import { alpha } from "./a"\nexport function useAlpha() { return alpha(1) }\n',
    )

    const manifest = await scan({ root: tmp.path })
    const build = indexWorkspace({ root: tmp.path, files: manifest.files })
    expect(manifest.complete).toBe(true)
    expect(build.files.find((file) => file.file.path === "src/a.ts")?.file.semanticLevel).toBe("semantic")
    expect(build.files.flatMap((file) => file.symbols.map((symbol) => symbol.symbol.symbolPath))).toContain("alpha")
    expect(build.files.flatMap((file) => file.symbols.map((symbol) => symbol.symbol.symbolPath))).toContain("useAlpha")
    expect(build.edges.some((edge) => edge.relation === "imports")).toBe(true)
    expect(build.edges.some((edge) => edge.relation === "calls")).toBe(true)
    expect(
      build.files
        .flatMap((file) => file.edges)
        .some((edge) => edge.relation === "exports" && edge.evidence.includes("modifier")),
    ).toBe(true)
  })

  test("rebuilds module resolution when tsconfig changes", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "src"))
    await Bun.write(path.join(tmp.path, "src/a.ts"), "export const alpha = 1\n")
    await Bun.write(path.join(tmp.path, "src/b.ts"), 'import { alpha } from "@lib/a"\nexport const beta = alpha\n')
    await Bun.write(
      path.join(tmp.path, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"] } }, include: ["src"] }),
    )
    const manifest = await scan({ root: tmp.path })
    const resolved = indexWorkspace({ root: tmp.path, files: manifest.files })
    expect(resolved.externalEntities).toEqual([])
    expect(resolved.edges.some((edge) => edge.relation === "imports")).toBe(true)

    await Bun.write(path.join(tmp.path, "tsconfig.json"), JSON.stringify({ compilerOptions: {}, include: ["src"] }))
    const invalidated = indexWorkspace({ root: tmp.path, files: (await scan({ root: tmp.path })).files })
    expect(invalidated.externalEntities.map((entity) => entity.displayName)).toEqual(["@lib/a"])
  })

  test("filters ignored, sensitive, binary, and escaping symlink content before candidate creation", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await mkdir(path.join(tmp.path, "ignored"))
    await Bun.write(path.join(tmp.path, ".gitignore"), "ignored/\n")
    await Bun.write(path.join(tmp.path, "visible.ts"), "export const visible = true\n")
    await Bun.write(path.join(tmp.path, ".env.local"), "TOKEN=secret\n")
    await Bun.write(path.join(tmp.path, "ignored/private.ts"), "ignored secret\n")
    await writeFile(path.join(tmp.path, "binary.ts"), Buffer.from([0, 1, 2]))
    await Bun.write(path.join(outside.path, "outside.ts"), "outside secret\n")
    await symlink(path.join(outside.path, "outside.ts"), path.join(tmp.path, "escape.ts"))

    const manifest = await scan({ root: tmp.path })
    expect(manifest.files.map((file) => file.path)).toEqual(["visible.ts"])
    expect(manifest.skippedSensitive).toBe(1)
    expect(manifest.skippedBinary).toBe(1)
  })

  test("parses Repo Document heading paths, anchors, and line ranges", async () => {
    await using tmp = await tmpdir()
    const content = "# Architecture\nintro\n\n## Runtime Tail\nselected context\n\n## Recovery\ncrash recovery\n"
    await Bun.write(path.join(tmp.path, "README.md"), content)
    const file = (await scan({ root: tmp.path })).files[0]!
    expect(isRepoDocument(file.path)).toBe(true)
    expect(indexMarkdown(file).map((entry) => ({
      heading: entry.headingPath,
      anchor: entry.anchor,
      lines: [entry.startLine, entry.endLine],
    }))).toEqual([
      { heading: "Architecture", anchor: "architecture", lines: [1, 3] },
      { heading: "Architecture / Runtime Tail", anchor: "runtime-tail", lines: [4, 6] },
      { heading: "Architecture / Recovery", anchor: "recovery", lines: [7, 8] },
    ])
  })
})
