export * as WorkStorageCleanupWindowsSchema from "./work-storage-cleanup-windows.schema"

import { Schema } from "effect"
import { WorkProcessSupervisorSchema } from "./work-process-supervisor.schema"
import { WorkStorageCleanupSchema } from "./work-storage-cleanup.schema"
import { WorkWindowsPathSchema } from "./work-windows-path.schema"
import { WorkStorageCleanupWindowsWriteSchema } from "./work-storage-cleanup-windows-write.schema"

export const Target = Schema.Literals(["win32-x64", "win32-arm64"])
export const Identity = WorkProcessSupervisorSchema.Identity.members[1]
const SIDNumber = "(?:0|[1-9][0-9]{0,9})"
const sid = (kind: 2 | 3) => Schema.String.check(Schema.isPattern(new RegExp(`^S-1-15-${kind}(?:-${SIDNumber}){1,8}$`)),
  Schema.makeFilter((value: string) => value.split("-").slice(4).every((part) => Number(part) <= 4_294_967_295)))

/** The descriptor bytes and original handles belong to the native private
 * journal. These values bind it; decoding them cannot mint an ACL lease. */
const nativeRestrictionSID = Schema.String.check(
  Schema.isPattern(new RegExp(`^S-1-5-21(?:-${SIDNumber}){4}$`)),
  Schema.makeFilter((value: string) => value.split("-").slice(4).every((part) => Number(part) <= 4_294_967_295)))

// Historical manifests retain their original MAC domain and SID bytes. Their
// decoder is never the constructor for a current native ACL or token lease.
export const Security = Schema.Struct({ leaseSetHash: WorkStorageCleanupSchema.Digest,
  appContainerSID: sid(2), restrictionSID: Schema.Union([sid(3), nativeRestrictionSID]) })
export const NativeSecurity = Schema.Struct({ ...Security.fields, restrictionSID: nativeRestrictionSID })
export const File = Schema.Struct({ ...WorkStorageCleanupSchema.File.fields,
  relative: WorkWindowsPathSchema.MemberRelative, identity: Identity })
export const Directory = Schema.Struct({ relative: WorkWindowsPathSchema.DirectoryRelative, identity: Identity })

/** New Windows command custody never reinterprets a historical POSIX manifest. */
export const Manifest = Schema.Struct({ ...WorkStorageCleanupSchema.Manifest.fields,
  version: Schema.Literal(2), target: Target, kind: Schema.Literal("command"), captureKind: Schema.Literal("native_live"),
  project: WorkWindowsPathSchema.Absolute, projectIdentity: Identity,
  data: WorkWindowsPathSchema.Absolute, dataIdentity: Identity, baseIdentity: Identity, containerIdentity: Identity,
  basename: Schema.String.check(Schema.isPattern(/^cmd_[a-f0-9]{32}$/)), snapshotHash: WorkStorageCleanupSchema.Digest,
  files: Schema.Array(File).check(Schema.isMaxLength(288)),
  directories: Schema.Array(Directory).check(Schema.isMaxLength(4610)), security: Security,
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= WorkStorageCleanupSchema.MAX_MANIFEST_BYTES &&
  inventory(value.files, value.directories) && value.files.reduce((sum, item) => sum + item.bytes, 0) <= 67_108_864))
export type Manifest = typeof Manifest.Type

export const Journal = Schema.Struct({ ...WorkStorageCleanupSchema.Journal.fields,
  version: Schema.Literal(2), target: Target, security: Security,
  files: Schema.Array(File).check(Schema.isMaxLength(288)),
  directories: Schema.Array(Directory).check(Schema.isMaxLength(4610)),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= WorkStorageCleanupSchema.MAX_JOURNAL_BYTES &&
  inventory(value.files, value.directories)))
export type Journal = typeof Journal.Type

/** The native verifier must authenticate every descriptor readback and both
 * retirements. JSON booleans alone are never a cleanup or quota-release proof. */
export const Proof = Schema.Struct({ ...WorkStorageCleanupSchema.Proof.fields,
  version: Schema.Literal(2), target: Target, dataIdentity: Identity, baseIdentity: Identity, containerIdentity: Identity,
  security: Security, aclRestoreHash: WorkStorageCleanupSchema.Digest,
  jobRetired: Schema.Literal(true), appContainerRetired: Schema.Literal(true), aclRestored: Schema.Literal(true),
})
export type Proof = typeof Proof.Type

export const StoredManifest = Schema.Union([WorkStorageCleanupSchema.Manifest, Manifest, WorkStorageCleanupWindowsWriteSchema.Manifest])
export type StoredManifest = typeof StoredManifest.Type
export const StoredJournal = Schema.Union([WorkStorageCleanupSchema.Journal, Journal, WorkStorageCleanupWindowsWriteSchema.Journal])
export type StoredJournal = typeof StoredJournal.Type
export const StoredProof = Schema.Union([WorkStorageCleanupSchema.Proof, Proof, WorkStorageCleanupWindowsWriteSchema.Proof])
export type StoredProof = typeof StoredProof.Type

function inventory(files: ReadonlyArray<typeof File.Type>, directories: ReadonlyArray<typeof Directory.Type>) {
  const paths = [...files.map((item) => item.relative), ...directories.map((item) => item.relative)]
  const folders = new Set(directories.map((item) => item.relative.toUpperCase()))
  // Duplicate physical IDs also reject 8.3 aliases and same-file spellings. A
  // native no-follow observer still has to attest the original inventory.
  const identities = [...files, ...directories].map((item) => `${item.identity.volumeSerial}:${item.identity.fileID}`)
  return folders.has("") && WorkWindowsPathSchema.unique(paths) && new Set(identities).size === identities.length &&
    paths.every((relative) => {
      const parts = relative.toUpperCase().split("/")
      return parts.slice(0, -1).every((_part, index) => folders.has(parts.slice(0, index + 1).join("/")))
    }) && !files.some((item) => paths.some((relative) => relative.toUpperCase().startsWith(`${item.relative.toUpperCase()}/`)))
}
