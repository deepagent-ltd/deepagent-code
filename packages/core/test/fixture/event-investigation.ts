export * as EventInvestigationFixture from "./event-investigation"

import { WorkAuthorityPolicy } from "../../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { EventInvestigationSchema } from "../../src/deepagent/event-investigation.schema"
import { EventInvestigationPolicy } from "../../src/deepagent/event-investigation-policy"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"
import { WorkAuthorityFixture } from "./work-authority"

/** Candidate data only. Actual tests install their separate controlled SQL host boundary. */
export function binding(suffix = "investigation"): WorkAuthoritySchema.ProjectBinding {
  const original = WorkAuthorityFixture.binding(suffix)
  return {
    ...original, schemaVersion: "work-execution.v2",
    source: { ...original.source, kind: "server_rule" },
    scope: { ...original.scope, workspaceID: original.location.directory },
    profile: { id: "event_investigate_v1", version: 1, hash: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE_HASH },
    projectScope: { projectID: "project-work", locationKey: original.location.directory,
      namespaceBindingHash: "a".repeat(64), canonicalRoot: original.location.directory,
      helperHash: "b".repeat(64), rootIdentity: { kind: "posix", device: "1", inode: "2" } },
    contextPolicy: { kind: "scoped_project_history_v1", instructionsRevision: 1,
      history: "same_work_activity", graphs: [], references: [], files: "approved_tool_results_only" },
    toolPolicy: { kind: "scoped_project_tools_v1",
      capabilities: [{ toolID: "read", definitionHash: "c".repeat(64), operations: ["read"] }],
      fileScope: { read: [{ kind: "file", path: "input.ts" }], write: [], deny: [],
        maxReadBytes: 67_108_864, maxPageBytes: 51_200, maxHashBytes: 16_777_216, maxWriteBytes: 0, symlinks: "deny" },
      commandScope: [], commandRecipes: [], integrations: [] },
    childPolicy: "deny_all", budget: { ...WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget },
  }
}

export function receipt(): EventInvestigationSchema.Receipt {
  const work = binding()
  const stream = { sha256: Hash.sha256(""), bytes: 0, capturedBytes: 0, truncated: false,
    complete: true as const, excerptTruncated: false }
  const result = { outcome: "failed" as const, exitCode: 1, signal: null, stopConfirmed: true as const,
    endedAt: 1_000, stdout: stream, stderr: stream }
  const evidence: EventInvestigationSchema.Evidence = { version: 1, instanceID: "instance-one", ruleID: "rule-one",
    runID: "run-one", testRunID: null, previewBuildID: "build-one", ruleRevision: 1,
    contentRevision: 1, contentHash: "d".repeat(64), recipeHash: "e".repeat(64), configHash: "f".repeat(64),
    snapshotHash: "1".repeat(64), processIncarnation: "process-one", scopeHash: "2".repeat(64),
    content: { files: [{ relative: "input.ts", identity: { kind: "posix", device: "1", inode: "3" },
      sha256: Hash.sha256("source"), bytes: 6, missing: false }], contentHash: "d".repeat(64), observedAt: 1_000 },
    resultHash: EventInvestigationPolicy.hash({ ...result, stdout: { ...stream, excerpt: "" }, stderr: { ...stream, excerpt: "" } }), result }
  const grant = { version: 1 as const, grantID: "grant-one", epoch: 1, ruleID: evidence.ruleID,
    principal: { instanceID: evidence.instanceID, actorID: work.scope.actorID, revision: 1, identityHash: "3".repeat(64) },
    credentialGeneration: 1, policyRevision: 1, policyHash: "4".repeat(64), targetID: "investigation",
    target: { version: 2 as const, scope: work.scope, location: work.location, agentID: work.agentID,
      profile: work.profile, provider: work.provider, budget: work.budget, durationMs: 60_000,
      projectScope: work.projectScope, contextPolicy: work.contextPolicy, toolPolicy: work.toolPolicy, childPolicy: work.childPolicy },
    scopeHash: evidence.scopeHash, createdAt: 1_000, expiresAt: 100_000 }
  const key = EventInvestigationPolicy.failureKey(evidence)
  const ids = EventInvestigationPolicy.identities(key)
  const auditedText = CanonicalJson.stringify({ version: "event-investigation-audited.v1", failure: evidence,
    logs: { stdout: "", stderr: "" }, approvedRead: evidence.content.files })
  const base = { version: 1 as const, receiptID: ids.receiptID, instanceID: evidence.instanceID, ruleID: evidence.ruleID,
    projectKey: "5".repeat(64), securityNamespaceID: work.scope.securityNamespaceID,
    contentRevision: evidence.contentRevision, contentHash: evidence.contentHash, recipeHash: evidence.recipeHash,
    failureKey: key, runID: evidence.runID, grantEpoch: grant.epoch,
    workID: ids.workID, rootWorkID: ids.workID, sessionID: ids.sessionID, inputID: ids.inputID, sourceRequestID: key,
    deadline: 61_000, createdAt: 1_000, grant, grantHash: EventInvestigationPolicy.hash(grant),
    evidence, evidenceHash: EventInvestigationPolicy.hash(evidence), auditedText,
    auditedTextHash: Hash.sha256(auditedText), auditedTextBytes: Buffer.byteLength(auditedText) }
  const authorized = { ...base, authorityHash: EventInvestigationPolicy.authorityHash(base) }
  return { ...authorized, bindingHash: WorkAuthorityPolicy.fingerprint(EventInvestigationPolicy.bindingFor(authorized)) }
}
