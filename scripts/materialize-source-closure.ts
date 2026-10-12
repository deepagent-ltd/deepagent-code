#!/usr/bin/env bun

import path from "node:path"
import os from "node:os"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readlink, readdir, realpath, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Ajv } from "ajv"

type Record = { path: string; bytes: number; sha256: string }
type Entry = Record & { mode: "100644" | "100755" }
type Removed = { path: string; deleted: true; baseSHA256: string }
type Manifest = {
  version: 1
  scope: "declared-production-source-closure"
  repositories: {
    id: string
    origin: string
    baseCommit: string
    headCommit: string
    production: (Entry | Removed)[]
    testSources?: ((Entry | Removed) & { kind: "test-source" | "test-fixture" })[]
    licenses: Record[]
    patch: string
    overlay: string[]
    compilerInputs: Record[]
  }[]
  artifacts: (Record & { mode: "0600" })[]
}

const record = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    bytes: { type: "integer", minimum: 0, maximum: 33554432 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["path", "bytes", "sha256"],
}
const entry = {
  ...record,
  properties: {
    ...record.properties,
    mode: { enum: ["100644", "100755"] },
    kind: { enum: ["test-source", "test-fixture"] },
  },
  required: [...record.required, "mode"],
}
const removed = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    deleted: { const: true },
    baseSHA256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    kind: { enum: ["test-source", "test-fixture"] },
  },
  required: ["path", "deleted", "baseSHA256"],
}
const validate = new Ajv().compile<Manifest>({
  type: "object",
  properties: {
    version: { const: 1 },
    scope: { const: "declared-production-source-closure" },
    repositories: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
          origin: { type: "string", pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?$" },
          baseCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          headCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          production: { type: "array", minItems: 1, maxItems: 10000, items: { oneOf: [entry, removed] } },
          testSources: { type: "array", maxItems: 10000, items: { oneOf: [entry, removed] } },
          licenses: { type: "array", minItems: 1, maxItems: 64, items: record },
          patch: { type: "string" },
          overlay: { type: "array", maxItems: 20000, items: { type: "string" } },
          compilerInputs: { type: "array", maxItems: 100000, items: record },
        },
        required: [
          "id",
          "origin",
          "baseCommit",
          "headCommit",
          "production",
          "licenses",
          "patch",
          "overlay",
          "compilerInputs",
        ],
      },
    },
    artifacts: {
      type: "array",
      maxItems: 20000,
      items: {
        ...record,
        properties: { ...record.properties, mode: { const: "0600" } },
        required: [...record.required, "mode"],
      },
    },
  },
  required: ["version", "scope", "repositories", "artifacts"],
})

/** Reconstructs reviewed sources in a new directory. Source repositories and indices remain read-only. */
export async function materializeSourceClosure(input: {
  manifest: string
  out: string
  roots?: { [id: string]: string }
  check?: boolean
  require?: string[]
}) {
  const filename = await realpath(input.manifest)
  const closure = path.dirname(filename)
  const raw = await readOwned(filename)
  const manifest: unknown = JSON.parse(raw.toString("utf8"))
  if (!validate(manifest)) throw new Error("SOURCE_MANIFEST_SCHEMA")
  if (new Set(manifest.repositories.map((repo) => repo.id)).size !== manifest.repositories.length)
    throw new Error("DUPLICATE_REPOSITORY")
  if (input.require?.some((id) => !manifest.repositories.some((repo) => repo.id === id)))
    throw new Error("SOURCE_REPOSITORY_MISSING")
  const artifacts = new Map<string, Record>()
  for (const item of manifest.artifacts) {
    safePath(item.path)
    if (artifacts.has(item.path)) throw new Error("DUPLICATE_ARTIFACT")
    const bytes = await readOwned(await containedFile(closure, item.path))
    verify(bytes, item)
    artifacts.set(item.path, item)
  }
  for (const repo of manifest.repositories) {
    if (!artifacts.has(repo.patch) || repo.patch !== `repositories/${repo.id}/changes.patch`)
      throw new Error("PATCH_NOT_DECLARED")
    const declared = [...repo.production, ...(repo.testSources ?? [])]
    if (new Set(declared.map((item) => item.path)).size !== declared.length) throw new Error("DUPLICATE_SOURCE")
    for (const item of declared) safePath(item.path)
    for (const item of repo.overlay) {
      safePath(item)
      if (
        !declared.some((row) => row.path === item && !("deleted" in row)) ||
        !artifacts.has(`repositories/${repo.id}/overlay/${item}`)
      )
        throw new Error("OVERLAY_NOT_DECLARED")
    }
    for (const item of repo.licenses) safePath(item.path)
    if (input.roots?.[repo.id]) await verifySources(await realpath(input.roots[repo.id]), repo, true)
  }
  if (input.check)
    return {
      checked: true,
      manifestSHA256: hash(raw),
      repositories: manifest.repositories.map((repo) => ({
        id: repo.id,
        production: repo.production.length,
        testSources: repo.testSources?.length ?? 0,
      })),
      network: 0,
    }
  const out = path.resolve(input.out)
  if (
    await lstat(out).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    )
  )
    throw new Error("OUTPUT_EXISTS")
  if (
    manifest.repositories.some((repo) => input.roots?.[repo.id] && inside(path.resolve(input.roots[repo.id]), out)) ||
    inside(closure, out)
  )
    throw new Error("OUTPUT_IN_SOURCE")
  const parent = await realpath(path.dirname(out))
  if (path.join(parent, path.basename(out)) !== out) throw new Error("OUTPUT_PARENT_ALIAS")
  const scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), "dac-source-materialize-"))
  const completed = { value: false }
  await mkdir(out, { mode: 0o700 })
  const owned = await lstat(out)
  try {
    for (const repo of manifest.repositories) {
      const target = path.join(out, repo.id)
      await mkdir(target, { mode: 0o700 })
      const gitRoot = input.roots?.[repo.id] ? await realpath(input.roots[repo.id]) : path.join(scratch, repo.id)
      if (!input.roots?.[repo.id]) {
        await mkdir(gitRoot, { mode: 0o700 })
        await run(["git", "init", "--bare", "--quiet", gitRoot], scratch)
        await run(
          ["git", "-C", gitRoot, "fetch", "--quiet", "--depth=1", repo.origin, repo.baseCommit],
          scratch,
          180000,
        )
      }
      if (
        (await run(["git", "-C", gitRoot, "rev-parse", `${repo.baseCommit}^{commit}`], scratch)).trim() !==
        repo.baseCommit
      )
        throw new Error("BASE_UNAVAILABLE")
      const archive = path.join(scratch, `${repo.id}.tar`)
      await run(["git", "-C", gitRoot, "archive", "--format=tar", `--output=${archive}`, repo.baseCommit], scratch)
      await run(["tar", "-xf", archive, "-C", target], scratch)
      await validateTree(target, target)
      if (artifacts.get(repo.patch)!.bytes)
        await run(["git", "apply", "--no-index", "--binary", path.join(closure, repo.patch)], target)
      for (const item of repo.overlay) {
        const row = [...repo.production, ...(repo.testSources ?? [])].find(
          (entry): entry is Entry => entry.path === item && !("deleted" in entry),
        )!
        const dest = path.join(target, item)
        await safeParents(target, item)
        const fd = await open(
          dest,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          row.mode === "100755" ? 0o755 : 0o644,
        )
        try {
          await fd.writeFile(await readOwned(await containedFile(closure, `repositories/${repo.id}/overlay/${item}`)))
          await fd.sync()
        } finally {
          await fd.close()
        }
        await chmod(dest, row.mode === "100755" ? 0o755 : 0o644)
      }
      await verifySources(target, repo)
    }
    if (hash(await readOwned(filename)) !== hash(raw)) throw new Error("MANIFEST_DRIFT")
    for (const item of manifest.artifacts) verify(await readOwned(await containedFile(closure, item.path)), item)
    await Bun.write(path.join(out, "source-closure-manifest.json"), raw)
    const result = {
      materialized: true,
      manifestSHA256: hash(raw),
      repositories: manifest.repositories.map((repo) => ({
        id: repo.id,
        origin: repo.origin,
        baseCommit: repo.baseCommit,
        production: repo.production.length,
        testSources: repo.testSources?.length ?? 0,
      })),
      services: 0,
      provider: 0,
      productionReleaseQualified: false,
    }
    await Bun.write(path.join(out, "source-materialization.json"), JSON.stringify(result, null, 2) + "\n")
    completed.value = true
    return result
  } finally {
    await rm(scratch, { recursive: true })
    const current = await lstat(out).catch(() => undefined)
    if (!completed.value && current?.dev === owned.dev && current.ino === owned.ino) await rm(out, { recursive: true })
  }
}

async function verifySources(root: string, repo: Manifest["repositories"][number], checkout = false) {
  for (const row of [...repo.production, ...(repo.testSources ?? [])]) {
    if ("deleted" in row) {
      if (
        await lstat(path.join(root, row.path)).then(
          () => true,
          (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
        )
      )
        throw new Error("DELETION_DRIFT")
      continue
    }
    const filename = await containedFile(root, row.path)
    verify(await readOwned(filename), row)
    // NTFS does not expose POSIX executable bits. The native runner checks the
    // committed Git mode; source reconstruction itself runs on the Linux source job.
    const mode =
      os.platform() === "win32" && checkout
        ? (await run(["git", "-C", root, "ls-files", "--stage", "--", row.path], root)).split(" ")[0]
        : (await lstat(filename)).mode & 0o111
          ? "100755"
          : "100644"
    if (mode !== row.mode) throw new Error("SOURCE_MODE_DRIFT")
  }
  for (const row of repo.licenses) verify(await readOwned(await containedFile(root, row.path)), row)
  for (const row of repo.compilerInputs.filter((item) => item.path.startsWith(repo.id + "/"))) {
    verify(await readOwned(await containedFile(root, row.path.slice(repo.id.length + 1))), row)
  }
}
async function containedFile(root: string, relative: string) {
  safePath(relative)
  for (const [i] of relative.split("/").entries()) {
    const stat = await lstat(path.join(root, ...relative.split("/").slice(0, i + 1)))
    if (stat.isSymbolicLink()) throw new Error("SOURCE_ALIAS")
  }
  return path.join(root, relative)
}
async function safeParents(root: string, relative: string) {
  const parts = relative.split("/").slice(0, -1)
  for (const [i] of parts.entries()) {
    const filename = path.join(root, ...parts.slice(0, i + 1))
    await mkdir(filename, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) =>
      error.code === "EEXIST" ? undefined : Promise.reject(error),
    )
    const stat = await lstat(filename)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OVERLAY_PARENT_ALIAS")
  }
}
async function validateTree(root: string, current: string) {
  for (const name of await readdir(current)) {
    const filename = path.join(current, name)
    const stat = await lstat(filename)
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(filename), await readlink(filename))
      if (!inside(root, target)) throw new Error("BASE_LINK_ESCAPE")
      continue
    }
    if (stat.isDirectory()) {
      await validateTree(root, filename)
      continue
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("BASE_NOT_REGULAR")
  }
}
async function readOwned(filename: string) {
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 33554432) throw new Error("SOURCE_NOT_REGULAR")
    const bytes = await fd.readFile()
    const after = await fd.stat()
    const named = await lstat(filename)
    if (
      bytes.length !== before.size ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      named.size !== after.size
    )
      throw new Error("SOURCE_DRIFT")
    return bytes
  } finally {
    await fd.close()
  }
}
async function run(args: string[], cwd: string, timeout = 60000) {
  const child = Bun.spawn(args, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.platform() === "win32" ? "NUL" : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0 || stdout.length > 1048576 || stderr.length > 1048576)
    throw new Error(`SOURCE_COMMAND_FAILED:${args[0]}:${code}`)
  return stdout
}
function verify(bytes: Uint8Array, record: Record) {
  if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw new Error("SOURCE_DIGEST_MISMATCH")
}
function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
function inside(root: string, filename: string) {
  return filename === root || filename.startsWith(root + path.sep)
}
function safePath(value: string) {
  if (
    !value ||
    path.isAbsolute(value) ||
    /[\x00-\x1f\x7f\\:]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /(^|\/)(\.git|\.env(?:\..*)?|signing\.env|auth\.json|credentials?(?:\.(?:json|ya?ml|toml|ini|txt|env))?|config-private[^/]*|validation|evidence|__pycache__|node_modules|[^/]*-private\.json)(\/|$)|\.(sqlite3?|db|log|jsonl|pem|key|pfx|p12|pyc)$/i.test(
      value,
    )
  )
    throw new Error("UNSAFE_SOURCE_PATH")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes("--manifest") || !args.includes("--out"))
    throw new Error(
      "Usage: --manifest <exported manifest.json> --out <fresh directory> [--roots <private roots.json>] [--check] [--require dac,kernel,platform]",
    )
  const result = await materializeSourceClosure({
    manifest: value("--manifest"),
    out: value("--out"),
    roots: args.includes("--roots") ? await Bun.file(value("--roots")).json() : undefined,
    check: args.includes("--check"),
    require: args.includes("--require") ? value("--require").split(",") : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
}
