export * as WorkRouteApprovalFixture from "./work-route-approval"

import { createHmac, randomBytes } from "node:crypto"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { LocalOperator } from "../../src/im/local-operator"
import { WorkAuthority } from "../../src/session/work-authority"
import { WorkRouteApproval } from "../../src/session/work-route-approval"
import { WorkRouteApprovalSchema } from "../../src/session/work-route-approval.schema"
import { WorkCountAcquisition } from "../../src/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "../../src/session/work-count-acquisition.schema"
import { CanonicalJson } from "../../src/util/canonical-json"
import { IMTaskAuthorityFixture } from "./im-task-authority"
import { WorkAuthorityFixture } from "./work-authority"

export const NOW = 1000
export const runtime = {
  instanceID: "local-fixture",
  installationKeyHash: "1".repeat(64),
  credentialBinding: "2".repeat(64),
}
export const policy = {
  version: 1 as const,
  targets: [
    {
      id: "review",
      locationKey: IMTaskAuthorityFixture.target.location.directory,
      namespaceBindingHash: IMTaskAuthorityFixture.proof.namespaceBindingHash,
      target: {
        ...IMTaskAuthorityFixture.target,
        scope: {
          ...IMTaskAuthorityFixture.target.scope,
          workspaceID: IMTaskAuthorityFixture.target.location.directory,
        },
        provider: {
          ...IMTaskAuthorityFixture.target.provider,
          protocol: "openai-responses",
          modelID: "fixture-snapshot-1",
          endpoint: "https://api.openai.com/v1/responses",
        },
      },
    },
  ],
}
export const evidence: WorkRouteApprovalSchema.Evidence = {
  instanceID: runtime.instanceID,
  operatorID: IMTaskAuthorityFixture.principal.actorID,
  targetID: "review",
  securityNamespaceID: IMTaskAuthorityFixture.proof.securityNamespaceID,
  projectScopeKey: policy.targets[0].target.scope.projectScopeKey,
  locationKey: IMTaskAuthorityFixture.target.location.directory,
  canonicalRoot: policy.targets[0].target.location.directory,
  namespaceBindingHash: IMTaskAuthorityFixture.proof.namespaceBindingHash,
  providerID: policy.targets[0].target.provider.providerID,
  routeID: "approved-responses",
  modelID: "fixture-snapshot-1",
  modelRevision: "fixture-deployment-1",
  protocol: "openai-responses",
  endpoint: "https://api.openai.com/v1/responses",
  counterEndpoint: "https://api.openai.com/v1/responses/input_tokens",
  providerContractID: "controlled-test-contract",
  providerContractHash: "3".repeat(64),
  releaseID: "fixture-only",
  binaryHash: "4".repeat(64),
  componentsHash: "5".repeat(64),
  factoryHash: "6".repeat(64),
  adapterHash: "7".repeat(64),
  loweringHash: "8".repeat(64),
  framingHash: "9".repeat(64),
  tokenizerIdentity: "fixture-counter-1",
  configuredTargetStamp: policy.targets[0].target.provider.configurationHash,
  configurationStamp: "a".repeat(64),
  credentialLocatorStamp: "b".repeat(64),
  credentialFingerprint: "c".repeat(64),
  nonsecretHeadersHash: "d".repeat(64),
  completionLimit: 4096,
  expiresAt: 100_000,
}

// Controlled host boundary only. The test key is independent of production installation keys;
// arbitrary JSON has no capture provenance, and no fixture service is installed in production.
export function authority(key = randomBytes(32)) {
  const captures = new WeakMap<object, WorkRouteApprovalSchema.Evidence>()
  const capture = (input = evidence) => {
    const token = Object.freeze({})
    captures.set(token, input)
    return token
  }
  const state = { failSign: false, reads: 0, captured: 0, denyCapture: false }
  const routeMac = (record: WorkRouteApprovalSchema.Record) =>
    createHmac("sha256", key)
      .update("controlled-fixture-route.v1\0")
      .update(CanonicalJson.stringify(record))
      .digest("hex")
  const countMac = (record: WorkCountAcquisitionSchema.Record) =>
    createHmac("sha256", key)
      .update("controlled-fixture-count.v1\0")
      .update(CanonicalJson.stringify(record))
      .digest("hex")
  const route = Layer.succeed(WorkRouteApproval.Authority, {
    captured: (handle) =>
      Effect.suspend(() => {
        state.captured++
        const value = captures.get(handle)
        return value && !state.denyCapture
          ? Effect.succeed(value)
          : Effect.fail(WorkRouteApproval.failure("NATIVE_OBSERVATION_REQUIRED"))
      }),
    authenticate: (record) =>
      state.failSign
        ? Effect.fail(WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE"))
        : Effect.succeed(routeMac(record)),
    verify: (record, mac) =>
      Effect.suspend(() => {
        state.reads++
        return routeMac(record) === mac ? Effect.void : Effect.fail(WorkRouteApproval.failure("ROUTE_INVALID_RECORD"))
      }),
  })
  const count = Layer.succeed(WorkCountAcquisition.Authority, {
    requireCapture: () =>
      state.denyCapture ? Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")) : Effect.void,
    authenticate: (record) =>
      state.failSign
        ? Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE"))
        : Effect.succeed(countMac(record)),
    verify: (record, mac) =>
      countMac(record) === mac ? Effect.void : Effect.fail(WorkCountAcquisition.failure("COUNT_INVALID_RECORD")),
  })
  return { capture, state, route, count }
}

export const initialize = Effect.gen(function* () {
  yield* IMTaskAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  yield* db.run(
    sql`UPDATE context_location_identity SET location_key=${IMTaskAuthorityFixture.target.location.directory}`,
  )
  yield* LocalOperator.enroll(db, {
    operationID: "enroll",
    operatorID: evidence.operatorID,
    username: "fixture",
    credentialVerifier: "$argon2id$controlled-fixture-not-a-login",
    policy,
    now: NOW,
  })
})
export const approve = (capture: object) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
    return yield* WorkRouteApproval.approve(db, {
      capture,
      requestID: "approve",
      expectedRevision: 0,
      expectedOperatorRevision: 1,
      now: NOW,
    }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
  })
export function workWith(options: { now?: number; approvalExpiry?: number } = {}) {
  return Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const target = operator.policy.targets[0].target
  const binding = {
    ...WorkAuthorityFixture.binding("count"),
    scope: target.scope,
    location: target.location,
    provider: target.provider,
    deadline: options.approvalExpiry ?? 100_000,
  }
  yield* db.run(
    sql`INSERT INTO test_work_route VALUES (${binding.provider.evidenceID},${binding.provider.evidenceHash},${binding.provider.configurationHash},1)`,
  )
  const reserved = yield* WorkAuthority.reserve(db, { binding, now: options.now ?? NOW })
  yield* WorkAuthorityFixture.materialize(binding)
  yield* db.run(sql`UPDATE session_input SET promoted_seq=2 WHERE id=${binding.inputID}`)
  const approval = yield* WorkRouteApproval.get(db, binding.provider.evidenceID)
  if (!approval) return yield* Effect.die("fixture missing approval")
  const input = {
    workID: binding.workID,
    inputID: binding.inputID,
    sessionID: binding.sessionID,
    bindingHash: reserved.binding_hash,
    controlRevision: 1,
    sourceAuthorityID: binding.source.authorityID,
    sourceRevision: reserved.source_revision,
    sourceRecordHash: reserved.source_record_hash,
    providerReceiptID: `receipt-${binding.workID}`,
    providerAttemptID: binding.attemptKey,
    sessionClaimToken: 7,
    providerOwnerToken: `owner-${binding.workID}`,
    approvalID: approval.approvalID,
    approvalRevision: approval.revision,
    approvalEvidenceHash: approval.evidenceHash,
    configurationStamp: approval.evidence.configurationStamp,
    credentialFingerprint: approval.evidence.credentialFingerprint,
    credentialGeneration: approval.credentialGeneration,
    inputTupleHash: "1".repeat(64),
    countBodyHash: "2".repeat(64),
    generationBodyHash: "3".repeat(64),
    wireHash: "4".repeat(64),
    nonsecretHeadersHash: approval.evidence.nonsecretHeadersHash,
  }
  return { ...input, sealedRequestHash: WorkCountAcquisition.sealedRequestHash(input) }
})

}
export const work = workWith()

export function commandIdentity(
  action: "approve" | "revoke",
  expectedRevision: number,
  expectedOperatorRevision: number,
): WorkRouteApprovalSchema.CommandIdentity {
  const common = {
    version: 1 as const,
    instanceID: evidence.instanceID,
    operatorID: evidence.operatorID,
    targetID: evidence.targetID,
    expectedRevision,
    expectedOperatorRevision,
  }
  return action === "approve"
    ? { ...common, action, snapshot: evidence.modelID, expiresAt: evidence.expiresAt }
    : { ...common, action, snapshot: null, expiresAt: null }
}
