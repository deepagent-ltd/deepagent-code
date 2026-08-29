/**
 * FEAT-004 — learning closed-loop E2E evidence-chain verification (no real LLM).
 *
 * Covers the cross-run chain that the three lifecycle callers (idle/pause/project_switch)
 * feed into:
 *
 *   Run A finalization artifacts (LEARNING_ADMISSION_RECEIPT.json + DEEPAGENT_RUN_STATE.json)
 *     → runtime observer (same wiring as learning-runtime.ts) → observe(trigger=idle)
 *     → admitted trigger receipt + lifecycle artifact persisted inside the runs directory
 *     → durable learning job enqueued and drained to completion.
 *
 * Then verifies the released-knowledge binding half of the loop:
 *   Run A's released snapshot binding fingerprint stays stable for Run B resolving the SAME
 *   workspace (no new publication), and becomes `unavailable` when Run B resolves a different
 *   workspace / security namespace scope.
 *
 * Fixture policy (QUAL-003): no terminal authority row is ever INSERTed directly — trigger
 * receipts advance through `observe`, learning jobs through `admit`/`drain`, and released
 * snapshots through `DeepAgentReleasedSnapshot.publish`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { count } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentDurableLearning, type Admission } from "@deepagent-code/core/deepagent/durable-learning"
import type { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { DeepAgentLearningLifecycleTrigger } from "@deepagent-code/core/deepagent/learning-lifecycle-trigger"
import { LearningLifecycleTriggerTable } from "@deepagent-code/core/deepagent/learning-lifecycle-trigger.sql"
import { LearningJobTable } from "@deepagent-code/core/deepagent/learning-job.sql"
import {
  DeepAgentReleasedSnapshot,
  type DocumentRef,
  type PublishInput,
  type Scope,
} from "@deepagent-code/core/deepagent/released-snapshot"
import { createInitialRoundState } from "@deepagent-code/core/deepagent/round-state"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"

const SESSION_ID = "ses_lifecycle_e2e"
const RUN_A_ID = "run-lifecycle-e2e-a"
const DATABASE_PROJECT_ID = "project-db-lifecycle-e2e"
const OBSERVED_PROJECT_ID = "project-observed-lifecycle-e2e"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-learning-lifecycle-e2e-"))
})

afterEach(() => {
  DeepAgentLearningLifecycleTrigger.setRuntimeObserver(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe("learning lifecycle closed loop (E2E, no LLM)", () => {
  test("Run A finalization → idle observe → admitted receipt with matching artifact hash persisted in runs dir", async () => {
    const workspace = path.join(root, "workspace")
    const runsDir = path.join(root, "runs")
    mkdirSync(workspace, { recursive: true })
    writeRunAFinalization({ root, workspace })

    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedProjectAndSession(db, workspace)

        // Mirror learning-runtime.ts:54-62 — the server runtime registers the observer that the
        // idle caller (SessionRunState Runner.onIdle) reaches via `notify`.
        DeepAgentLearningLifecycleTrigger.setRuntimeObserver({
          observe: (input) =>
            Effect.runPromise(
              DeepAgentLearningLifecycleTrigger.observe(db, input, { authorityRoot: root, runsDir }),
            ),
        })

        const outcome = yield* Effect.promise(() =>
          DeepAgentLearningLifecycleTrigger.notify({
            trigger: "idle",
            boundaryKey: `session-idle:${SESSION_ID}`,
            sessionID: SESSION_ID,
            match: "session",
          }),
        )
        expect(outcome).toMatchObject({ state: "admitted", runId: RUN_A_ID })

        const receipt = yield* db.select().from(LearningLifecycleTriggerTable).get()
        expect(receipt).toMatchObject({
          trigger: "idle",
          boundary_key: `session-idle:${SESSION_ID}`,
          session_id: SESSION_ID,
          run_id: RUN_A_ID,
          state: "admitted",
        })

        // Artifact hash integrity: row hash === hash of persisted artifact === hash of row JSON.
        const artifactPath = path.join(runsDir, RUN_A_ID, "LEARNING_LIFECYCLE_TRIGGER_IDLE.json")
        expect(existsSync(artifactPath)).toBe(true)
        const artifactContent = yield* Effect.promise(() => Bun.file(artifactPath).text())
        expect(receipt!.artifact_hash).toBe(Hash.sha256(artifactContent))
        expect(receipt!.artifact_hash).toBe(Hash.sha256(receipt!.artifact_json))
        expect(artifactContent).toBe(receipt!.artifact_json)
        expect(receipt!.artifact_path).toBe(artifactPath)

        // Cross-run evidence chain: the lifecycle artifact re-anchors Run A's source receipt,
        // terminal artifact, and admission fingerprint.
        const artifact = JSON.parse(artifactContent)
        expect(artifact).toMatchObject({
          schema_version: "deepagent-code.learning_lifecycle_trigger_receipt.v1",
          trigger: "idle",
          boundary_key: `session-idle:${SESSION_ID}`,
          session_id: SESSION_ID,
          run_id: RUN_A_ID,
          source_session_relation: "session",
          source_admission_path: path.join(runsDir, RUN_A_ID, "LEARNING_ADMISSION_RECEIPT.json"),
          source_terminal_path: path.join(runsDir, RUN_A_ID, "DEEPAGENT_RUN_STATE.json"),
        })
        expect(artifact.source_admission_sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(artifact.source_terminal_sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(artifact.learning_admission_fingerprint).toMatch(/^[0-9a-f]{64}$/)

        // The admitted trigger produced a durable learning job and the worker can drain it.
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
        const completed = yield* DeepAgentDurableLearning.drain(db, {
          owner: "learning-worker-lifecycle-e2e",
          authorityRoot: root,
        })
        expect(completed.length).toBeGreaterThanOrEqual(1)
        expect(completed[0]).toMatchObject({ state: "completed" })

        // Exact-boundary dedupe: a second idle observe for the same boundary is idempotent.
        const retry = yield* DeepAgentLearningLifecycleTrigger.observe(
          db,
          {
            trigger: "idle",
            boundaryKey: `session-idle:${SESSION_ID}`,
            sessionID: SESSION_ID,
            match: "session",
          },
          { authorityRoot: root, runsDir },
        )
        expect(retry).toMatchObject({ state: "admitted", runId: RUN_A_ID })
        expect(yield* db.select({ count: count() }).from(LearningLifecycleTriggerTable).get()).toEqual({ count: 1 })
      }),
    )
  }, 30_000)

  test("Run B in the same workspace binds the identical released-knowledge exact-refs fingerprint", async () => {
    const workspace = path.join(root, "workspace")
    mkdirSync(workspace, { recursive: true })

    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scopeRunA = yield* resolveScope(workspace)
        const released = yield* publishRunAKnowledge(db, scopeRunA)

        // Run A's request-time binding (what session_tool_request_receipt records as
        // released_knowledge_exact_refs_fingerprint).
        const selectionRunA = yield* DeepAgentReleasedSnapshot.current(db, scopeRunA)
        const bindingRunA = DeepAgentReleasedSnapshot.binding(selectionRunA)
        expect(bindingRunA).toMatchObject({ state: "bound", snapshotId: released.snapshotId })

        // Run B resolves the same workspace → identical location identity → identical scope.
        const scopeRunB = yield* resolveScope(workspace)
        expect(scopeRunB.securityNamespaceId).toBe(scopeRunA.securityNamespaceId)
        expect(scopeRunB.projectScopeKey).toBe(scopeRunA.projectScopeKey)

        const selectionRunB = yield* DeepAgentReleasedSnapshot.current(db, scopeRunB)
        const bindingRunB = DeepAgentReleasedSnapshot.binding(selectionRunB)
        expect(bindingRunB.state).toBe("bound")
        expect(bindingRunB.exactRefsFingerprint).toBe(bindingRunA.exactRefsFingerprint)
        expect(bindingRunB.exactRefs).toEqual(bindingRunA.exactRefs)
        expect(DeepAgentReleasedSnapshot.matchesBinding(selectionRunB, bindingRunA)).toBe(true)
      }),
    )
  })

  test("Run B in a different workspace/security namespace gets an unavailable binding", async () => {
    const workspace = path.join(root, "workspace")
    const otherWorkspace = path.join(root, "workspace-other")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(otherWorkspace, { recursive: true })

    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scopeRunA = yield* resolveScope(workspace)
        yield* publishRunAKnowledge(db, scopeRunA)
        const bindingRunA = DeepAgentReleasedSnapshot.binding(yield* DeepAgentReleasedSnapshot.current(db, scopeRunA))
        expect(bindingRunA.state).toBe("bound")

        // Workspace switch: a different canonical root derives a different location/project scope,
        // so no released head exists there.
        const scopeOther = yield* resolveScope(otherWorkspace)
        expect(`${scopeOther.securityNamespaceId}:${scopeOther.projectScopeKey}`).not.toBe(
          `${scopeRunA.securityNamespaceId}:${scopeRunA.projectScopeKey}`,
        )
        const selectionOther = yield* DeepAgentReleasedSnapshot.current(db, scopeOther)
        expect(selectionOther).toBeUndefined()
        const bindingOther = DeepAgentReleasedSnapshot.binding(selectionOther)
        expect(bindingOther).toMatchObject({ state: "unavailable", exactRefs: [] })
        expect(bindingOther.exactRefsFingerprint).not.toBe(bindingRunA.exactRefsFingerprint)

        // Security-namespace switch: even with Run A's project scope key, a foreign namespace
        // resolves nothing.
        const foreignNamespace: Scope = {
          securityNamespaceId: "sec_foreign_lifecycle_e2e",
          projectScopeKey: scopeRunA.projectScopeKey,
          legacyProjectId: scopeRunA.legacyProjectId,
        }
        expect(yield* DeepAgentReleasedSnapshot.current(db, foreignNamespace)).toBeUndefined()
        expect(DeepAgentReleasedSnapshot.binding(undefined)).toMatchObject({
          state: "unavailable",
          exactRefs: [],
        })
      }),
    )
  })

  test("unregistered observer (pure CLI path) skips silently without a defect", async () => {
    DeepAgentLearningLifecycleTrigger.setRuntimeObserver(undefined)

    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db

        // Mirrors SessionRunState/goal-driver/instance-store: notify is always awaited through
        // Effect.ignore, so an unregistered observer must resolve — never reject or defect.
        // FEAT-004: the unregistered-observer skip is its OWN reason code — distinct from an
        // observer that ran but found no matching settled run (`no_exact_settled_run`).
        const idle = yield* Effect.promise(() =>
          DeepAgentLearningLifecycleTrigger.notify({
            trigger: "idle",
            boundaryKey: `session-idle:${SESSION_ID}`,
            sessionID: SESSION_ID,
            match: "session",
          }),
        )
        expect(idle).toEqual({ state: "skipped", reason: "no_observer_registered" })

        const projectSwitch = yield* Effect.promise(() =>
          DeepAgentLearningLifecycleTrigger.notify({
            trigger: "project_switch",
            boundaryKey: `project-switch:${path.join(root, "workspace")}`,
            directory: path.join(root, "workspace"),
          }),
        ).pipe(Effect.ignore)
        expect(projectSwitch).toBeUndefined()

        expect(yield* db.select({ count: count() }).from(LearningLifecycleTriggerTable).get()).toEqual({ count: 0 })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
      }),
    )
  })
})

function run<A, E>(effect: Effect.Effect<A, E, Database.Service | LocationIdentity.Service>) {
  const database = Database.layerFromPath(":memory:")
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.merge(database, LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
      ),
      Effect.scoped,
    ),
  )
}

/**
 * Writes Run A's session-finalization products through the same legitimate path the gateway
 * uses: a fingerprint-bound terminal artifact plus a `submitted` local admission receipt.
 */
function writeRunAFinalization(input: { readonly root: string; readonly workspace: string }) {
  const runDir = path.join(input.root, "runs", RUN_A_ID)
  const terminalPath = path.join(runDir, "DEEPAGENT_RUN_STATE.json")
  const receiptPath = path.join(runDir, "LEARNING_ADMISSION_RECEIPT.json")
  mkdirSync(runDir, { recursive: true })
  const admission: Admission = {
    baseDir: input.root,
    workspacePath: input.workspace,
    rejectedBufferDir: path.join(input.root, "memory"),
    terminalArtifact: {
      schema_version: "deepagent-code.learning_terminal_artifact.v1",
      path: terminalPath,
      sha256: "0".repeat(64),
      learning_admission_fingerprint: "0".repeat(64),
    },
    input: {
      projectID: "requested-project",
      sessionID: SESSION_ID,
      runID: RUN_A_ID,
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "session_finalization",
      policy: "auto_merge_safe_project",
    },
  }
  const fingerprint = DeepAgentDurableLearning.admissionFingerprint(admission)
  const terminal = CanonicalJson.stringify({
    schema_version: "deepagent_global_run_state.v1",
    run_id: RUN_A_ID,
    generic_agent_session_id: SESSION_ID,
    parent_generic_agent_session_id: null,
    goal_id: null,
    agent_mode: "high",
    state: "completed",
    updated_at: "2026-08-14T00:00:00.000Z",
    learning_admission_fingerprint: fingerprint,
  })
  const bound: Admission = {
    ...admission,
    terminalArtifact: {
      ...admission.terminalArtifact,
      sha256: Hash.sha256(terminal),
      learning_admission_fingerprint: fingerprint,
    },
  }
  writeFileSync(terminalPath, terminal)
  writeFileSync(receiptPath, CanonicalJson.stringify(DeepAgentDurableLearning.localAdmissionReceipt(bound, "submitted")))
}

function seedProjectAndSession(db: Database.Interface["db"], workspace: string) {
  return Effect.gen(function* () {
    yield* db.insert(ProjectTable).values({
      id: Project.ID.make(DATABASE_PROJECT_ID),
      worktree: AbsolutePath.make(workspace),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    })
    yield* db.insert(SessionTable).values({
      id: SessionSchema.ID.make(SESSION_ID),
      project_id: Project.ID.make(DATABASE_PROJECT_ID),
      slug: SESSION_ID,
      directory: workspace,
      title: SESSION_ID,
      version: "1",
      time_created: 1,
      time_updated: 1,
    })
  })
}

const resolveScope = (directory: string) =>
  Effect.gen(function* () {
    const identity = yield* (yield* LocationIdentity.Service).resolve({
      boundary: { kind: "implicit_local" },
      directory: AbsolutePath.make(directory),
      project: { kind: "registered_root", observedProjectId: OBSERVED_PROJECT_ID },
    })
    return {
      securityNamespaceId: identity.securityNamespaceId,
      projectScopeKey: identity.projectScopeKey,
      legacyProjectId: OBSERVED_PROJECT_ID,
    } as Scope
  })

/**
 * Publishes Run A's released knowledge through the legal publication path:
 * an empty legacy baseline followed by an evaluated release of one durable document.
 */
function publishRunAKnowledge(db: Database.Interface["db"], scope: Scope) {
  return Effect.gen(function* () {
    const releasedDoc = document("knowledge-lifecycle-e2e", 1, scope.legacyProjectId)
    const authority = documentAuthority([releasedDoc])
    const baseline = yield* DeepAgentReleasedSnapshot.publish(
      db,
      publishInput({
        snapshotId: "snapshot_lifecycle_e2e_baseline",
        evaluationId: "evaluation_lifecycle_e2e_baseline",
        scope,
        releaseKind: "legacy_baseline",
        documents: [],
        now: 10,
      }),
      authority,
    )
    if (!baseline) return yield* Effect.die("baseline release is unavailable")
    const released = yield* DeepAgentReleasedSnapshot.publish(
      db,
      publishInput({
        snapshotId: "snapshot_lifecycle_e2e_run_a",
        evaluationId: "evaluation_lifecycle_e2e_run_a",
        scope,
        expectedParentSnapshotId: baseline.snapshotId,
        expectedGeneration: baseline.generation,
        releaseKind: "evaluated",
        documents: [releasedDoc],
        now: 20,
      }),
      authority,
    )
    if (!released) return yield* Effect.die("Run A release is unavailable")
    return released
  })
}

function publishInput(
  value: Pick<PublishInput, "snapshotId" | "evaluationId" | "scope" | "documents"> & Partial<PublishInput>,
): PublishInput {
  return {
    expectedParentSnapshotId: null,
    expectedGeneration: 0,
    releaseKind: "evaluated",
    verdict: "passed",
    evaluationMatrix: { source: "learning-lifecycle-e2e" },
    baselineRef: "learning-lifecycle-e2e",
    repetitions: 1,
    actor: { type: "system", id: "learning-lifecycle-e2e" },
    ...value,
  }
}

function document(id: string, version: number, legacyProjectId: string): DocumentRef {
  return {
    sourceStore: "project",
    id,
    version,
    hash: `sha256:${Hash.sha256(`${id}:${version}`)}`,
    type: "knowledge",
    scope: `durable:project:${legacyProjectId}`,
  }
}

function documentAuthority(documents: readonly DocumentRef[]) {
  const refs = new Map(documents.map((ref) => [`${ref.sourceStore}:${ref.id}@${ref.version}`, ref]))
  const store = (sourceStore: DocumentRef["sourceStore"]) =>
    ({
      get: (id: string, version?: number) => {
        const ref = refs.get(`${sourceStore}:${id}@${version}`)
        return ref ? storedDocument(ref) : null
      },
    }) as unknown as DocumentStore
  return { userGlobal: store("user_global"), project: store("project") }
}

function storedDocument(ref: DocumentRef) {
  return {
    id: ref.id,
    type: ref.type,
    scope: ref.scope,
    status: "active",
    version: ref.version,
    superseded_by: null,
    hash: ref.hash,
    created_round: null,
    domain: null,
    tags: [],
    description: ref.id,
    provenance: { source: "human" },
    links: [],
    confidence: { evidence_strength: "strong", support_count: 1 },
    body: `${ref.id}@${ref.version}`,
  }
}
