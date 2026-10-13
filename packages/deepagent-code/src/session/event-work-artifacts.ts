export * as EventWorkArtifacts from "./event-work-artifacts"

import { createHash } from "node:crypto"
import { Effect } from "effect"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import type { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { EventWorkGit } from "./event-work-git"

export type Entry = { readonly relative: string; readonly mode: "100644" | "100755"; readonly object: string;
  readonly bytes: Buffer; readonly sha256: string }
export function manifest(entries: readonly Entry[]) {
  const digest = createHash("sha256")
  for (const entry of [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))) {
    const name = Buffer.from(entry.relative); const header = Buffer.alloc(4 + name.byteLength + 8)
    header.writeUInt32BE(name.byteLength); name.copy(header, 4); header.writeBigUInt64BE(BigInt(entry.bytes.byteLength), 4 + name.byteLength)
    digest.update(header).update(entry.sha256).update(Buffer.from([Number(entry.mode === "100755")]))
  }
  return digest.digest("hex")
}
const failure = () => new EventWorkDagSchema.Error({ code: "EVENT_DAG_UNAVAILABLE", message: "Original committed raw tree is unavailable, out of scope or beyond its fixed capacity" })
const allowed = (relative: string, scope: WorkAuthoritySchema.ProjectBinding["toolPolicy"]["fileScope"]) => {
  const matches = (rule: { kind: "file" | "tree"; path: string }) => relative === rule.path || rule.kind === "tree" && relative.startsWith(`${rule.path}/`)
  return scope.read.some(matches) && !scope.deny.some(matches)
}

/** Observe only approved paths in the original immutable committed tree. Git object IDs and
 * SHA256 stream hashes remain separate facts; neither a caller path nor a result's text is a ref. */
export const read = Effect.fn("EventWorkArtifacts.read")(function* (input: {
  readonly directory: string
  readonly commit: string
  readonly scope: WorkAuthoritySchema.ProjectBinding["toolPolicy"]["fileScope"]
  readonly maxBytes: number
}) {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || input.maxBytes > 67_108_864) return yield* failure()
  const list = yield* EventWorkGit.run({ directory: input.directory, args: ["ls-tree", "-rz", "--full-tree", input.commit] })
  if (list.exitCode !== 0 || list.stdout.byteLength && list.stdout.at(-1) !== 0) return yield* failure()
  const text = list.stdout.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(list.stdout)) return yield* failure()
  const entries: Entry[] = []
  const names = new Set<string>()
  const total = { bytes: 0 }
  for (const record of text.slice(0, Math.max(0, text.length - 1)).split("\0").filter(Boolean)) {
    const parsed = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record)
    // Symlinks, submodules, control names and non-UTF8 names do not enter an owned tree.
    if (!parsed || parsed[3].includes("\\") ||
      /[\u0000-\u001f\u007f:]/.test(parsed[3]) || Buffer.byteLength(parsed[3]) > 2048 || parsed[3].split("/").length > 32 ||
      parsed[3].split("/").some((name) => !name || name === "." || name === ".." || name.toLowerCase() === ".git" || name.startsWith(".dac-tree-")))
      return yield* failure()
    const relative = parsed[3]
    if (!allowed(relative, input.scope)) continue
    if (entries.length >= 8192 || names.has(relative)) return yield* failure()
    names.add(relative)
    const size = yield* EventWorkGit.run({ directory: input.directory, args: ["cat-file", "-s", parsed[2]] })
    const bytes = Number(size.stdout.toString().trim())
    if (size.exitCode !== 0 || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > Math.min(16_777_216, input.scope.maxHashBytes, input.scope.maxReadBytes) ||
      total.bytes + bytes > input.maxBytes) return yield* failure()
    const body = yield* EventWorkGit.run({ directory: input.directory, args: ["cat-file", "blob", parsed[2]], blob: true })
    if (body.exitCode !== 0 || body.stdout.byteLength !== bytes) return yield* failure()
    total.bytes += bytes
    entries.push({ relative, mode: parsed[1] as Entry["mode"], object: parsed[2], bytes: body.stdout,
      sha256: createHash("sha256").update(body.stdout).digest("hex") })
  }
  return entries
})

/** Fixed raw three-way merge. Identical changes and disjoint files converge; simultaneous
 * different edits of one file are a real conflict. Repository merge drivers never execute. */
export function merge(base: readonly Entry[], branches: readonly (readonly Entry[])[]) {
  const original = new Map(base.map((entry) => [entry.relative, entry]))
  const merged = new Map(original)
  const touched = new Set<string>()
  const equal = (left: Entry | undefined, right: Entry | undefined) => left?.object === right?.object && left?.mode === right?.mode && left?.sha256 === right?.sha256
  for (const branch of branches) {
    const other = new Map(branch.map((entry) => [entry.relative, entry]))
    for (const name of new Set([...original.keys(), ...other.keys()])) {
      const before = original.get(name)
      const after = other.get(name)
      if (equal(before, after)) continue
      if (touched.has(name) && !equal(merged.get(name), after)) return { ok: false as const, reason: "artifact_merge_conflict" }
      touched.add(name)
      if (after) merged.set(name, after)
      if (!after) merged.delete(name)
    }
  }
  const result = [...merged.values()].sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
  if (result.length > 8192 || result.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) > 67_108_864 ||
    result.some((entry) => result.some((other) => other.relative.startsWith(`${entry.relative}/`))))
    return { ok: false as const, reason: "artifact_merge_capacity_or_namespace" }
  return { ok: true as const, entries: result }
}
