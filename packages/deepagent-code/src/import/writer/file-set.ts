export * as ImportFileSet from "./file-set"

import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ImportJob } from "@deepagent-code/core/import-job"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { stageAndReviewMemoriesControlled } from "./memory"
import { writeSkillControlled } from "./skill"
import type { ParsedSource } from "../ir"
import type { ImportTarget } from "../target"
import type { ImportFileControl } from "../types"

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  jobID: Schema.String,
  batchID: Schema.String,
  sourceDigest: Schema.String,
  identity: Schema.Struct({ device: Schema.String, inode: Schema.String }),
  directories: Schema.Array(Schema.String),
  files: Schema.Array(Schema.Struct({ relative: Schema.String, bytes: Schema.Int, sha256: Schema.String })),
  result: ImportJobSchema.FileSetResult,
})
type Manifest = typeof Manifest.Type
const fingerprint = (manifest: Manifest) =>
  Hash.sha256(
    CanonicalJson.stringify({
      ...manifest,
      result: { ...manifest.result, manifestHash: "0".repeat(64) },
    }),
  )
const relative = (value: string) =>
  value.length > 0 &&
  Buffer.byteLength(value) <= 2048 &&
  !/[\\:\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").length <= 32 &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
const absent = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
  throw error
}
const stagePath = (target: ImportTarget, batchID: string) => {
  if (!/^file_[a-f0-9]{64}$/.test(batchID)) throw new Error("IMPORT_FILE_BATCH_INVALID: invalid file batch identity")
  return path.join(path.dirname(target.dataRoot), "file-batches", batchID)
}
const destination = (target: ImportTarget, result: ImportJobSchema.FileSetResult) => {
  if (
    target.mode !== "copy_to_new_db" ||
    !relative(result.directoryRef.relative) ||
    (result.scope === "memory"
      ? result.directoryRef.area !== "data" ||
        !/^(public\/knowledge|project\/project_[a-f0-9]{16}\/knowledge)$/.test(result.directoryRef.relative)
      : result.directoryRef.area !== "config" || !/^skills\/[^/]+$/.test(result.directoryRef.relative))
  )
    throw new Error("IMPORT_FILE_TARGET_INVALID: file batch is outside the private copy target")
  return path.join(
    result.directoryRef.area === "data" ? target.dataRoot : target.configDir,
    result.directoryRef.relative,
  )
}

/** Observe exact opened regular files, including governance version files. Never truncate a root. */
async function tree(root: string, checkpoint: () => Promise<void>, sync = false) {
  const files: Manifest["files"][number][] = []
  const directories: string[] = []
  const count = { entries: 0, bytes: 0 }
  const held = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const identity = await held.stat()
    const visit = async (name: string): Promise<void> => {
      await checkpoint()
      if (++count.entries > 10_000 || name.split("/").length > 32)
        throw new Error("IMPORT_FILE_BUDGET_EXCEEDED: file-set entry/depth budget")
      const filename = name ? path.join(root, name) : root
      const before = await fs.lstat(filename)
      if (
        before.isSymbolicLink() ||
        (await fs.realpath(filename)) !== filename ||
        (!sync && (before.mode & 0o077) !== 0)
      )
        throw new Error("IMPORT_FILE_CHANGED: private file-set path changed")
      if (before.isDirectory()) {
        if (sync) {
          const directory = await fs.open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try {
            const opened = await directory.stat()
            if (opened.dev !== before.dev || opened.ino !== before.ino)
              throw new Error("IMPORT_FILE_CHANGED: staging directory changed")
            await directory.chmod(0o700)
          } finally {
            await directory.close()
          }
        }
        directories.push(name)
        const entries = []
        for await (const entry of await fs.opendir(filename)) {
          if (entries.length + count.entries >= 10_000)
            throw new Error("IMPORT_FILE_BUDGET_EXCEEDED: directory entry budget")
          entries.push(entry.name)
        }
        for (const entry of entries.sort()) await visit(name ? `${name}/${entry}` : entry)
        if (sync) {
          const directory = await fs.open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
        const after = await fs.lstat(filename)
        if (after.dev !== before.dev || after.ino !== before.ino)
          throw new Error("IMPORT_FILE_CHANGED: directory identity changed")
        return
      }
      if (!before.isFile() || before.nlink !== 1 || before.size > 16_777_216 || count.bytes + before.size > 268_435_456)
        throw new Error("IMPORT_FILE_BUDGET_EXCEEDED: regular file or complete root byte budget")
      const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (sync) await file.chmod(0o600)
        const opened = await file.stat()
        const bytes = Buffer.alloc(before.size)
        const read = await file.read(bytes, 0, bytes.length, 0)
        if (sync) await file.sync()
        const after = await file.stat()
        const named = await fs.lstat(filename)
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size ||
          read.bytesRead !== bytes.length ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs ||
          named.dev !== opened.dev ||
          named.ino !== opened.ino
        )
          throw new Error("IMPORT_FILE_CHANGED: opened file changed")
        count.bytes += bytes.length
        files.push({ relative: name, bytes: bytes.length, sha256: Hash.sha256(bytes) })
      } finally {
        await file.close()
      }
    }
    await visit("")
    const named = await fs.lstat(root)
    if (!identity.isDirectory() || identity.dev !== named.dev || identity.ino !== named.ino)
      throw new Error("IMPORT_FILE_CHANGED: file-set root identity changed")
    return {
      identity: { device: String(identity.dev), inode: String(identity.ino) },
      files,
      directories,
      bytes: count.bytes,
    }
  } finally {
    await held.close()
  }
}

/** Every new ancestor must survive restart as well as the final published directory. */
async function prepareDirectory(root: string, ref: string) {
  if (!relative(ref)) throw new Error("IMPORT_FILE_TARGET_INVALID: invalid private directory path")
  const original = await fs.lstat(root)
  if (
    !original.isDirectory() ||
    original.isSymbolicLink() ||
    (await fs.realpath(root)) !== root ||
    (original.mode & 0o077) !== 0
  )
    throw new Error("IMPORT_FILE_TARGET_CHANGED: private target root changed")
  const parts = ref.split("/")
  for (const index of parts.keys()) {
    const parentPath = path.join(root, ...parts.slice(0, index))
    const filename = path.join(parentPath, parts[index]!)
    const parent = await fs.open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await fs.mkdir(filename, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      const directory = await fs.open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const opened = await directory.stat()
        const named = await fs.lstat(filename)
        if (
          opened.dev !== original.dev ||
          opened.dev !== named.dev ||
          opened.ino !== named.ino ||
          (opened.mode & 0o077) !== 0 ||
          (await fs.realpath(filename)) !== filename
        )
          throw new Error("IMPORT_FILE_TARGET_CHANGED: private directory changed")
        await directory.sync()
        await parent.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await parent.close()
    }
  }
}

async function readManifest(target: ImportTarget, jobID: string, batchID: string, sourceDigest: string) {
  const file = await fs.open(
    path.join(stagePath(target, batchID), "manifest.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4_194_304)
      throw new Error("IMPORT_FILE_MANIFEST_INVALID: manifest exceeds budget")
    const bytes = Buffer.alloc(stat.size)
    const read = await file.read(bytes, 0, bytes.length, 0)
    const after = await file.stat()
    if (
      read.bytesRead !== bytes.length ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error("IMPORT_FILE_MANIFEST_CHANGED: manifest changed during reading")
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest), { onExcessProperty: "error" })(
      bytes.toString("utf8"),
    )
    if (
      manifest.jobID !== jobID ||
      manifest.batchID !== batchID ||
      manifest.sourceDigest !== sourceDigest ||
      manifest.result.sourceId !== batchID ||
      manifest.result.manifestHash !== fingerprint(manifest) ||
      manifest.files.some((file) => !relative(file.relative)) ||
      manifest.directories.some((name) => name !== "" && !relative(name)) ||
      manifest.result.bytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0) ||
      manifest.result.fileCount !== manifest.files.length
    )
      throw new Error("IMPORT_FILE_MANIFEST_CHANGED: manifest does not match the frozen batch")
    destination(target, manifest.result)
    return manifest
  } finally {
    await file.close()
  }
}

async function verify(target: ImportTarget, manifest: Manifest, root = destination(target, manifest.result)) {
  const actual = await tree(root, async () => {})
  if (
    CanonicalJson.stringify({
      identity: manifest.identity,
      files: manifest.files,
      directories: manifest.directories,
    }) !== CanonicalJson.stringify({ identity: actual.identity, files: actual.files, directories: actual.directories })
  )
    throw new Error("IMPORT_FILE_CHANGED: published tree differs from its original manifest")
}

export async function verifyReceipts(
  target: ImportTarget,
  jobID: string,
  sourceDigest: string,
  results: readonly ImportJobSchema.FileSetResult[],
) {
  for (const result of results) {
    const manifest = await readManifest(target, jobID, result.sourceId, sourceDigest)
    if (CanonicalJson.stringify(manifest.result) !== CanonicalJson.stringify(result))
      throw new Error("IMPORT_FILE_RECEIPT_CHANGED: receipt differs from its manifest")
    await verify(target, manifest)
  }
}

/** Called only by explicit cold cancellation while both target flock and SQL writer fence are held. */
export async function reconcile(
  target: ImportTarget,
  jobID: string,
  batchID: string,
  sourceDigest: string,
  manifestHash: string,
  database: Parameters<Parameters<typeof ImportJob.withDestinationFence>[1]>[0],
) {
  const manifest = await readManifest(target, jobID, batchID, sourceDigest)
  if (manifest.result.manifestHash !== manifestHash)
    throw new Error("IMPORT_FILE_MANIFEST_CHANGED: manifest differs from the control-frozen batch")
  const published = await fs.lstat(destination(target, manifest.result)).catch(absent)
  const staged = await fs.lstat(path.join(stagePath(target, batchID), "payload")).catch(absent)
  if (!published && staged) {
    await verify(target, manifest, path.join(stagePath(target, batchID), "payload"))
    return false
  }
  if (!published || staged)
    throw new Error("IMPORT_FILE_PUBLICATION_UNKNOWN: neither an exact staged nor published tree is provable")
  await verify(target, manifest)
  return record(database, manifest)
}

function record(database: Parameters<Parameters<typeof ImportJob.withDestinationFence>[1]>[0], manifest: Manifest) {
  const prior = database
    .query("SELECT source_digest,target_id,result FROM import_batch_receipt WHERE job_id=? AND batch_id=?")
    .get(manifest.jobID, manifest.batchID) as { source_digest: string; target_id: string; result: string } | null
  if (prior) {
    if (
      prior.source_digest !== manifest.sourceDigest ||
      prior.target_id !== manifest.result.targetId ||
      prior.result !== CanonicalJson.stringify(manifest.result)
    )
      throw new Error("IMPORT_FILE_RECEIPT_CONFLICT: batch receipt differs")
    return false
  }
  database
    .query(
      "INSERT INTO import_batch_receipt(job_id,batch_id,source_id,source_digest,target_id,result,committed_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      manifest.jobID,
      manifest.batchID,
      manifest.result.sourceId,
      manifest.sourceDigest,
      manifest.result.targetId,
      CanonicalJson.stringify(manifest.result),
      Date.now(),
    )
  return true
}

export async function run(input: {
  parsed: ParsedSource
  target: ImportTarget
  jobID: string
  sourceDigest: string
  scopes: readonly string[]
  sourceRoot: string
  sourceFiles: readonly { path: string; size: number; sha256: string }[]
  control: ImportFileControl
}) {
  const sourceFiles = new Map(input.sourceFiles.map((file) => [file.path, file]))
  const memories = new Map<string, ParsedSource["memories"]>()
  for (const item of input.scopes.includes("memory") ? input.parsed.memories : []) {
    const ref = item.cwd ? `project/${projectIdForWorkspace(item.cwd)}/knowledge` : "public/knowledge"
    memories.set(ref, [...(memories.get(ref) ?? []), item])
  }
  const skills = input.scopes.includes("skill") ? input.parsed.skills : []
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
    throw new Error("IMPORT_SKILL_IDENTITY_CONFLICT: two skills select the same destination")
  const plans = [
    ...[...memories].map(([ref, items]) => ({ scope: "memory" as const, area: "data" as const, ref, items })),
    ...skills.map((skill) => ({
      scope: "skill" as const,
      area: "config" as const,
      ref: `skills/${skill.name}`,
      skill,
    })),
  ]
  for (const plan of plans) {
    await input.control.checkpoint()
    const batchID = `file_${Hash.sha256(CanonicalJson.stringify([input.jobID, plan.scope, plan.area, plan.ref]))}`
    await input.control.beforeBatch(batchID)
    const stage = stagePath(input.target, batchID)
    await prepareDirectory(path.dirname(input.target.dataRoot), `file-batches/${batchID}`)
    const summary =
      plan.scope === "memory"
        ? await stageAndReviewMemoriesControlled(plan.items, path.join(stage, "build"), input.control.checkpoint)
        : await writeSkillControlled(
            plan.skill,
            path.join(stage, "build"),
            input.control.checkpoint,
            (filename, bytes) => {
              const file = sourceFiles.get(path.relative(input.sourceRoot, filename).split(path.sep).join("/"))
              if (!file || file.size !== bytes.length || file.sha256 !== Hash.sha256(bytes))
                throw new Error("IMPORT_SKILL_SOURCE_CHANGED: asset differs from its frozen source manifest")
            },
          )
    await fs.rename(
      path.join(stage, "build", plan.scope === "memory" ? plan.ref : `skills/${plan.skill.name}`),
      path.join(stage, "payload"),
    )
    const observed = await tree(path.join(stage, "payload"), input.control.checkpoint, true)
    const result = Schema.decodeUnknownSync(ImportJobSchema.FileSetResult)({
      kind: "file_set.v1",
      phase: "published",
      sourceId: batchID,
      targetId: `file:${plan.area}/${plan.ref}`,
      scope: plan.scope,
      directoryRef: { area: plan.area, relative: plan.ref },
      bytes: observed.bytes,
      fileCount: observed.files.length,
      manifestHash: "0".repeat(64),
      summary,
    })
    const prepared: Manifest = {
      version: 1,
      jobID: input.jobID,
      batchID,
      sourceDigest: input.sourceDigest,
      identity: observed.identity,
      files: observed.files,
      directories: observed.directories,
      result,
    }
    const manifest = { ...prepared, result: { ...result, manifestHash: fingerprint(prepared) } }
    const encoded = CanonicalJson.stringify(manifest)
    if (Buffer.byteLength(encoded) > 4_194_304) throw new Error("IMPORT_FILE_BUDGET_EXCEEDED: complete manifest budget")
    const file = await fs.open(
      path.join(stage, "manifest.json"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(encoded)
      await file.sync()
    } finally {
      await file.close()
    }
    const stageFD = await fs.open(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await stageFD.sync()
    } finally {
      await stageFD.close()
    }
    const publicationID = await input.control.preparedBatch(batchID, manifest.result.manifestHash)
    if (publicationID !== `${batchID}:${manifest.result.manifestHash}`)
      throw new Error("IMPORT_FILE_BATCH_INVALID: prepared authority differs from the manifest")
    await input.control.checkpoint()
    const target = destination(input.target, result)
    await prepareDirectory(
      plan.area === "data" ? input.target.dataRoot : input.target.configDir,
      plan.ref.split("/").slice(0, -1).join("/"),
    )
    if (await fs.lstat(target).catch(absent))
      throw new Error("IMPORT_FILE_TARGET_EXISTS: private destination is not absent")
    const parent = await fs.open(
      path.dirname(target),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const payload = await fs
      .open(path.join(stage, "payload"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      .catch(async (error) => {
        await parent.close()
        throw error
      })
    const sourceParent = await fs
      .open(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      .catch(async (error) => {
        await Promise.all([payload.close(), parent.close()])
        throw error
      })
    const published = { value: false }
    try {
      const identity = await parent.stat()
      if (
        String(identity.dev) !== manifest.identity.device ||
        (await fs.realpath(path.dirname(target))) !== path.dirname(target)
      )
        throw new Error("IMPORT_FILE_TARGET_CHANGED: publication requires the original same-device parent")
      await verify(input.target, manifest, path.join(stage, "payload"))
      await Effect.runPromise(
        ImportJob.withDestinationFence(input.target.dbPath, (database) =>
          input.control.publish(publicationID, async () => {
            if (await fs.lstat(target).catch(absent))
              throw new Error("IMPORT_FILE_TARGET_EXISTS: destination changed before publication")
            const named = await fs.lstat(path.dirname(target))
            if (named.dev !== identity.dev || named.ino !== identity.ino)
              throw new Error("IMPORT_FILE_TARGET_CHANGED: publication parent changed")
            const held = await payload.stat()
            const staged = await fs.lstat(path.join(stage, "payload"))
            if (
              held.dev !== staged.dev ||
              held.ino !== staged.ino ||
              String(held.dev) !== manifest.identity.device ||
              String(held.ino) !== manifest.identity.inode
            )
              throw new Error("IMPORT_FILE_CHANGED: publication payload identity changed")
            published.value = true
            await fs.rename(path.join(stage, "payload"), target)
            await sourceParent.sync()
            await parent.sync()
            const actual = await fs.lstat(target)
            if (actual.dev !== held.dev || actual.ino !== held.ino)
              throw new Error("IMPORT_FILE_CHANGED: published directory identity changed")
            record(database, manifest)
          }),
        ),
      )
    } catch (error) {
      if (published.value)
        throw new Error(
          "IMPORT_FILE_PUBLICATION_UNKNOWN: retain original tree and manifest for explicit reconciliation",
          { cause: error },
        )
      throw error
    } finally {
      await Promise.all([sourceParent.close(), payload.close(), parent.close()])
    }
    await input.control.afterBatch()
  }
}
