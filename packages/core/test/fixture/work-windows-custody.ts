export * as WorkWindowsCustodyFixture from "./work-windows-custody"

export const digest = "a".repeat(64)
export const identity = (id: number) => ({ kind: "windows" as const, volumeSerial: "123456789abcdef0", fileID: id.toString(16).padStart(32, "0") })
export const security = { leaseSetHash: digest, appContainerSID: "S-1-15-2-1-2-3-4-5-6-7", restrictionSID: "S-1-15-3-1024-1-2-3-4" }
export const manifest = {
  version: 2, target: "win32-x64", kind: "command", captureKind: "native_live", admissionID: "admission",
  instanceID: "instance", workID: "work", rootWorkID: "work", sessionID: "session", inputID: "input", activityID: "activity",
  providerReceiptID: "receipt", providerAttemptID: "attempt", toolCallID: "call", ownerToken: "owner",
  sessionClaimToken: 1, bindingHash: digest, controlRevision: 1, custodyID: "command", sourceRequestHash: digest,
  helperHash: digest, snapshotHash: digest, project: "C:\\project", projectIdentity: identity(1), data: "C:\\data",
  dataIdentity: identity(2), baseIdentity: identity(3), containerIdentity: identity(4), basename: `cmd_${"b".repeat(32)}`,
  files: [{ relative: "src/input.ts", identity: identity(5), sha256: digest, bytes: 42 }],
  directories: [{ relative: "", identity: identity(4) }, { relative: "src", identity: identity(6) },
    { relative: ".dac-home", identity: identity(7) }], security, createdAt: 1,
}
export const journal = {
  version: 2, target: "win32-x64", security, cleanupID: "cleanup",
  request: { recoveryID: "recovery", admissionID: "admission", requestID: "request", expectedCustodyRevision: 1 },
  requestHash: digest, instanceID: "instance", operatorID: "operator", operatorRevision: 1, manifestHash: digest,
  custodyRecordHash: digest, recoveryRecordHash: digest, effectID: "effect", effectHash: digest, proofHash: digest,
  knownHash: digest, quarantine: `cleanup_${"c".repeat(32)}`, files: manifest.files, directories: manifest.directories, createdAt: 1,
}
export const proof = { version: 2, target: "win32-x64", cleanupID: "cleanup", manifestHash: digest, planHash: digest,
  dataIdentity: identity(2), baseIdentity: identity(3), containerIdentity: identity(4), quarantine: journal.quarantine,
  state: "empty_verified", files: 1, observedAt: 2, security, aclRestoreHash: digest,
  jobRetired: true, appContainerRetired: true, aclRestored: true }

