import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { watch, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { exportSourceClosure, SourceClosureBounds } from "./export-source-closure"
import { materializeSourceClosure } from "./materialize-source-closure"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

async function git(root: string, args: string[], input?: string) {
  const child = Bun.spawn(["/usr/bin/git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : "pipe",
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Source Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Source Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: "2026-10-10T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-10T00:00:00Z",
    },
  })
  if (input !== undefined) {
    if (!child.stdin) throw new Error("fixture stdin missing")
    child.stdin.write(input)
    child.stdin.end()
  }
  const result = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (result[2] !== 0) throw new Error(`fixture Git ${args[0]} failed`)
  return result[0].trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-source-closure-"))
  roots.push(root)
  const canonical = await realpath(root)
  const repo = path.join(canonical, "repo")
  await mkdir(repo, { mode: 0o700 })
  await git(repo, ["init", "--quiet"])
  await git(repo, ["remote", "add", "origin", "https://github.com/deepagent-ltd/fixture-source.git"])
  const original = [
    { path: "LICENSE", bytes: "Apache License\nVersion 2.0, January 2004\n", mode: "100644" },
    { path: "main.go", bytes: "package main\nfunc main() {}\n", mode: "100644" },
    { path: "dead.go", bytes: "package main\n// obsolete\n", mode: "100644" },
    { path: "binary.bin", bytes: "original\0binary\n", mode: "100644" },
    { path: "tool.sh", bytes: "#!/bin/sh\nexit 0\n", mode: "100755" },
  ]
  const objects = []
  for (const entry of original) {
    objects.push(`${entry.mode} blob ${await git(repo, ["hash-object", "-w", "--stdin"], entry.bytes)}\t${entry.path}`)
    await Bun.write(path.join(repo, entry.path), entry.bytes)
    await chmod(path.join(repo, entry.path), entry.mode === "100755" ? 0o755 : 0o644)
  }
  const tree = await git(repo, ["mktree"], objects.join("\n") + "\n")
  const commit = await git(repo, ["commit-tree", tree], "private fixture base\n")
  await git(repo, ["update-ref", "HEAD", commit])
  await git(repo, ["read-tree", commit])
  await Bun.write(path.join(repo, "main.go"), 'package main\nfunc main() { println("current") }\n')
  await Bun.write(path.join(repo, "extra.go"), "package main\n// new source\n")
  await Bun.write(path.join(repo, "binary.bin"), "successor\0binary\u2603\n")
  await Bun.write(path.join(repo, "tool.sh"), "#!/bin/sh\n# successor\nexit 0\n")
  await rm(path.join(repo, "dead.go"))
  const record = async (relative: string) => {
    const bytes = await readFile(path.join(repo, relative))
    return {
      path: relative,
      bytes: bytes.length,
      sha256: hash(bytes),
      mode: (await lstat(path.join(repo, relative))).mode & 0o111 ? ("100755" as const) : ("100644" as const),
    }
  }
  const production = [
    ...(await Promise.all(["main.go", "extra.go", "binary.bin", "tool.sh"].map(record))),
    { path: "dead.go", deleted: true as const, baseSHA256: hash(original[2].bytes) },
  ]
  const compiler = path.join(canonical.trim(), "compiler.json")
  await Bun.write(
    compiler,
    JSON.stringify(
      production.flatMap((entry) =>
        "deleted" in entry ? [] : [{ path: path.join(repo, entry.path), bytes: entry.bytes, sha256: entry.sha256 }],
      ),
    ),
  )
  const config = {
    version: 1,
    purpose: "approved-production-source-closure",
    repositories: [
      {
        id: "kernel",
        root: repo,
        origin: "https://github.com/deepagent-ltd/fixture-source",
        baseCommit: commit,
        headCommit: commit,
        production,
        licenses: ["LICENSE"],
        compilerManifests: [
          {
            path: compiler,
            bytes: (await readFile(compiler)).length,
            sha256: hash(await readFile(compiler)),
            entrypoint: "./launcher",
          },
        ],
      },
    ],
    pins: [] as {
      id: string
      root: string
      source: string
      revision: string
      files: { path: string; bytes: number; sha256: string }[]
    }[],
  }
  const manifest = path.join(canonical.trim(), "approved.json")
  const save = async () => {
    await Bun.write(manifest, JSON.stringify(config))
    await chmod(manifest, 0o600)
  }
  const recaptureCompiler = async (entries: { path: string; bytes: number; sha256: string }[]) => {
    await Bun.write(compiler, JSON.stringify(entries))
    config.repositories[0].compilerManifests[0].bytes = (await readFile(compiler)).length
    config.repositories[0].compilerManifests[0].sha256 = hash(await readFile(compiler))
    await save()
  }
  await save()
  return {
    root: canonical.trim(),
    repo,
    compiler,
    config,
    manifest,
    out: path.join(canonical.trim(), "output"),
    save,
    recaptureCompiler,
    record,
  }
}

test("curated test-source preserves tracked changes and exact fixture overlay", async () => {
  const f = await fixture()
  const tree = await git(
    f.repo,
    ["mktree"],
    `${await git(f.repo, ["ls-tree", "HEAD"])}\n100644 blob ${await git(f.repo, ["hash-object", "-w", "--stdin"], "export const expected = 1\n")}\tsource.test.ts\n`,
  )
  const commit = await git(
    f.repo,
    ["commit-tree", tree, "-p", f.config.repositories[0].baseCommit],
    "formal test baseline\n",
  )
  await git(f.repo, ["update-ref", "HEAD", commit])
  await git(f.repo, ["read-tree", commit])
  await Bun.write(path.join(f.repo, "source.test.ts"), "export const expected = 2\n")
  await Bun.write(path.join(f.repo, "test/fixture/golden.txt"), "small reproducible source input\n")
  const config = {
    ...f.config,
    repositories: [
      {
        ...f.config.repositories[0],
        baseCommit: commit,
        headCommit: commit,
        testSources: [
          { ...(await f.record("source.test.ts")), kind: "test-source" },
          { ...(await f.record("test/fixture/golden.txt")), kind: "test-fixture" },
        ],
      },
    ],
  }
  await Bun.write(f.manifest, JSON.stringify(config))
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out })
  expect(result.repositories[0].testSources).toHaveLength(2)
  expect(await Bun.file(path.join(f.out, "repositories/kernel/changes.patch")).text()).toContain(
    "export const expected = 2",
  )
  expect(await Bun.file(path.join(f.out, "repositories/kernel/overlay/test/fixture/golden.txt")).text()).toBe(
    "small reproducible source input\n",
  )
  expect(result.repositories[0].compilerInputs?.some((entry) => entry.path.includes("source.test.ts"))).toBe(false)
})

test("curated main fixtures materialize outside test directories without widening production or private-state access", async () => {
  const f = await fixture()
  const filename = "packages/desktop/src/main/fixture/entry.ts"
  const content = "export const fixture = 'actual main entry'\n"
  await Bun.write(path.join(f.repo, filename), content)
  const save = async (file: string, kind: string) => Bun.write(f.manifest, JSON.stringify({
    ...f.config,
    repositories: [{ ...f.config.repositories[0], testSources: [{ ...(await f.record(file)), kind }] }],
  }))
  await save(filename, "test-fixture")
  const exported = await exportSourceClosure({ manifest: f.manifest, out: f.out })
  expect(exported.repositories[0].compilerInputs?.some((entry) => entry.path.includes("/fixture/"))).toBe(false)
  const restored = path.join(f.root, "main-fixture-restored")
  await materializeSourceClosure({ manifest: path.join(f.out, "manifest.json"), out: restored, roots: { kernel: f.repo } })
  expect(await Bun.file(path.join(restored, "kernel", filename)).text()).toBe(content)
  await save(filename, "test-source")
  await expect(exportSourceClosure({ manifest: f.manifest, out: path.join(f.root, "wrong-kind"), dry: true }))
    .rejects.toThrow("PRIVATE_OR_VALIDATION_PATH")
  await Bun.write(path.join(f.repo, "ordinary.ts"), "export const ordinary = true\n")
  await save("ordinary.ts", "test-fixture")
  await expect(exportSourceClosure({ manifest: f.manifest, out: path.join(f.root, "wrong-path"), dry: true }))
    .rejects.toThrow("TEST_SOURCE_PATH")
  const privateFile = "packages/desktop/src/main/fixture/auth.json"
  await Bun.write(path.join(f.repo, privateFile), "{}")
  await save(privateFile, "test-fixture")
  await expect(exportSourceClosure({ manifest: f.manifest, out: path.join(f.root, "private-state"), dry: true }))
    .rejects.toThrow("PRIVATE_STATE_PATH")
  const bytes = await Bun.file(path.join(f.repo, filename)).arrayBuffer()
  await f.recaptureCompiler([{ path: path.join(f.repo, filename), bytes: bytes.byteLength, sha256: hash(new Uint8Array(bytes)) }])
  await save(filename, "test-fixture")
  await expect(exportSourceClosure({ manifest: f.manifest, out: path.join(f.root, "compiler-fixture"), dry: true }))
    .rejects.toThrow("PRIVATE_OR_VALIDATION_PATH")
})

test("curated test-source keeps compiler and private-state boundaries", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.repo, "test/fixture/auth.json"), "{}")
  const save = async (file: string, kind: string) =>
    Bun.write(
      f.manifest,
      JSON.stringify({
        ...f.config,
        repositories: [{ ...f.config.repositories[0], testSources: [{ ...(await f.record(file)), kind }] }],
      }),
    )
  await save("test/fixture/auth.json", "test-fixture")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow(
    "PRIVATE_STATE_PATH",
  )
  await Bun.write(path.join(f.repo, "test/fixture/golden.txt"), "approved small input\n")
  await save("test/fixture/golden.txt", "test-source")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow(
    "PRIVATE_OR_VALIDATION_PATH",
  )
  await Bun.write(path.join(f.repo, "new.test.ts"), "export const test = true\n")
  await save("new.test.ts", "test-source")
  const bytes = await Bun.file(path.join(f.repo, "new.test.ts")).arrayBuffer()
  await f.recaptureCompiler([
    { path: path.join(f.repo, "new.test.ts"), bytes: bytes.byteLength, sha256: hash(new Uint8Array(bytes)) },
  ])
  await save("new.test.ts", "test-source")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow(
    "COMPILER_VALIDATION_INPUT",
  )
})

test("curated test-source refuses undeclared bytes and cross-category duplicate", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.repo, "new.test.ts"), "export const test = true\n")
  const testSources = [{ ...(await f.record("new.test.ts")), kind: "test-source" }]
  await Bun.write(
    f.manifest,
    JSON.stringify({ ...f.config, repositories: [{ ...f.config.repositories[0], testSources }] }),
  )
  await Bun.write(path.join(f.repo, "new.test.ts"), "export const test = false\n")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow("SOURCE_DRIFT")
  await Bun.write(
    f.manifest,
    JSON.stringify({
      ...f.config,
      repositories: [
        { ...f.config.repositories[0], testSources: [{ ...(await f.record("main.go")), kind: "test-source" }] },
      ],
    }),
  )
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow("DUPLICATE_PATH")
})

test("curated test-source supports exact Go tests and functional test configurations", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.repo, "native_test.go"), "package main\n// formal Go test source\n")
  await Bun.write(path.join(f.repo, "tsconfig.browser-product.json"), '{"compilerOptions":{"noEmit":true}}')
  const testSources = await Promise.all(
    ["native_test.go", "tsconfig.browser-product.json"].map(async (name) => ({
      ...(await f.record(name)),
      kind: "test-source",
    })),
  )
  await Bun.write(
    f.manifest,
    JSON.stringify({ ...f.config, repositories: [{ ...f.config.repositories[0], testSources }] }),
  )
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })
  expect(result.repositories[0].testSources).toHaveLength(2)
  expect(result.repositories[0].overlay).toContain("native_test.go")
})

test("source materialization reconstructs the real pinned baseline and curated changes", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.repo, "formal.test.ts"), "export const formal = true\n")
  await Bun.write(
    f.manifest,
    JSON.stringify({
      ...f.config,
      repositories: [
        { ...f.config.repositories[0], testSources: [{ ...(await f.record("formal.test.ts")), kind: "test-source" }] },
      ],
    }),
  )
  await exportSourceClosure({ manifest: f.manifest, out: f.out })
  const out = path.join(f.root, "materialized")
  const result = await materializeSourceClosure({
    manifest: path.join(f.out, "manifest.json"),
    out,
    roots: { kernel: f.repo },
    require: ["kernel"],
  })
  expect(result).toHaveProperty("materialized", true)
  expect(await Bun.file(path.join(out, "kernel/main.go")).text()).toContain('println("current")')
  expect(await Bun.file(path.join(out, "kernel/formal.test.ts")).text()).toBe("export const formal = true\n")
  expect(await Bun.file(path.join(out, "kernel/dead.go")).exists()).toBe(false)
  expect(await Bun.file(path.join(out, "kernel/LICENSE")).text()).toContain("Apache License")
})

test("source materialization rejects digest drift and preserves an existing output", async () => {
  const f = await fixture()
  await exportSourceClosure({ manifest: f.manifest, out: f.out })
  const out = path.join(f.root, "materialized")
  await mkdir(out)
  await Bun.write(path.join(out, "keep.txt"), "unchanged")
  await expect(
    materializeSourceClosure({ manifest: path.join(f.out, "manifest.json"), out, roots: { kernel: f.repo } }),
  ).rejects.toThrow("OUTPUT_EXISTS")
  expect(await Bun.file(path.join(out, "keep.txt")).text()).toBe("unchanged")
  await Bun.write(path.join(f.out, "repositories/kernel/changes.patch"), "tampered")
  await expect(
    materializeSourceClosure({
      manifest: path.join(f.out, "manifest.json"),
      out: path.join(f.root, "fresh"),
      roots: { kernel: f.repo },
    }),
  ).rejects.toThrow("SOURCE_DIGEST_MISMATCH")
  expect(await Bun.file(path.join(f.root, "fresh")).exists()).toBe(false)
})

test("dry reads pinned actual source without writing output or the source Git index", async () => {
  const f = await fixture()
  const index = hash(await readFile(path.join(f.repo, ".git/index")))
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })
  expect(result.dry).toBe(true)
  expect(result.written).toBe(false)
  expect(result.productionReleaseQualified).toBe(false)
  expect(result.repositories[0].compilerInputs?.length).toBe(4)
  expect(await Bun.file(path.join(f.out, "manifest.json")).exists()).toBe(false)
  expect(hash(await readFile(path.join(f.repo, ".git/index")))).toBe(index)
})

test("real tracked binary patch/delete/executable and untracked overlay reconstruct approved bytes", async () => {
  const f = await fixture()
  const index = hash(await readFile(path.join(f.repo, ".git/index")))
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out })
  expect(result.written).toBe(true)
  expect((await lstat(f.out)).mode & 0o777).toBe(0o700)
  const patch = await Bun.file(path.join(f.out, "repositories/kernel/changes.patch")).text()
  expect(patch).toContain("GIT binary patch")
  expect(patch).toContain("deleted file mode")
  expect(await readFile(path.join(f.out, "repositories/kernel/overlay/extra.go"))).toEqual(
    await readFile(path.join(f.repo, "extra.go")),
  )
  expect(await readFile(path.join(f.out, "licenses/kernel/LICENSE"))).toEqual(
    await readFile(path.join(f.repo, "LICENSE")),
  )
  for (const entry of result.artifacts) expect((await lstat(path.join(f.out, entry.path))).mode & 0o777).toBe(0o600)
  expect((await Bun.file(path.join(f.out, "manifest.json")).text()).includes(f.root)).toBe(false)
  expect(await Bun.file(path.join(f.out, ".verify")).exists()).toBe(false)
  expect(hash(await readFile(path.join(f.repo, ".git/index")))).toBe(index)
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("OUTPUT_EXISTS")
})

test("changed compiler input missing from explicit production whitelist is rejected", async () => {
  const f = await fixture()
  f.config.repositories[0].production = f.config.repositories[0].production.filter((entry) => entry.path !== "extra.go")
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow(
    "PRODUCTION_WHITELIST_INCOMPLETE",
  )
  expect(await Bun.file(path.join(f.out, "manifest.json")).exists()).toBe(false)
})

test("drift and secret/validation paths cannot be exported from the approved whitelist", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.repo, "main.go"), "late source\n")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("SOURCE_DRIFT")
  f.config.repositories[0].production[0] = { ...(await f.record("main.go")), path: ".env" }
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("PRIVATE_STATE_PATH")
  f.config.repositories[0].production[0].path = "validation/private.json"
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("PRIVATE_OR_VALIDATION_PATH")
})

test("actual compiler fixture is not silently qualified as production", async () => {
  const f = await fixture()
  await mkdir(path.join(f.repo, "testdata"))
  await Bun.write(path.join(f.repo, "testdata/fixture.go"), "package main\n")
  await f.recaptureCompiler([
    { path: path.join(f.repo, "testdata/fixture.go"), bytes: 13, sha256: hash("package main\n") },
  ])
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("PRIVATE_OR_VALIDATION_PATH")
})

test("unowned compiler input needs a full explicit public dependency pin", async () => {
  const f = await fixture()
  const dependency = path.join(f.root, "toolchain")
  await mkdir(dependency)
  await Bun.write(path.join(dependency, "runtime.go"), "package runtime\n")
  const entries = JSON.parse(await Bun.file(f.compiler).text()) as { path: string; bytes: number; sha256: string }[]
  entries.push({ path: path.join(dependency, "runtime.go"), bytes: 16, sha256: hash("package runtime\n") })
  await f.recaptureCompiler(entries)
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow(
    "UNPINNED_COMPILER_INPUT",
  )
  f.config.pins.push({
    id: "go",
    root: dependency,
    source: "https://go.dev/dl/",
    revision: "fixture-1",
    files: [{ path: "runtime.go", bytes: 16, sha256: hash("package runtime\n") }],
  })
  await f.save()
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })
  expect(result.pins[0].files[0].sha256).toBe(hash("package runtime\n"))
  expect(result.repositories[0].compilerInputs?.some((entry) => entry.path === "go/runtime.go")).toBe(true)
})

test("Bun node_modules dependency is explicitly pinned without hiding owned src changes", async () => {
  const f = await fixture()
  const dependency = path.join(f.repo, "node_modules", "vendor")
  await mkdir(dependency, { recursive: true })
  await Bun.write(path.join(dependency, "index.js"), "export const value = 1\n")
  const entries = JSON.parse(await Bun.file(f.compiler).text()) as { path: string; bytes: number; sha256: string }[]
  entries.push({ path: path.join(dependency, "index.js"), bytes: 23, sha256: hash("export const value = 1\n") })
  await f.recaptureCompiler(entries)
  f.config.pins.push({
    id: "npm",
    root: dependency,
    source: "https://registry.npmjs.org/vendor",
    revision: "fixture-1",
    files: [{ path: "index.js", bytes: 23, sha256: hash("export const value = 1\n") }],
  })
  await f.save()
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })
  expect(result.repositories[0].compilerInputs?.some((entry) => entry.path === "npm/index.js")).toBe(true)
  f.config.pins[0].root = f.repo
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow(
    "OVERLAPPING_ROOTS",
  )
})

test("unknown base and credential-bearing or untrusted origins reject without network", async () => {
  const f = await fixture()
  f.config.repositories[0].baseCommit = "0".repeat(40)
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("GIT_COMMAND_FAILED")
  f.config.repositories[0].baseCommit = f.config.repositories[0].headCommit
  f.config.repositories[0].origin = "https://user:secret@github.com/org/repo"
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("ORIGIN_NOT_PUBLIC")
  f.config.repositories[0].origin = "https://unknown.example/org/repo"
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("ORIGIN_NOT_TRUSTED")
})

test("source symlink and traversal reject; preexisting output is preserved", async () => {
  const f = await fixture()
  await rm(path.join(f.repo, "extra.go"))
  await symlink("main.go", path.join(f.repo, "extra.go"))
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("SOURCE_ALIAS")
  f.config.repositories[0].production[0].path = "../outside.go"
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("UNSAFE_PATH")
  await mkdir(f.out)
  await Bun.write(path.join(f.out, "foreign"), "keep")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("OUTPUT_EXISTS")
  expect(await Bun.file(path.join(f.out, "foreign")).text()).toBe("keep")
})

test("changed license outside whitelist and strict schema ambiguity reject", async () => {
  const f = await fixture()
  await Bun.write(path.join(f.repo, "LICENSE"), "changed license\n")
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow(
    "LICENSE_WHITELIST_INCOMPLETE",
  )
  await Bun.write(f.manifest, JSON.stringify({ ...f.config, unexpected: "not approved" }))
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("MANIFEST_SCHEMA")
})

test("late source replacement after output creation rejects and removes only owned output", async () => {
  const f = await fixture()
  const changed = { value: false }
  const watcher = watch(f.root, (_, filename) => {
    if (filename !== "output" || changed.value) return
    changed.value = true
    writeFileSync(path.join(f.repo, "main.go"), "package main\n// replacement after capture\n")
  })
  try {
    await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("LATE_SOURCE_DRIFT")
    expect(changed.value).toBe(true)
    expect(await Bun.file(path.join(f.out, "manifest.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(f.repo, "main.go")).text()).toContain("replacement after capture")
  } finally {
    watcher.close()
  }
})

test("single-file hard limit rejects before reading an oversized source", async () => {
  const f = await fixture()
  const file = await Bun.file(path.join(f.repo, "extra.go")).writer()
  file.write(new Uint8Array(SourceClosureBounds.fileBytes + 1))
  await file.end()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out })).rejects.toThrow("FILE_BYTES")
})

test("pinned credentials implementation source is allowed while credential data remains excluded", async () => {
  const f = await fixture()
  const dependency = path.join(f.root, "auth-library")
  await mkdir(dependency)
  await Bun.write(path.join(dependency, "credentials.go"), "package credentials\n")
  const entries = JSON.parse(await Bun.file(f.compiler).text()) as { path: string; bytes: number; sha256: string }[]
  entries.push({ path: path.join(dependency, "credentials.go"), bytes: 20, sha256: hash("package credentials\n") })
  await f.recaptureCompiler(entries)
  f.config.pins.push({
    id: "auth",
    root: dependency,
    source: "https://proxy.golang.org/example.com/auth",
    revision: "v1.0.0",
    files: [{ path: "credentials.go", bytes: 20, sha256: hash("package credentials\n") }],
  })
  await f.save()
  const result = await exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })
  expect(result.repositories[0].compilerInputs?.some((entry) => entry.path === "auth/credentials.go")).toBe(true)
  await Bun.write(path.join(dependency, "credentials.json"), "{}")
  f.config.pins[0].files.push({ path: "credentials.json", bytes: 2, sha256: hash("{}") })
  await f.save()
  await expect(exportSourceClosure({ manifest: f.manifest, out: f.out, dry: true })).rejects.toThrow(
    "PRIVATE_STATE_PATH",
  )
})
