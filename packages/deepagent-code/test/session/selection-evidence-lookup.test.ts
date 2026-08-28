import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { ContextProjection } from "@deepagent-code/core/context-federation/projection"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import {
  SecurityNamespaceTable,
  ProjectScopeIdentityTable,
  LocationIdentityTable,
} from "@deepagent-code/core/context-federation/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { PromptEpoch } from "@/session/prompt-epoch"
import { testEffect } from "../lib/effect"

// §16.3 order 4 package D — the selection evidence provider must return the session's newest
// durable-runtime selection and ignore the V2 runner's own `v2:local` rows (they are not
// federation evidence); a session with only v2:local rows (or none at all) yields undefined so
// the runner keeps the pre-seam local evidence.
const database = Database.layerFromPath(":memory:")
const contexts = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const it = testEffect(Layer.mergeAll(database, contexts))

const sessionID = SessionSchema.ID.make("ses_selection_evidence")
const FED_NAMESPACE = ContextReference.SecurityNamespaceID.make("ns_federation_test")
const FED_SCOPE = ContextReference.ProjectScopeKey.make("scope_federation_test")
const V2_NAMESPACE = ContextReference.SecurityNamespaceID.make("v2:local")
const V2_SCOPE = ContextReference.ProjectScopeKey.make("v2:local")
const locationKey = "/project#"

const commitSelection = (input: {
  readonly contexts: SessionContext.Interface
  readonly activityId: string
  readonly namespace: ContextReference.SecurityNamespaceID
  readonly scope: ContextReference.ProjectScopeKey
  readonly graphRevisions: { readonly code: string; readonly documents: string; readonly knowledge: string; readonly memory: string }
  readonly fingerprint: string
  readonly epoch: number
  readonly now: number
  readonly triggerInputId: SessionMessage.ID
}) =>
  input.contexts.commitSelection({
    securityNamespaceId: input.namespace,
    projectScopeKey: input.scope,
    sessionId: sessionID,
    activityId: input.activityId,
    revision: 0,
    triggerInputId: input.triggerInputId,
    locationKey: ContextReference.LocationKey.make(locationKey),
    promotedInputIds: [input.triggerInputId],
    queryFingerprint: `query_${input.fingerprint}`,
    authorizationFingerprint: `auth_${input.fingerprint}`,
    authorizationEpoch: 0,
    executionFingerprint: `exec_${input.fingerprint}`,
    selectedSourceFingerprint: input.fingerprint,
    observedLocationMutationEpoch: input.epoch,
    nextRevalidationAt: input.now + 60_000,
    releasedKnowledgeBinding: DeepAgentReleasedSnapshot.binding(undefined),
    graphRevisions: input.graphRevisions,
    graphStatuses: [],
    selectedRefs: [],
    rendered: ContextProjection.render({ evidence: [], statuses: [] }),
    artifact: { rankingVersion: "test-v1", rejected: [] },
    now: input.now,
  })

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "selection-evidence",
      directory: "/project",
      title: "selection evidence",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: SessionMessage.ID.make("msg_trigger_sel"),
      session_id: sessionID,
      admitted_seq: 1,
      prompt: new Prompt({ text: "trigger" }),
      delivery: "steer",
      promoted_seq: 1,
      time_created: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: SessionMessage.ID.make("msg_trigger_sel_2"),
      session_id: sessionID,
      admitted_seq: 2,
      prompt: new Prompt({ text: "trigger 2" }),
      delivery: "steer",
      promoted_seq: 2,
      time_created: 2,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  // Identity chains for both namespaces (the insert guard requires them).
  for (const [namespace, scope] of [
    [FED_NAMESPACE, FED_SCOPE],
    [V2_NAMESPACE, V2_SCOPE],
  ] as const) {
    yield* db
      .insert(SecurityNamespaceTable)
      .values({ id: namespace, kind: "implicit_local", binding_hash: `hash_${namespace}`, created_at: 1 })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: namespace,
        project_scope_key: scope,
        project_kind: "registered_root",
        project_identity_hash: `hash_${namespace}_${scope}`,
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: namespace,
        location_key: locationKey,
        project_scope_key: scope,
        canonical_root: locationKey,
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

it.effect("returns the newest durable-runtime selection and ignores v2:local rows", () =>
  Effect.gen(function* () {
    yield* seed
    const sessionContexts = yield* SessionContext.Service
    const databaseService = yield* Database.Service
    // Federation selection committed FIRST (its own activity + trigger input)...
    const activity = yield* sessionContexts.openActivity({
      sessionId: sessionID,
      triggerInputId: SessionMessage.ID.make("msg_trigger_sel"),
    })
    yield* commitSelection({
      contexts: sessionContexts,
      activityId: activity.activityId,
      namespace: FED_NAMESPACE,
      scope: FED_SCOPE,
      graphRevisions: { code: "rev_code_1", documents: "rev_docs_1", knowledge: "rev_k_1", memory: "rev_m_1" },
      fingerprint: "federation_source",
      epoch: 5,
      now: 1000,
      triggerInputId: SessionMessage.ID.make("msg_trigger_sel"),
    })
    yield* sessionContexts.settleActivity({ activityId: activity.activityId, state: "settled" })
    // ...then a NEWER v2:local selection under a fresh activity, which must NOT be picked up.
    const v2Activity = yield* sessionContexts.openActivity({
      sessionId: sessionID,
      triggerInputId: SessionMessage.ID.make("msg_trigger_sel_2"),
    })
    yield* commitSelection({
      contexts: sessionContexts,
      activityId: v2Activity.activityId,
      namespace: V2_NAMESPACE,
      scope: V2_SCOPE,
      graphRevisions: { code: "v2-none", documents: "v2-none", knowledge: "v2-none", memory: "v2-none" },
      fingerprint: "stale_v2_source",
      epoch: 0,
      now: 2000,
      triggerInputId: SessionMessage.ID.make("msg_trigger_sel_2"),
    })
    const evidence = yield* PromptEpoch.selectionEvidenceLookup(databaseService)(sessionID)
    expect(evidence).toEqual({
      graphRevisions: { code: "rev_code_1", documents: "rev_docs_1", knowledge: "rev_k_1", memory: "rev_m_1" },
      selectedSourceFingerprint: "federation_source",
      observedLocationMutationEpoch: 5,
    })
  }),
)

it.effect("yields undefined for sessions without a durable-runtime selection", () =>
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    expect(yield* PromptEpoch.selectionEvidenceLookup(databaseService)(sessionID)).toBeUndefined()
    expect(
      yield* PromptEpoch.selectionEvidenceLookup(databaseService)(SessionSchema.ID.make("ses_never_seen")),
    ).toBeUndefined()
  }),
)
