import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { WorkWindowsCustodyFixture } from "./fixture/work-windows-custody"
import { CanonicalJson } from "../src/util/canonical-json"
import { WorkStorageCleanupSchema } from "../src/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsSchema } from "../src/session/work-storage-cleanup-windows.schema"

const digest = WorkWindowsCustodyFixture.digest
const identity = WorkWindowsCustodyFixture.identity
const security = { ...WorkWindowsCustodyFixture.security, restrictionSID: "S-1-5-21-1-2-3-4" }
const manifest = WorkWindowsCustodyFixture.manifest
const journal = WorkWindowsCustodyFixture.journal
const proof = WorkWindowsCustodyFixture.proof

test("Windows cleanup is a separate bounded command contract with strict identity and security binding", () => {
  const decode = Schema.decodeUnknownOption(WorkStorageCleanupWindowsSchema.StoredManifest, { onExcessProperty: "error" })
  for (const target of ["win32-x64", "win32-arm64"]) {
    expect(Option.isSome(decode({ ...manifest, target }))).toBeTrue()
    expect(Option.isSome(Schema.decodeUnknownOption(WorkStorageCleanupWindowsSchema.Journal)({ ...journal, target }))).toBeTrue()
    expect(Option.isSome(Schema.decodeUnknownOption(WorkStorageCleanupWindowsSchema.Proof)({ ...proof, target }))).toBeTrue()
  }
  for (const value of [{ ...manifest, version: 1 }, { ...manifest, target: "linux-x64" }, { ...manifest, kind: "write" },
    { ...manifest, captureKind: "known_empty_legacy" }, { ...manifest, snapshotHash: null }, { ...manifest, processID: 42 },
    { ...manifest, projectIdentity: { kind: "posix", device: "1", inode: "2" } },
    { ...manifest, project: "\\\\server\\share\\project" }, { ...manifest, data: "/tmp/data" },
    { ...manifest, security: undefined }, { ...manifest, security: { ...security, leaseSetHash: "bad" } },
    { ...manifest, security: { ...security, appContainerSID: security.restrictionSID } },
    { ...manifest, security: { ...security, restrictionSID: "S-1-5-21-1-2-3-4294967296" } },
    { ...manifest, security: { ...security, restrictionSID: "S-1-5-21-01-2-3-4" } },
    { ...manifest, security: { ...security, restrictionSID: "S-1-5-21-1-2-3" } },
    { ...manifest, security: { ...security, restrictionSID: "S-1-5-21-1-2-3-4-5" } }])
    expect(Option.isNone(decode(value))).toBeTrue()
})

test("Windows retirement inventory rejects path aliases, physical aliases and missing ancestors", () => {
  const decode = Schema.decodeUnknownOption(WorkStorageCleanupWindowsSchema.Manifest, { onExcessProperty: "error" })
  for (const value of [
    { ...manifest, files: [...manifest.files, { ...manifest.files[0]!, relative: "SRC/INPUT.ts", identity: identity(8) }] },
    { ...manifest, files: [...manifest.files, { ...manifest.files[0]!, relative: "src/INPUT~1.ts" }] },
    { ...manifest, files: [...manifest.files, { ...manifest.files[0]!, relative: "src/other.ts" }] },
    { ...manifest, files: [{ ...manifest.files[0]!, relative: "src/NUL.txt" }] },
    { ...manifest, files: [{ ...manifest.files[0]!, relative: "src/input.ts:stream" }] },
    { ...manifest, directories: manifest.directories.filter((item) => item.relative !== "src") },
    { ...manifest, directories: manifest.directories.filter((item) => item.relative !== "") },
    { ...manifest, directories: [...manifest.directories, { relative: "SRC", identity: identity(8) }] },
    { ...manifest, directories: [...manifest.directories, { relative: "src/input.ts/subdir", identity: identity(8) }] },
    { ...manifest, directories: [...manifest.directories, { relative: "nested/absent", identity: identity(8) }] },
    { ...manifest, directories: [...manifest.directories, ...Array.from({ length: 500 }, (_value, index) =>
      ({ relative: `folder_${index}`, identity: identity(index + 10) }))] },
  ]) expect(Option.isNone(decode(value))).toBeTrue()
})

test("Windows cleanup proof requires all retirement observations and never reinterprets POSIX v1 bytes", () => {
  const decode = Schema.decodeUnknownOption(WorkStorageCleanupWindowsSchema.StoredProof, { onExcessProperty: "error" })
  for (const value of [{ ...proof, jobRetired: false }, { ...proof, appContainerRetired: false }, { ...proof, aclRestored: false },
    { ...proof, aclRestoreHash: null }, { ...proof, security: null }, { ...proof, version: 1 }, { ...proof, nativeHandle: "caller" }])
    expect(Option.isNone(decode(value))).toBeTrue()
  const legacy = { version: 1, cleanupID: "old-cleanup", manifestHash: digest, planHash: digest,
    dataIdentity: { kind: "posix", device: "1", inode: "2" }, baseIdentity: { kind: "posix", device: "1", inode: "3" },
    containerIdentity: { kind: "posix", device: "1", inode: "4" }, quarantine: journal.quarantine,
    state: "empty_verified", files: 1, observedAt: 2 }
  const bytes = CanonicalJson.stringify(legacy)
  const decoded = Schema.decodeUnknownSync(WorkStorageCleanupWindowsSchema.StoredProof, { onExcessProperty: "error" })(legacy)
  expect(CanonicalJson.stringify(decoded)).toBe(bytes)
  expect(Schema.is(WorkStorageCleanupSchema.Proof)(decoded)).toBeTrue()
})

test("current native restriction identities use a distinct random NT SID while historical MAC bytes still decode", () => {
  const historical = { ...security, restrictionSID: "S-1-15-3-1024-1-2-3-4" }
  expect(Schema.is(WorkStorageCleanupWindowsSchema.Security)(historical)).toBeTrue()
  expect(Schema.is(WorkStorageCleanupWindowsSchema.NativeSecurity)(historical)).toBeFalse()
  expect(Schema.is(WorkStorageCleanupWindowsSchema.NativeSecurity)(security)).toBeTrue()
  for (const restrictionSID of ["S-1-5-21-4294967296-2-3-4", "S-1-5-21-01-2-3-4", "S-1-5-21-1-2-3", "S-1-5-21-1-2-3-4-5"])
    expect(Schema.is(WorkStorageCleanupWindowsSchema.NativeSecurity)({ ...security, restrictionSID })).toBeFalse()
})
