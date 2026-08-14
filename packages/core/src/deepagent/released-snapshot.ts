export * as DeepAgentReleasedSnapshot from "./released-snapshot"

import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { Doc, DocType, DocumentStore } from "./document-store"
import {
  ReleasedKnowledgeEvaluationTable,
  ReleasedKnowledgeSnapshotDocumentTable,
  ReleasedKnowledgeSnapshotHeadTable,
  ReleasedKnowledgeSnapshotTable,
} from "./released-snapshot.sql"

type DatabaseClient = Database.Interface["db"]
type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]
const ReleasedDocumentTypes: ReadonlySet<DocType> = new Set(["knowledge", "strategy", "methodology", "memory", "skill"])

export type Scope = {
  readonly securityNamespaceId: string
  readonly projectScopeKey: string
  readonly legacyProjectId: string
}

export type DocumentRef = {
  readonly sourceStore: "user_global" | "project"
  readonly id: string
  readonly version: number
  readonly hash: string
  readonly type: DocType
  readonly scope: string
}

export type Selection = Scope & {
  readonly snapshotId: string
  readonly parentSnapshotId: string | null
  readonly generation: number
  readonly membershipHash: string
  readonly manifestHash: string
  readonly documents: readonly DocumentRef[]
}

export type Binding =
  | {
      readonly state: "bound"
      readonly snapshotId: string
      readonly generation: number
      readonly membershipHash: string
      readonly manifestHash: string
      readonly exactRefs: readonly DocumentRef[]
      readonly exactRefsFingerprint: string
    }
  | {
      readonly state: "unavailable"
      readonly exactRefs: readonly []
      readonly exactRefsFingerprint: string
    }

export type StoredBindingState = Binding["state"] | "legacy_unbound"

export type PublishInput = {
  readonly snapshotId: string
  readonly evaluationId: string
  readonly scope: Scope
  readonly expectedParentSnapshotId: string | null
  readonly expectedGeneration: number
  readonly releaseKind: "legacy_baseline" | "evaluated" | "rollback"
  readonly verdict: "passed" | "failed"
  readonly failureReason?: string
  readonly documents: readonly DocumentRef[]
  readonly evaluationMatrix: unknown
  readonly baselineRef: string
  readonly repetitions: number
  readonly actor: { readonly type: "human" | "agent" | "system"; readonly id: string }
  readonly now?: number
}

export type RevokeInput = {
  readonly scope: Scope
  readonly expectedParent: Selection
  readonly document: DocumentRef
  readonly actor: PublishInput["actor"]
  readonly now?: number
}

type ExactDocumentIdentity = Pick<DocumentRef, "sourceStore" | "id" | "version" | "hash">

export type Revocation = {
  readonly state: "revoked" | "already_revoked"
  readonly previousSnapshotId: string
  readonly selection: Selection
}

export type DocumentAuthority = {
  readonly userGlobal: Pick<DocumentStore, "get">
  readonly project: Pick<DocumentStore, "get">
}

export class SnapshotConflictError extends Schema.TaggedErrorClass<SnapshotConflictError>()(
  "DeepAgentReleasedSnapshot.SnapshotConflictError",
  {
    expectedParentSnapshotId: Schema.NullOr(Schema.String),
    actualParentSnapshotId: Schema.NullOr(Schema.String),
    expectedGeneration: Schema.Int,
    actualGeneration: Schema.Int,
  },
) {}

export class SnapshotIdentityConflictError extends Schema.TaggedErrorClass<SnapshotIdentityConflictError>()(
  "DeepAgentReleasedSnapshot.SnapshotIdentityConflictError",
  { snapshotId: Schema.String },
) {}

export class SnapshotDocumentError extends Schema.TaggedErrorClass<SnapshotDocumentError>()(
  "DeepAgentReleasedSnapshot.SnapshotDocumentError",
  { docId: Schema.String, reason: Schema.String },
) {}

export class SnapshotInputError extends Schema.TaggedErrorClass<SnapshotInputError>()(
  "DeepAgentReleasedSnapshot.SnapshotInputError",
  { field: Schema.String, reason: Schema.String },
) {}

export class SnapshotIntegrityError extends Schema.TaggedErrorClass<SnapshotIntegrityError>()(
  "DeepAgentReleasedSnapshot.SnapshotIntegrityError",
  { snapshotId: Schema.String, docId: Schema.String, reason: Schema.String },
) {}

export type Error =
  | SnapshotConflictError
  | SnapshotIdentityConflictError
  | SnapshotDocumentError
  | SnapshotInputError
  | SnapshotIntegrityError

export const documentRef = (doc: Doc, sourceStore: DocumentRef["sourceStore"]): DocumentRef => ({
  sourceStore,
  id: doc.id,
  version: doc.version,
  hash: doc.hash,
  type: doc.type,
  scope: doc.scope,
})

export function binding(selection: Selection | undefined): Binding {
  if (!selection) {
    const exactRefs = [] as const
    return {
      state: "unavailable",
      exactRefs,
      exactRefsFingerprint: exactRefsFingerprint(exactRefs),
    }
  }
  const exactRefs = normalizeDocumentRefs(selection.documents)
  return {
    state: "bound",
    snapshotId: selection.snapshotId,
    generation: selection.generation,
    membershipHash: selection.membershipHash,
    manifestHash: selection.manifestHash,
    exactRefs,
    exactRefsFingerprint: exactRefsFingerprint(exactRefs),
  }
}

export function exactRefsFingerprint(documents: readonly DocumentRef[]) {
  return Hash.sha256(CanonicalJson.stringify(normalizeDocumentRefs(documents)))
}

export function normalizeDocumentRefs(documents: readonly DocumentRef[]) {
  const byAuthority = new Map(documents.map((document) => [`${document.sourceStore}:${document.id}`, document]))
  return [...byAuthority.values()].sort(compareDocumentRefs)
}

export function matchesBinding(selection: Selection | undefined, expected: Binding) {
  const actual = binding(selection)
  return CanonicalJson.stringify(actual) === CanonicalJson.stringify(expected)
}

export function decodeSelection(input: unknown): Selection | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  if (
    typeof value.snapshotId !== "string" ||
    typeof value.securityNamespaceId !== "string" ||
    typeof value.projectScopeKey !== "string" ||
    typeof value.legacyProjectId !== "string" ||
    (value.parentSnapshotId !== null && typeof value.parentSnapshotId !== "string") ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !isHash(value.membershipHash) ||
    !isHash(value.manifestHash) ||
    !Array.isArray(value.documents)
  )
    return undefined
  const documents = value.documents.flatMap((item): DocumentRef[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const document = item as Record<string, unknown>
    if (
      (document.sourceStore !== "user_global" && document.sourceStore !== "project") ||
      typeof document.id !== "string" ||
      !Number.isSafeInteger(document.version) ||
      (document.version as number) < 1 ||
      typeof document.hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(document.hash) ||
      typeof document.type !== "string" ||
      !ReleasedDocumentTypes.has(document.type as DocType) ||
      typeof document.scope !== "string"
    )
      return []
    return [
      {
        sourceStore: document.sourceStore,
        id: document.id,
        version: document.version as number,
        hash: document.hash,
        type: document.type as DocType,
        scope: document.scope,
      },
    ]
  })
  if (documents.length !== value.documents.length) return undefined
  const normalized = documents.toSorted(compareDocumentRefs)
  if (new Set(normalized.map((document) => `${document.sourceStore}:${document.id}`)).size !== normalized.length) {
    return undefined
  }
  if (
    normalized.some(
      (document) =>
        document.scope !==
        (document.sourceStore === "user_global" ? "durable" : `durable:project:${value.legacyProjectId}`),
    ) ||
    Hash.sha256(CanonicalJson.stringify(normalized)) !== value.membershipHash
  ) {
    return undefined
  }
  return {
    snapshotId: value.snapshotId,
    securityNamespaceId: value.securityNamespaceId,
    projectScopeKey: value.projectScopeKey,
    legacyProjectId: value.legacyProjectId,
    parentSnapshotId: value.parentSnapshotId as string | null,
    generation: value.generation as number,
    membershipHash: value.membershipHash,
    manifestHash: value.manifestHash,
    documents: normalized,
  }
}

export const publish = Effect.fn("DeepAgentReleasedSnapshot.publish")(function* (
  db: DatabaseClient,
  input: PublishInput,
  authority: DocumentAuthority,
) {
  yield* validatePublishInput(input)
  const documents = yield* Effect.try({
    try: () => validateDocuments(input.scope, input.documents, authority),
    catch: (error) =>
      error instanceof SnapshotDocumentError
        ? error
        : new SnapshotDocumentError({
            docId: "<selection>",
            reason: error instanceof Error ? error.message : String(error),
          }),
  })
  if (input.releaseKind === "evaluated" && input.verdict === "passed" && documents.length === 0) {
    return yield* new SnapshotInputError({
      field: "documents",
      reason: "a passing evaluated release must contain at least one exact document revision",
    })
  }
  const matrixJson = CanonicalJson.stringify(input.evaluationMatrix)
  const matrixHash = Hash.sha256(matrixJson)
  const documentManifestJson = CanonicalJson.stringify(documents)
  const membershipHash = Hash.sha256(documentManifestJson)
  const manifestHash = Hash.sha256(
    CanonicalJson.stringify({
      scope: input.scope,
      evaluationId: input.evaluationId,
      parentSnapshotId: input.expectedParentSnapshotId,
      expectedGeneration: input.expectedGeneration,
      releaseKind: input.releaseKind,
      verdict: input.verdict,
      failureReason: input.failureReason ?? null,
      membershipHash,
      matrixHash,
      baselineRef: input.baselineRef,
      repetitions: input.repetitions,
      actor: input.actor,
    }),
  )
  const now = input.now ?? Date.now()

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select({
            securityNamespaceId: ReleasedKnowledgeSnapshotTable.security_namespace_id,
            projectScopeKey: ReleasedKnowledgeSnapshotTable.project_scope_key,
            verdict: ReleasedKnowledgeSnapshotTable.verdict,
            parentSnapshotId: ReleasedKnowledgeSnapshotTable.parent_snapshot_id,
          })
          .from(ReleasedKnowledgeSnapshotTable)
          .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, input.snapshotId))
          .get()
        if (existing) {
          if (
            existing.securityNamespaceId !== input.scope.securityNamespaceId ||
            existing.projectScopeKey !== input.scope.projectScopeKey
          ) {
            return yield* new SnapshotIdentityConflictError({ snapshotId: input.snapshotId })
          }
          if ((yield* requireSnapshotAuthority(tx, input.scope, input.snapshotId)).manifestHash !== manifestHash) {
            return yield* new SnapshotIdentityConflictError({ snapshotId: input.snapshotId })
          }
          return yield* requireSelection(
            tx,
            input.scope,
            existing.verdict === "passed" ? input.snapshotId : existing.parentSnapshotId,
          )
        }

        yield* ensureHead(tx, input.scope, now)
        const head = yield* requireHead(tx, input.scope)
        if (
          (head.snapshot_id ?? null) !== input.expectedParentSnapshotId ||
          head.generation !== input.expectedGeneration
        ) {
          return yield* new SnapshotConflictError({
            expectedParentSnapshotId: input.expectedParentSnapshotId,
            actualParentSnapshotId: head.snapshot_id ?? null,
            expectedGeneration: input.expectedGeneration,
            actualGeneration: head.generation,
          })
        }

        yield* tx
          .insert(ReleasedKnowledgeEvaluationTable)
          .values({
            evaluation_id: input.evaluationId,
            security_namespace_id: input.scope.securityNamespaceId,
            project_scope_key: input.scope.projectScopeKey,
            matrix_hash: matrixHash,
            matrix_json: matrixJson,
            document_manifest_json: documentManifestJson,
            baseline_ref: input.baselineRef,
            repetitions: input.repetitions,
            evaluator_type: input.actor.type,
            evaluator_id: input.actor.id,
            created_at: now,
          })
          .run()
        yield* tx
          .insert(ReleasedKnowledgeSnapshotTable)
          .values({
            snapshot_id: input.snapshotId,
            security_namespace_id: input.scope.securityNamespaceId,
            project_scope_key: input.scope.projectScopeKey,
            legacy_project_id: input.scope.legacyProjectId,
            parent_snapshot_id: input.expectedParentSnapshotId,
            evaluation_id: input.evaluationId,
            release_kind: input.releaseKind,
            document_count: documents.length,
            published_generation: input.verdict === "passed" ? head.generation + 1 : head.generation,
            verdict: input.verdict,
            failure_reason: input.failureReason,
            actor_type: input.actor.type,
            actor_id: input.actor.id,
            created_at: now,
          })
          .run()
        if (documents.length > 0) {
          yield* tx
            .insert(ReleasedKnowledgeSnapshotDocumentTable)
            .values(
              documents.map((document, ordinal) => ({
                snapshot_id: input.snapshotId,
                ordinal,
                source_store: document.sourceStore,
                doc_id: document.id,
                doc_version: document.version,
                doc_hash: document.hash,
                doc_type: document.type,
                doc_scope: document.scope,
              })),
            )
            .run()
        }
        const finalized = yield* tx
          .update(ReleasedKnowledgeSnapshotTable)
          .set({ finalized_at: now })
          .where(
            and(
              eq(ReleasedKnowledgeSnapshotTable.snapshot_id, input.snapshotId),
              isNull(ReleasedKnowledgeSnapshotTable.finalized_at),
            ),
          )
          .returning({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
          .get()
        if (!finalized) return yield* Effect.die(`released snapshot could not be finalized: ${input.snapshotId}`)
        if (input.verdict === "passed") {
          const updated = yield* tx
            .update(ReleasedKnowledgeSnapshotHeadTable)
            .set({ snapshot_id: input.snapshotId, generation: head.generation + 1, updated_at: now })
            .where(
              and(
                eq(ReleasedKnowledgeSnapshotHeadTable.security_namespace_id, input.scope.securityNamespaceId),
                eq(ReleasedKnowledgeSnapshotHeadTable.project_scope_key, input.scope.projectScopeKey),
                head.snapshot_id
                  ? eq(ReleasedKnowledgeSnapshotHeadTable.snapshot_id, head.snapshot_id)
                  : isNull(ReleasedKnowledgeSnapshotHeadTable.snapshot_id),
                eq(ReleasedKnowledgeSnapshotHeadTable.generation, input.expectedGeneration),
              ),
            )
            .returning({ snapshotId: ReleasedKnowledgeSnapshotHeadTable.snapshot_id })
            .get()
          if (!updated) {
            const actual = yield* requireHead(tx, input.scope)
            return yield* new SnapshotConflictError({
              expectedParentSnapshotId: input.expectedParentSnapshotId,
              actualParentSnapshotId: actual.snapshot_id ?? null,
              expectedGeneration: input.expectedGeneration,
              actualGeneration: actual.generation,
            })
          }
        }
        return yield* requireSelection(
          tx,
          input.scope,
          input.verdict === "passed" ? input.snapshotId : input.expectedParentSnapshotId,
        )
      }),
    { behavior: "immediate" },
  )
})

export const current = Effect.fn("DeepAgentReleasedSnapshot.current")(function* (db: DatabaseClient, scope: Scope) {
  const head = yield* db
    .select()
    .from(ReleasedKnowledgeSnapshotHeadTable)
    .where(
      and(
        eq(ReleasedKnowledgeSnapshotHeadTable.security_namespace_id, scope.securityNamespaceId),
        eq(ReleasedKnowledgeSnapshotHeadTable.project_scope_key, scope.projectScopeKey),
      ),
    )
    .get()
  if (!head?.snapshot_id) return undefined
  return yield* requireSelection(db, scope, head.snapshot_id, head.generation)
})

export const get = Effect.fn("DeepAgentReleasedSnapshot.get")(function* (
  db: DatabaseClient,
  scope: Scope,
  snapshotId: string,
) {
  return yield* requireSelection(db, scope, snapshotId)
})

export function mergeDocuments(
  parent: readonly DocumentRef[],
  additions: readonly DocumentRef[],
): readonly DocumentRef[] {
  const additionAuthorities = new Set<string>()
  additions.forEach((document) => {
    const key = `${document.sourceStore}:${document.id}`
    if (additionAuthorities.has(key)) {
      throw new SnapshotDocumentError({
        docId: document.id,
        reason: "release additions contain duplicate document authority",
      })
    }
    additionAuthorities.add(key)
  })
  const byAuthority = new Map(parent.map((document) => [`${document.sourceStore}:${document.id}`, document]))
  additions.forEach((document) => byAuthority.set(`${document.sourceStore}:${document.id}`, document))
  return [...byAuthority.values()].sort(compareDocumentRefs)
}

export const revoke = Effect.fn("DeepAgentReleasedSnapshot.revoke")(function* (
  db: DatabaseClient,
  input: RevokeInput,
  authority: DocumentAuthority,
) {
  const parent = yield* get(db, input.scope, input.expectedParent.snapshotId)
  if (!parent || CanonicalJson.stringify(parent) !== CanonicalJson.stringify(input.expectedParent)) {
    return yield* new SnapshotIntegrityError({
      snapshotId: input.expectedParent.snapshotId,
      docId: "<selection>",
      reason: "revocation parent does not match the durable released snapshot authority",
    })
  }
  const document = parent.documents.find(
    (candidate) =>
      candidate.sourceStore === input.document.sourceStore &&
      candidate.id === input.document.id &&
      candidate.version === input.document.version &&
      candidate.hash === input.document.hash,
  )
  if (!document || CanonicalJson.stringify(document) !== CanonicalJson.stringify(input.document)) {
    return yield* new SnapshotDocumentError({
      docId: input.document.id,
      reason: "released parent does not contain the exact document revision being revoked",
    })
  }
  const revocationFingerprint = revocationFingerprintFor(input.scope, parent, document, input.actor)
  const selection = yield* publish(
    db,
    {
      snapshotId: `snapshot_revocation_${revocationFingerprint}`,
      evaluationId: `evaluation_revocation_${revocationFingerprint}`,
      scope: input.scope,
      expectedParentSnapshotId: parent.snapshotId,
      expectedGeneration: parent.generation,
      releaseKind: "rollback",
      verdict: "passed",
      documents: parent.documents.filter(
        (candidate) =>
          candidate.sourceStore !== document.sourceStore ||
          candidate.id !== document.id ||
          candidate.version !== document.version ||
          candidate.hash !== document.hash,
      ),
      evaluationMatrix: {
        kind: "human_review_rejection",
        rejectedDocument: document,
        parentMembershipHash: parent.membershipHash,
      },
      baselineRef: `human-review-rejection:${revocationFingerprint}`,
      repetitions: 1,
      actor: input.actor,
      ...(input.now === undefined ? {} : { now: input.now }),
    },
    authority,
  )
  if (!selection) return yield* Effect.die("passing released knowledge revocation did not produce a selection")
  const active = yield* current(db, input.scope)
  if (!active) return yield* Effect.die("released knowledge head disappeared after revocation")
  if (active.snapshotId !== selection.snapshotId) {
    if (
      active.documents.some(
        (candidate) =>
          candidate.sourceStore === document.sourceStore &&
          candidate.id === document.id &&
          candidate.version === document.version &&
          candidate.hash === document.hash,
      )
    ) {
      return yield* new SnapshotConflictError({
        expectedParentSnapshotId: parent.snapshotId,
        actualParentSnapshotId: active.snapshotId,
        expectedGeneration: parent.generation,
        actualGeneration: active.generation,
      })
    }
    return {
      state: "already_revoked",
      previousSnapshotId: parent.snapshotId,
      selection: active,
    } satisfies Revocation
  }
  return {
    state: "revoked",
    previousSnapshotId: parent.snapshotId,
    selection,
  } satisfies Revocation
})

export const findRevocation = Effect.fn("DeepAgentReleasedSnapshot.findRevocation")(function* (
  db: DatabaseClient,
  input: {
    readonly scope: Scope
    readonly document: ExactDocumentIdentity
    readonly actor: PublishInput["actor"]
  },
) {
  const selection = yield* current(db, input.scope)
  if (!selection) return undefined
  if (
    selection.documents.some(
      (document) =>
        document.sourceStore === input.document.sourceStore &&
        document.id === input.document.id &&
        document.version === input.document.version &&
        document.hash === input.document.hash,
    )
  )
    return undefined
  const prefix = revocationPrefixFor(input.scope, input.document, input.actor)
  const existing = yield* db
    .select({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
    .from(ReleasedKnowledgeSnapshotTable)
    .where(
      sql`substr(${ReleasedKnowledgeSnapshotTable.snapshot_id}, 1, ${`snapshot_revocation_${prefix}_`.length}) = ${`snapshot_revocation_${prefix}_`}`,
    )
    .all()
  const receipt = yield* Effect.forEach(existing, (row) => requireSelection(db, input.scope, row.snapshotId))
  const revocation = receipt.find((candidate) => candidate !== undefined)
  if (!revocation) return undefined
  if (!revocation.parentSnapshotId) {
    return yield* Effect.die(`released knowledge revocation has no parent: ${revocation.snapshotId}`)
  }
  return {
    state: "already_revoked",
    previousSnapshotId: revocation.parentSnapshotId,
    selection,
  } satisfies Revocation
})

function validateDocuments(scope: Scope, input: readonly DocumentRef[], authority: DocumentAuthority) {
  const byAuthority = new Map<string, DocumentRef>()
  input.forEach((document) => {
    if (!Number.isSafeInteger(document.version) || document.version < 1) {
      throw new SnapshotDocumentError({ docId: document.id, reason: "version must be a positive integer" })
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(document.hash)) {
      throw new SnapshotDocumentError({ docId: document.id, reason: "hash must be a sha256 document hash" })
    }
    if (!ReleasedDocumentTypes.has(document.type)) {
      throw new SnapshotDocumentError({
        docId: document.id,
        reason: `document type ${document.type} is not releasable`,
      })
    }
    const expectedScope =
      document.sourceStore === "user_global" ? "durable" : `durable:project:${scope.legacyProjectId}`
    if (document.scope !== expectedScope) {
      throw new SnapshotDocumentError({
        docId: document.id,
        reason: `document scope ${document.scope} does not match ${document.sourceStore} authority`,
      })
    }
    const key = `${document.sourceStore}:${document.id}`
    const existing = byAuthority.get(key)
    if (existing)
      throw new SnapshotDocumentError({ docId: document.id, reason: "snapshot contains duplicate document authority" })
    const stored = authority[document.sourceStore === "user_global" ? "userGlobal" : "project"].get(
      document.id,
      document.version,
    )
    if (!stored)
      throw new SnapshotDocumentError({
        docId: document.id,
        reason: `document revision is missing from ${document.sourceStore} authority`,
      })
    const exact = documentRef(stored, document.sourceStore)
    if (
      stored.status !== "active" ||
      exact.id !== document.id ||
      exact.version !== document.version ||
      exact.hash !== document.hash ||
      exact.type !== document.type ||
      exact.scope !== document.scope
    )
      throw new SnapshotDocumentError({
        docId: document.id,
        reason: `document revision does not match active ${document.sourceStore} authority`,
      })
    byAuthority.set(key, document)
  })
  return [...byAuthority.values()].sort(compareDocumentRefs)
}

function revocationFingerprintFor(
  scope: Scope,
  parent: Pick<Selection, "snapshotId" | "generation" | "membershipHash">,
  document: ExactDocumentIdentity,
  actor: PublishInput["actor"],
) {
  return `${revocationPrefixFor(scope, document, actor)}_${Hash.sha256(CanonicalJson.stringify(parent))}`
}

function revocationPrefixFor(scope: Scope, document: ExactDocumentIdentity, actor: PublishInput["actor"]) {
  return Hash.sha256(
    CanonicalJson.stringify({
      schemaVersion: "deepagent.released_knowledge_revocation.v1",
      scope,
      document: {
        sourceStore: document.sourceStore,
        id: document.id,
        version: document.version,
        hash: document.hash,
      },
      actor,
    }),
  )
}

function validatePublishInput(input: PublishInput) {
  const invalid = [
    ["snapshotId", input.snapshotId.trim().length > 0, "snapshot id must not be empty"],
    ["evaluationId", input.evaluationId.trim().length > 0, "evaluation id must not be empty"],
    ["baselineRef", input.baselineRef.trim().length > 0, "baseline ref must not be empty"],
    ["actor.id", input.actor.id.trim().length > 0, "actor id must not be empty"],
    ["repetitions", Number.isSafeInteger(input.repetitions) && input.repetitions > 0, "repetitions must be positive"],
    [
      "expectedGeneration",
      Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration >= 0,
      "expected generation must be non-negative",
    ],
    [
      "failureReason",
      input.verdict === "failed" ? Boolean(input.failureReason?.trim()) : input.failureReason === undefined,
      input.verdict === "failed"
        ? "failed releases require a reason"
        : "passing releases must not have a failure reason",
    ],
    [
      "releaseKind",
      input.releaseKind === "legacy_baseline"
        ? input.expectedParentSnapshotId === null && input.expectedGeneration === 0 && input.verdict === "passed"
        : input.expectedParentSnapshotId !== null,
      "legacy baseline must be the first passing release; evaluated and rollback releases require a parent",
    ],
  ].find((entry) => !entry[1])
  if (!invalid) return Effect.void
  return new SnapshotInputError({ field: invalid[0] as string, reason: invalid[2] as string })
}

function compareDocumentRefs(a: DocumentRef, b: DocumentRef) {
  return a.sourceStore.localeCompare(b.sourceStore) || a.id.localeCompare(b.id)
}

function isHash(input: unknown): input is string {
  return typeof input === "string" && /^[a-f0-9]{64}$/.test(input)
}

function ensureHead(db: Transaction, scope: Scope, now: number) {
  return db
    .insert(ReleasedKnowledgeSnapshotHeadTable)
    .values({
      security_namespace_id: scope.securityNamespaceId,
      project_scope_key: scope.projectScopeKey,
      generation: 0,
      updated_at: now,
    })
    .onConflictDoNothing()
    .run()
}

const requireHead = Effect.fnUntraced(function* (db: DatabaseClient | Transaction, scope: Scope) {
  const head = yield* db
    .select()
    .from(ReleasedKnowledgeSnapshotHeadTable)
    .where(
      and(
        eq(ReleasedKnowledgeSnapshotHeadTable.security_namespace_id, scope.securityNamespaceId),
        eq(ReleasedKnowledgeSnapshotHeadTable.project_scope_key, scope.projectScopeKey),
      ),
    )
    .get()
  if (!head) return yield* Effect.die("released knowledge head disappeared")
  return head
})

const requireSelection = Effect.fnUntraced(function* (
  db: DatabaseClient | Transaction,
  scope: Scope,
  snapshotId: string | null,
  knownGeneration?: number,
) {
  if (!snapshotId) return undefined
  const authority = yield* requireSnapshotAuthority(db, scope, snapshotId)
  if (authority.snapshot.verdict !== "passed")
    return yield* Effect.die(`passed released snapshot disappeared: ${snapshotId}`)
  if (knownGeneration !== undefined && knownGeneration !== authority.snapshot.published_generation) {
    return yield* new SnapshotIntegrityError({
      snapshotId,
      docId: "<selection>",
      reason: "released snapshot head generation does not match its published generation",
    })
  }
  return {
    snapshotId: authority.snapshot.snapshot_id,
    securityNamespaceId: authority.snapshot.security_namespace_id,
    projectScopeKey: authority.snapshot.project_scope_key,
    legacyProjectId: authority.snapshot.legacy_project_id,
    parentSnapshotId: authority.snapshot.parent_snapshot_id,
    generation: authority.snapshot.published_generation,
    membershipHash: authority.membershipHash,
    manifestHash: authority.manifestHash,
    documents: authority.refs,
  } satisfies Selection
})

const requireSnapshotAuthority = Effect.fnUntraced(function* (
  db: DatabaseClient | Transaction,
  scope: Scope,
  snapshotId: string,
) {
  const snapshot = yield* db
    .select()
    .from(ReleasedKnowledgeSnapshotTable)
    .where(
      and(
        eq(ReleasedKnowledgeSnapshotTable.security_namespace_id, scope.securityNamespaceId),
        eq(ReleasedKnowledgeSnapshotTable.project_scope_key, scope.projectScopeKey),
        eq(ReleasedKnowledgeSnapshotTable.snapshot_id, snapshotId),
      ),
    )
    .get()
  if (!snapshot) return yield* Effect.die(`released snapshot disappeared: ${snapshotId}`)
  if (snapshot.legacy_project_id !== scope.legacyProjectId) {
    return yield* Effect.die(`released snapshot legacy project binding mismatch: ${snapshotId}`)
  }
  if (snapshot.finalized_at === null) return yield* Effect.die(`released snapshot is not finalized: ${snapshotId}`)
  const documents = yield* db
    .select()
    .from(ReleasedKnowledgeSnapshotDocumentTable)
    .where(eq(ReleasedKnowledgeSnapshotDocumentTable.snapshot_id, snapshotId))
    .orderBy(asc(ReleasedKnowledgeSnapshotDocumentTable.ordinal))
    .all()
  if (
    documents.length !== snapshot.document_count ||
    documents.some((document, ordinal) => document.ordinal !== ordinal)
  ) {
    return yield* new SnapshotIntegrityError({
      snapshotId,
      docId: "<selection>",
      reason: "released snapshot document count or ordinal sequence does not match the manifest",
    })
  }
  const refs = documents.map((document) => ({
    sourceStore: document.source_store,
    id: document.doc_id,
    version: document.doc_version,
    hash: document.doc_hash,
    type: document.doc_type as DocType,
    scope: document.doc_scope,
  }))
  if (CanonicalJson.stringify(refs) !== CanonicalJson.stringify(normalizeDocumentRefs(refs))) {
    return yield* new SnapshotIntegrityError({
      snapshotId,
      docId: "<selection>",
      reason: "released snapshot document refs are not in canonical authority order",
    })
  }
  const evaluation = yield* db
    .select()
    .from(ReleasedKnowledgeEvaluationTable)
    .where(
      and(
        eq(ReleasedKnowledgeEvaluationTable.security_namespace_id, scope.securityNamespaceId),
        eq(ReleasedKnowledgeEvaluationTable.project_scope_key, scope.projectScopeKey),
        eq(ReleasedKnowledgeEvaluationTable.evaluation_id, snapshot.evaluation_id),
      ),
    )
    .get()
  if (!evaluation) return yield* Effect.die(`released snapshot evaluation disappeared: ${snapshot.evaluation_id}`)
  if (Hash.sha256(evaluation.matrix_json) !== evaluation.matrix_hash) {
    return yield* new SnapshotIntegrityError({
      snapshotId,
      docId: "<evaluation>",
      reason: "released snapshot evaluation matrix hash does not match its immutable evidence",
    })
  }
  const documentManifestJson = CanonicalJson.stringify(refs)
  if (evaluation.document_manifest_json !== documentManifestJson) {
    return yield* new SnapshotIntegrityError({
      snapshotId,
      docId: "<selection>",
      reason: "released snapshot exact document refs do not match the evaluated manifest",
    })
  }
  const membershipHash = Hash.sha256(documentManifestJson)
  return {
    snapshot,
    refs,
    membershipHash,
    manifestHash: Hash.sha256(
      CanonicalJson.stringify({
        scope,
        evaluationId: snapshot.evaluation_id,
        parentSnapshotId: snapshot.parent_snapshot_id,
        expectedGeneration:
          snapshot.verdict === "passed" ? snapshot.published_generation - 1 : snapshot.published_generation,
        releaseKind: snapshot.release_kind,
        verdict: snapshot.verdict,
        failureReason: snapshot.failure_reason,
        membershipHash,
        matrixHash: evaluation.matrix_hash,
        baselineRef: evaluation.baseline_ref,
        repetitions: evaluation.repetitions,
        actor: { type: snapshot.actor_type, id: snapshot.actor_id },
      }),
    ),
  }
})
