#!/usr/bin/env bun

import path from "node:path"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Ajv } from "ajv"

type SourceRecord = { path: string; bytes: number; sha256: string }
type Entry = SourceRecord & { mode: "100644" | "100755" }
type Removed = { path: string; deleted: true; baseSHA256: string }
type TestSource = (Entry | Removed) & { kind: "test-source" | "test-fixture" }
type Input = {
  version: 1
  purpose: "approved-production-source-closure"
  repositories: {
    id: string
    root: string
    origin: string
    baseCommit: string
    headCommit: string
    production: (Entry | Removed)[]
    testSources?: TestSource[]
    licenses: string[]
    compilerManifests: (SourceRecord & { entrypoint: string })[]
  }[]
  pins: { id: string; root: string; source: string; revision: string; files: SourceRecord[] }[]
}

const shaSchema = { type: "string", pattern: "^[a-f0-9]{64}$" }
const idSchema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" }
const stringSchema = { type: "string", minLength: 1 }
const recordProperties = {
  path: stringSchema,
  bytes: { type: "integer", minimum: 0, maximum: 32 * 1024 * 1024 },
  sha256: shaSchema,
}
const recordSchema = {
  type: "object",
  properties: recordProperties,
  required: ["path", "bytes", "sha256"],
  additionalProperties: false,
}
const compilerValidator = new Ajv().compile<SourceRecord[]>({
  type: "array",
  minItems: 1,
  maxItems: 100000,
  items: recordSchema,
})
const manifestValidator = new Ajv().compile<Input>({
  type: "object",
  properties: {
    version: { const: 1 },
    purpose: { const: "approved-production-source-closure" },
    repositories: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: idSchema,
          root: stringSchema,
          origin: stringSchema,
          baseCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          headCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          production: {
            type: "array",
            minItems: 1,
            maxItems: 10000,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: { ...recordProperties, mode: { enum: ["100644", "100755"] } },
                  required: ["path", "bytes", "sha256", "mode"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: { path: stringSchema, deleted: { const: true }, baseSHA256: shaSchema },
                  required: ["path", "deleted", "baseSHA256"],
                },
              ],
            },
          },
          licenses: { type: "array", minItems: 1, maxItems: 64, items: stringSchema },
          testSources: {
            type: "array",
            maxItems: 10000,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ...recordProperties,
                    mode: { enum: ["100644", "100755"] },
                    kind: { enum: ["test-source", "test-fixture"] },
                  },
                  required: ["path", "bytes", "sha256", "mode", "kind"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    path: stringSchema,
                    deleted: { const: true },
                    baseSHA256: shaSchema,
                    kind: { enum: ["test-source", "test-fixture"] },
                  },
                  required: ["path", "deleted", "baseSHA256", "kind"],
                },
              ],
            },
          },
          compilerManifests: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { ...recordProperties, entrypoint: { type: "string", minLength: 1, maxLength: 200 } },
              required: ["path", "bytes", "sha256", "entrypoint"],
            },
          },
        },
        required: ["id", "root", "origin", "baseCommit", "headCommit", "production", "licenses", "compilerManifests"],
      },
    },
    pins: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: idSchema,
          root: stringSchema,
          source: stringSchema,
          revision: { type: "string", minLength: 1, maxLength: 200 },
          files: { type: "array", minItems: 1, maxItems: 100000, items: recordSchema },
        },
        required: ["id", "root", "source", "revision", "files"],
      },
    },
  },
  required: ["version", "purpose", "repositories", "pins"],
  additionalProperties: false,
})

type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number; nlink: number }

export const SourceClosureBounds = {
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  gitBytes: 32 * 1024 * 1024,
  gitTimeoutMs: 15000,
  totalTimeoutMs: 120000,
}

/** Exports declared source only. It never publishes, fetches, changes a Git index, or qualifies a release. */
export async function exportSourceClosure(input: { manifest: string; out: string; dry?: boolean }) {
  const deadline = performance.now() + SourceClosureBounds.totalTimeoutMs
  const remaining = () => {
    if (performance.now() >= deadline) fail("EXPORT_DEADLINE")
    return Math.min(SourceClosureBounds.gitTimeoutMs, deadline - performance.now())
  }
  const git = await realpath(Bun.which("git") ?? fail("GIT_UNAVAILABLE"))
  const tool = await readFile(git, false)
  const manifest = await readFile(path.resolve(input.manifest), false)
  const config = parseJSON(manifest.bytes)
  if (!manifestValidator(config)) fail("MANIFEST_SCHEMA")
  const out = path.resolve(input.out)
  const roots = (
    await Promise.all(
      [...config.repositories, ...config.pins].map(async (entry) => {
        if (!path.isAbsolute(entry.root)) fail("ROOT_NOT_ABSOLUTE")
        return { id: entry.id, root: await realpath(entry.root) }
      }),
    )
  ).sort((a, b) => b.root.length - a.root.length)
  if (new Set(roots.map((entry) => entry.id)).size !== roots.length) fail("DUPLICATE_ID")
  for (const root of roots) {
    for (const child of roots.filter((entry) => entry.id !== root.id && inside(root.root, entry.root))) {
      // Bun dependencies can physically live under the repository. Only explicitly pinned
      // node_modules roots may override that ownership; a pin cannot hide changed src files.
      if (
        !config.repositories.some((entry) => entry.id === root.id) ||
        !config.pins.some((entry) => entry.id === child.id) ||
        !inside(path.join(root.root, "node_modules"), child.root)
      )
        fail("OVERLAPPING_ROOTS")
    }
  }
  if (roots.some((entry) => inside(entry.root, out))) fail("OUTPUT_IN_SOURCE")
  if (
    await lstat(out).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    )
  )
    fail("OUTPUT_EXISTS")
  const current = new Map<string, { sha256: string; stamp: Stamp }>()
  const buffers = new Map<string, Buffer>()
  const files = new Map<string, { bytes: Buffer; mode: "100644" | "100755" }>()
  const compiler = new Map<string, SourceRecord[]>()
  const bases = new Map<string, Map<string, { mode: string; object: string }>>()
  const indexes = new Map<string, string | undefined>()
  const byteBudget = { value: manifest.bytes.length + tool.bytes.length }
  const testPaths = new Set<string>()
  const command = (root: string, args: string[], limit = SourceClosureBounds.gitBytes) =>
    runGit(git, root, args, limit, remaining())
  const capture = async (filename: string, expected?: SourceRecord) => {
    remaining()
    const before = current.get(filename)
    if (before) {
      if (expected && (before.sha256 !== expected.sha256 || before.stamp.size !== expected.bytes))
        fail("CONFLICTING_INPUT")
      return buffers.get(filename)!
    }
    const result = await readFile(filename)
    if (expected && (result.sha256 !== expected.sha256 || result.bytes.length !== expected.bytes)) fail("SOURCE_DRIFT")
    byteBudget.value += result.bytes.length
    if (byteBudget.value > SourceClosureBounds.totalBytes) fail("TOTAL_BYTES")
    current.set(filename, { sha256: result.sha256, stamp: result.stamp })
    if (current.size > 100000) fail("SOURCE_INPUT_COUNT")
    buffers.set(filename, result.bytes)
    return result.bytes
  }
  for (const pin of config.pins) {
    publicURL(pin.source, false)
    const root = roots.find((entry) => entry.id === pin.id)!.root
    unique(pin.files.map((entry) => entry.path))
    for (const entry of pin.files) await capture(await sourcePath(root, entry.path), entry)
  }
  for (const repo of config.repositories) {
    publicURL(repo.origin, true)
    const root = roots.find((entry) => entry.id === repo.id)!.root
    const declared = [...repo.production, ...(repo.testSources ?? [])]
    unique(declared.map((entry) => entry.path))
    unique(repo.licenses)
    repo.production.forEach((entry) => relativePath(entry.path, true))
    for (const entry of repo.testSources ?? []) {
      relativePath(entry.path, false, entry.kind === "test-fixture")
      if (
        !/(^|\/)(test|tests|__tests__|e2e)(\/|$)|\.(test|spec)\.[^/]+$|_test\.go$|(?:playwright[^/]*\.config\.[^/]+|tsconfig\.(?:browser|im-media)[^/]*\.json)$/.test(
          entry.path,
        ) && !(entry.kind === "test-fixture" && /(^|\/)(testdata|fixtures?|__snapshots__)(\/|$)/.test(entry.path))
      )
        fail("TEST_SOURCE_PATH")
      if (entry.kind === "test-fixture" && !/(^|\/)(testdata|fixtures?|__snapshots__)(\/|$)/.test(entry.path))
        fail("TEST_FIXTURE_PATH")
      testPaths.add(path.join(root, entry.path))
    }
    if ((await command(root, ["rev-parse", "HEAD"])).toString().trim() !== repo.headCommit) fail("HEAD_DRIFT")
    if ((await command(root, ["rev-parse", `${repo.baseCommit}^{commit}`])).toString().trim() !== repo.baseCommit)
      fail("BASE_UNAVAILABLE")
    await command(root, ["merge-base", "--is-ancestor", repo.baseCommit, repo.headCommit])
    const origin = (await command(root, ["remote", "get-url", "origin"])).toString().trim()
    if (normalizeOrigin(origin) !== normalizeOrigin(repo.origin)) fail("ORIGIN_MISMATCH")
    const base = parseTree(await command(root, ["ls-tree", "-rz", repo.baseCommit]))
    bases.set(repo.id, base)
    const index = (await command(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]))
      .toString()
      .trim()
    indexes.set(
      index,
      await readFile(index, false).then(
        (entry) => entry.sha256,
        (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)),
      ),
    )
    const licenseNames = [...base.keys()].filter(
      (name) => !name.includes("/") && /^(LICENSE|LICENCE|NOTICE|COPYING)(\..*)?$/i.test(name),
    )
    if (!licenseNames.length || licenseNames.some((name) => !repo.licenses.includes(name))) fail("LICENSE_INCOMPLETE")
    for (const entry of declared) {
      const filename = await sourcePath(
        root,
        entry.path,
        "deleted" in entry,
        "kind" in entry && entry.kind === "test-fixture",
      )
      const original = base.get(entry.path)
      if (original && !["100644", "100755"].includes(original.mode)) fail("BASE_NOT_REGULAR")
      if ("deleted" in entry) {
        if (!original || hash(await command(root, ["cat-file", "blob", original.object])) !== entry.baseSHA256)
          fail("DELETION_BASE")
        if (
          await lstat(filename).then(
            () => true,
            (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
          )
        )
          fail("DELETION_DRIFT")
        continue
      }
      const bytes = await capture(filename, entry)
      if ((current.get(filename)!.stamp.mode & 0o111 ? "100755" : "100644") !== entry.mode) fail("FILE_MODE_DRIFT")
      files.set(`${repo.id}/${entry.path}`, { bytes, mode: entry.mode })
    }
    for (const name of repo.licenses) {
      relativePath(name, true)
      const bytes = await capture(await sourcePath(root, name))
      const original = base.get(name)
      if (
        (!original || hash(await command(root, ["cat-file", "blob", original.object])) !== hash(bytes)) &&
        !repo.production.some((entry) => entry.path === name && !("deleted" in entry))
      )
        fail("LICENSE_WHITELIST_INCOMPLETE")
      files.set(`${repo.id}/${name}`, { bytes, mode: "100644" })
    }
    const entries = new Map<string, SourceRecord>()
    for (const source of repo.compilerManifests) {
      if (
        !/^[A-Za-z0-9_./@:+=-]+(?: [A-Za-z0-9_./@:+=-]+)*$/.test(source.entrypoint) ||
        /(^|[ /])(validation|testdata|fixtures?|test|tests)([ /]|$)/i.test(source.entrypoint) ||
        source.entrypoint.startsWith("/")
      )
        fail("COMPILER_VALIDATION_ENTRYPOINT")
      const json = await capture(path.resolve(source.path), source)
      const parsed = parseJSON(json)
      if (!compilerValidator(parsed)) fail("COMPILER_MANIFEST_SCHEMA")
      for (const entry of parsed) {
        if (!path.isAbsolute(entry.path) || entry.path !== path.resolve(entry.path)) fail("COMPILER_PATH")
        const owner = roots.find((item) => inside(item.root, entry.path))
        if (!owner) fail("UNPINNED_COMPILER_INPUT")
        const relative = path.relative(owner.root, entry.path).split(path.sep).join("/")
        relativePath(
          relative,
          config.repositories.some((item) => item.id === owner.id),
        )
        const key = `${owner.id}/${relative}`
        const prior = entries.get(key)
        if (prior && (prior.sha256 !== entry.sha256 || prior.bytes !== entry.bytes)) fail("CONFLICTING_INPUT")
        entries.set(key, { ...entry, path: key })
        if (entries.size > 100000) fail("COMPILER_INPUT_COUNT")
        const filename = await sourcePath(owner.root, relative)
        await capture(filename, entry)
        const ownRepo = config.repositories.find((item) => item.id === owner.id)
        if (!ownRepo) {
          const pin = config.pins.find((item) => item.id === owner.id)!
          if (
            !pin.files.some(
              (item) => item.path === relative && item.sha256 === entry.sha256 && item.bytes === entry.bytes,
            )
          )
            fail("PIN_INCOMPLETE")
          continue
        }
        const tree = bases.get(owner.id) ?? parseTree(await command(owner.root, ["ls-tree", "-rz", ownRepo.baseCommit]))
        const original = tree.get(relative)
        const sameBase =
          original &&
          original.mode === (current.get(filename)!.stamp.mode & 0o111 ? "100755" : "100644") &&
          hash(await command(owner.root, ["cat-file", "blob", original.object])) === entry.sha256
        if (
          !sameBase &&
          !ownRepo.production.some(
            (item) =>
              item.path === relative &&
              !("deleted" in item) &&
              item.sha256 === entry.sha256 &&
              item.bytes === entry.bytes,
          )
        )
          fail("PRODUCTION_WHITELIST_INCOMPLETE")
      }
    }
    compiler.set(
      repo.id,
      [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    )
  }
  const artifacts = new Map<string, Buffer>()
  const repositories = []
  for (const repo of config.repositories) {
    const root = roots.find((entry) => entry.id === repo.id)!.root
    const base = bases.get(repo.id)!
    const declared = [...repo.production, ...(repo.testSources ?? [])]
    const tracked = declared.filter((entry) => base.has(entry.path)).map((entry) => entry.path)
    const patch = tracked.length
      ? await command(root, [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          repo.baseCommit,
          "--",
          ...tracked,
        ])
      : Buffer.alloc(0)
    // No index is used: verification materializes only whitelisted base files in our own output.
    artifacts.set(`repositories/${repo.id}/changes.patch`, patch)
    const overlay = declared.filter(
      (entry): entry is Entry | (Entry & { kind: TestSource["kind"] }) =>
        !("deleted" in entry) && !base.has(entry.path),
    )
    overlay.forEach((entry) =>
      artifacts.set(`repositories/${repo.id}/overlay/${entry.path}`, files.get(`${repo.id}/${entry.path}`)!.bytes),
    )
    repo.licenses.forEach((name) =>
      artifacts.set(`licenses/${repo.id}/${name}`, files.get(`${repo.id}/${name}`)!.bytes),
    )
    repositories.push({
      id: repo.id,
      origin: repo.origin,
      baseCommit: repo.baseCommit,
      headCommit: repo.headCommit,
      production: repo.production,
      testSources: repo.testSources ?? [],
      licenses: repo.licenses.map((name) => ({
        path: name,
        bytes: files.get(`${repo.id}/${name}`)!.bytes.length,
        sha256: hash(files.get(`${repo.id}/${name}`)!.bytes),
      })),
      patch: `repositories/${repo.id}/changes.patch`,
      overlay: overlay.map((entry) => entry.path),
      entrypoints: repo.compilerManifests.map((entry) => ({
        entrypoint: entry.entrypoint,
        bytes: entry.bytes,
        sha256: entry.sha256,
      })),
      compilerInputs: compiler.get(repo.id),
    })
  }
  const result = {
    version: 1,
    scope: "declared-production-source-closure",
    productionReleaseQualified: false,
    inputSHA256: manifest.sha256,
    git: { bytes: tool.bytes.length, sha256: tool.sha256 },
    repositories,
    pins: config.pins.map((pin) => ({ id: pin.id, source: pin.source, revision: pin.revision, files: pin.files })),
    applyOrder: [
      "Fetch each public origin independently and checkout exact baseCommit; this exporter performs no network verification.",
      "Apply changes.patch with git apply --binary. Copy listed overlay files without replacing unrelated paths; restore declared 100644/100755 modes.",
      "Verify all declared production and compiler input sizes/SHA256, deletions, licenses and pinned dependency inputs before building.",
      "Use the declared entrypoint census only. This is not a build, installation, platform, signing, or release qualification.",
    ],
    artifacts: [...artifacts].map(([name, bytes]) => ({
      path: name,
      bytes: bytes.length,
      sha256: hash(bytes),
      mode: "0600",
    })),
    limits: [
      "Approved bytes are trusted source content; filename checks do not detect secrets embedded in approved code.",
      "No remote public availability is verified; origin/base availability must be verified by the eventual build.",
      "Held-file read checks and repeated current checks do not provide an adversarial cross-process atomic directory snapshot.",
    ],
  }
  if (
    [...artifacts.values()].reduce((sum, bytes) => sum + bytes.length, 0) + Buffer.byteLength(JSON.stringify(result)) >
    SourceClosureBounds.totalBytes
  )
    fail("OUTPUT_TOTAL_BYTES")
  const checkCurrent = async () => {
    remaining()
    if (
      (await readFile(git, false)).sha256 !== tool.sha256 ||
      (await readFile(path.resolve(input.manifest), false)).sha256 !== manifest.sha256
    )
      fail("CONTROL_SOURCE_DRIFT")
    for (const [filename, expected] of current) {
      remaining()
      const owner = roots.find((entry) => inside(entry.root, filename))
      if (owner)
        await sourcePath(
          owner.root,
          path.relative(owner.root, filename).split(path.sep).join("/"),
          false,
          testPaths.has(filename),
        )
      const actual = await readFile(filename)
      if (actual.sha256 !== expected.sha256 || !sameStamp(actual.stamp, expected.stamp)) fail("LATE_SOURCE_DRIFT")
    }
    for (const repo of config.repositories) {
      const root = roots.find((entry) => entry.id === repo.id)!.root
      if ((await command(root, ["rev-parse", "HEAD"])).toString().trim() !== repo.headCommit) fail("HEAD_DRIFT")
      for (const entry of [...repo.production, ...(repo.testSources ?? [])].filter(
        (item): item is Removed | (Removed & { kind: TestSource["kind"] }) => "deleted" in item,
      )) {
        if (
          await lstat(await sourcePath(root, entry.path, true, testPaths.has(path.join(root, entry.path)))).then(
            () => true,
            (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
          )
        )
          fail("DELETION_DRIFT")
      }
    }
    for (const [filename, expected] of indexes) {
      if (
        (await readFile(filename, false).then(
          (entry) => entry.sha256,
          (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)),
        )) !== expected
      )
        fail("GIT_INDEX_DRIFT")
    }
  }
  await checkCurrent()
  if (input.dry) return { ...result, dry: true, written: false }
  const parent = await realpath(path.dirname(out))
  if (path.join(parent, path.basename(out)) !== out) fail("OUTPUT_PARENT_ALIAS")
  await mkdir(out, { mode: 0o700 })
  await chmod(out, 0o700)
  const owned = await lstat(out)
  const completed = { value: false }
  try {
    for (const repo of config.repositories) {
      const stage = path.join(out, ".verify", repo.id)
      await mkdir(stage, { recursive: true, mode: 0o700 })
      for (const entry of [...repo.production, ...(repo.testSources ?? [])].filter((item) =>
        bases.get(repo.id)!.has(item.path),
      )) {
        const filename = path.join(stage, entry.path)
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
        await writeFile(
          filename,
          await command(roots.find((item) => item.id === repo.id)!.root, [
            "cat-file",
            "blob",
            bases.get(repo.id)!.get(entry.path)!.object,
          ]),
        )
        await chmod(filename, bases.get(repo.id)!.get(entry.path)!.mode === "100755" ? 0o755 : 0o644)
      }
      const patchFile = path.join(out, ".verify", `${repo.id}.patch`)
      await writeFile(patchFile, artifacts.get(`repositories/${repo.id}/changes.patch`)!)
      if (artifacts.get(`repositories/${repo.id}/changes.patch`)!.length)
        await command(stage, ["apply", "--no-index", "--binary", patchFile])
      for (const entry of [...repo.production, ...(repo.testSources ?? [])].filter((item) =>
        bases.get(repo.id)!.has(item.path),
      )) {
        const filename = path.join(stage, entry.path)
        if ("deleted" in entry) {
          if (
            await lstat(filename).then(
              () => true,
              (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
            )
          )
            fail("PATCH_DELETE_MISMATCH")
          continue
        }
        const applied = await readFile(filename)
        if (
          applied.sha256 !== entry.sha256 ||
          applied.bytes.length !== entry.bytes ||
          (applied.stamp.mode & 0o111 ? "100755" : "100644") !== entry.mode
        )
          fail("PATCH_MISMATCH")
      }
    }
    await rm(path.join(out, ".verify"), { recursive: true })
    for (const [name, bytes] of artifacts) {
      await mkdir(path.dirname(path.join(out, name)), { recursive: true, mode: 0o700 })
      await writeFile(path.join(out, name), bytes)
      if ((await readFile(path.join(out, name))).sha256 !== hash(bytes)) fail("OUTPUT_READBACK")
    }
    await checkCurrent()
    await writeFile(path.join(out, "manifest.json"), Buffer.from(JSON.stringify(result, null, 2) + "\n"))
    await checkCurrent()
    if (
      (await readFile(path.join(out, "manifest.json"))).sha256 !==
      hash(Buffer.from(JSON.stringify(result, null, 2) + "\n"))
    )
      fail("OUTPUT_READBACK")
    for (const [name, bytes] of artifacts) {
      const actual = await readFile(path.join(out, name))
      if (actual.sha256 !== hash(bytes) || (actual.stamp.mode & 0o777) !== 0o600) fail("OUTPUT_READBACK")
    }
    const named = await lstat(out)
    if (named.dev !== owned.dev || named.ino !== owned.ino || named.isSymbolicLink() || (named.mode & 0o777) !== 0o700)
      fail("OUTPUT_ROOT_CHANGED")
    completed.value = true
    return { ...result, dry: false, written: true }
  } finally {
    // Cleanup is limited to our new directory, and never replaces an existing output.
    const now = await lstat(out).catch(() => undefined)
    if (!completed.value && now?.dev === owned.dev && now.ino === owned.ino) await rm(out, { recursive: true })
  }
}

function fail(code: string): never {
  throw new Error(code)
}
function parseJSON(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes))
  } catch {
    return fail("INVALID_JSON")
  }
}
function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}
function inside(root: string, filename: string) {
  return filename === root || filename.startsWith(root + path.sep)
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail("DUPLICATE_PATH")
}
function sameStamp(a: Stamp, b: Stamp) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  )
}

function publicURL(value: string, repository: boolean) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash)
    fail("ORIGIN_NOT_PUBLIC")
  if (
    repository &&
    (url.hostname !== "github.com" || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname))
  )
    fail("ORIGIN_NOT_TRUSTED")
  if (
    !repository &&
    (url.hostname === "localhost" || /^[\d.:\[\]]+$/.test(url.hostname) || !url.hostname.includes("."))
  )
    fail("PIN_ORIGIN_NOT_PUBLIC")
}
function normalizeOrigin(value: string) {
  return value
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
}

function relativePath(value: string, production: boolean, fixture = false) {
  if (
    !value ||
    path.isAbsolute(value) ||
    /[\x00-\x1f\x7f\\:]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("UNSAFE_PATH")
  if (
    /(^|\/)(\.git|validation|evidence|__pycache__|\.codex|\.deepagent|node_modules)(\/|$)/i.test(value) ||
    (!fixture && /(^|\/)(testdata|fixtures?)(\/|$)/i.test(value))
  )
    fail("PRIVATE_OR_VALIDATION_PATH")
  if (production && (/(^|\/)(test|tests)(\/|$)/i.test(value) || /(?:\.test\.[^/]+|_test\.go)$/.test(value)))
    fail("COMPILER_VALIDATION_INPUT")
  if (
    /(^|\/)(?:\.env(?:\..*)?|signing\.env|auth\.json|credentials?(?:\.(?:json|ya?ml|toml|ini|txt|env))?|config-private[^/]*|[^/]*-private\.json)$|\.(?:sqlite3?|db|log|jsonl|key|pem|pfx|p12|pyc)$/i.test(
      value,
    )
  )
    fail("PRIVATE_STATE_PATH")
}

async function sourcePath(root: string, relative: string, missing = false, fixture = false) {
  relativePath(relative, false, fixture)
  const parent = await lstat(root)
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("SOURCE_ALIAS")
  const parts = relative.split("/")
  for (const [i] of parts.entries()) {
    const filename = path.join(root, ...parts.slice(0, i + 1))
    const stat = await lstat(filename).catch((error: NodeJS.ErrnoException) =>
      missing && error.code === "ENOENT" && i === parts.length - 1 ? undefined : Promise.reject(error),
    )
    if (!stat) return filename
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) fail("SOURCE_ALIAS")
  }
  return path.join(root, relative)
}

async function readFile(filename: string, singleLink = true) {
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (!before.isFile() || (singleLink && before.nlink !== 1)) fail("NOT_OWNED_REGULAR_FILE")
    if (before.size > SourceClosureBounds.fileBytes) fail("FILE_BYTES")
    const storage = Buffer.alloc(before.size + 1)
    const count = { value: 0 }
    while (count.value < storage.length) {
      const next = await fd.read(storage, count.value, storage.length - count.value, count.value)
      if (!next.bytesRead) break
      count.value += next.bytesRead
    }
    const bytes = storage.subarray(0, count.value)
    const after = await fd.stat()
    const named = await lstat(filename)
    if (bytes.length !== before.size || !sameStamp(before, after) || !sameStamp(after, named))
      fail("FILE_CHANGED_DURING_READ")
    return {
      bytes,
      sha256: hash(bytes),
      stamp: {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        mode: after.mode,
        nlink: after.nlink,
      },
    }
  } finally {
    await fd.close()
  }
}

async function writeFile(filename: string, bytes: Buffer) {
  const fd = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await fd.writeFile(bytes)
    await fd.sync()
  } finally {
    await fd.close()
  }
}

function parseTree(bytes: Buffer) {
  return new Map(
    bytes
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^([0-9]{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/.exec(line)
        if (!match) fail("BASE_TREE")
        return [match[4], { mode: match[1], object: match[3] }]
      }),
  )
}

async function runGit(git: string, cwd: string, args: string[], limit: number, timeoutMs: number) {
  const child = Bun.spawn(
    [
      git,
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.filemode=true",
      ...args,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_ATTR_NOSYSTEM: "1",
      },
    },
  )
  const deadline = { expired: false }
  const timeout = setTimeout(() => {
    deadline.expired = true
    child.kill("SIGKILL")
  }, timeoutMs)
  const read = async (stream: ReadableStream<Uint8Array>, maximum: number) => {
    const chunks: Buffer[] = []
    const size = { value: 0 }
    for await (const bytes of stream) {
      size.value += bytes.length
      if (size.value > maximum) {
        child.kill("SIGKILL")
        fail("GIT_OUTPUT_BYTES")
      }
      chunks.push(Buffer.from(bytes))
    }
    return Buffer.concat(chunks)
  }
  try {
    const results = await Promise.allSettled([read(child.stdout, limit), read(child.stderr, 1024 * 1024), child.exited])
    if (deadline.expired) fail("GIT_TIMEOUT")
    const failed = results.find((entry) => entry.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    if (results[2].status !== "fulfilled" || results[2].value !== 0) fail("GIT_COMMAND_FAILED")
    if (results[0].status !== "fulfilled") fail("GIT_COMMAND_FAILED")
    return results[0].value
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const options: { manifest?: string; out?: string; dry?: boolean } = {}
  const main = async () => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--dry" && options.dry === undefined) {
        options.dry = true
        continue
      }
      if (args[i] === "--manifest" && !options.manifest && args[i + 1] && !args[i + 1].startsWith("--")) {
        options.manifest = args[++i]
        continue
      }
      if (args[i] === "--out" && !options.out && args[i + 1] && !args[i + 1].startsWith("--")) {
        options.out = args[++i]
        continue
      }
      fail("CLI_ARGUMENTS")
    }
    if (!options.manifest || !options.out) fail("CLI_ARGUMENTS")
    const result = await exportSourceClosure({ manifest: options.manifest, out: options.out, dry: options.dry })
    process.stdout.write(
      JSON.stringify({
        scope: result.scope,
        productionReleaseQualified: false,
        repositories: result.repositories.length,
        dry: result.dry,
        written: result.written,
        inputSHA256: result.inputSHA256,
      }) + "\n",
    )
  }
  await main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        error: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "EXPORT_FAILED",
      }) + "\n",
    )
    process.exitCode = 1
  })
}
