export * as ContextLinkStore from "./link-store"

import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { ContextAuthorization, type EgressPolicy, type Principal } from "./authorization"
import {
  ContextRef,
  LocationKey,
  ProjectScopeKey,
  ProjectionKind,
  ProjectionSnapshotRevision,
  SecurityNamespaceID,
  canonicalContextRef,
  canonicalProjectionRevision,
  type ProjectionSnapshotRevision as SnapshotRevision,
} from "./reference"
import { ContextLinkBatchTable, ContextLinkTable } from "./link-sql"

export const AccessConstraint = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("location"), locationKey: LocationKey }),
  Schema.Struct({ scope: Schema.Literal("session"), sessionId: Schema.String }),
  Schema.Struct({ scope: Schema.Literal("subject"), subjectId: Schema.String }),
])
export type AccessConstraint = typeof AccessConstraint.Type

export const Relation = Schema.Literals([
  "references",
  "implements",
  "validated_by",
  "derived_from",
  "supports",
  "conflicts_with",
  "supersedes",
  "depends_on",
  "produced_by",
  "observed_in",
])
export type Relation = typeof Relation.Type

export type LinkInput = {
  readonly from: ContextRef
  readonly to: ContextRef
  readonly relation: Relation
  readonly evidenceRefs: readonly ContextRef[]
  readonly confidence: number
}

export type Link = LinkInput & {
  readonly linkId: string
  readonly accessFingerprint: string
  readonly constraints: readonly AccessConstraint[]
  readonly producer: {
    readonly kind: "projection" | "runner" | "model" | "reviewed_promotion" | "human"
    readonly id: string
  }
  readonly source: "parser" | "runner" | "model" | "human"
  readonly state: "candidate" | "active" | "broken" | "revoked"
  readonly direction: "forward" | "inverse"
  readonly createdAt: number
  readonly validUntil?: number
}

export type Batch = {
  readonly batchId: string
  readonly securityNamespaceId: SecurityNamespaceID
  readonly projectScopeKey: ProjectScopeKey
  readonly producerId: string
  readonly projectionKind: typeof ProjectionKind.Type
  readonly sourceRevision: SnapshotRevision
  readonly state: "staged" | "active" | "superseded"
  readonly createdAt: number
  readonly activatedAt?: number
  readonly supersededAt?: number
}

export class InvalidLinkError extends Schema.TaggedErrorClass<InvalidLinkError>()("ContextLink.InvalidLinkError", {
  reason: Schema.String,
}) {}
export class BatchStateError extends Schema.TaggedErrorClass<BatchStateError>()("ContextLink.BatchStateError", {}) {}
export class RevisionChangedError extends Schema.TaggedErrorClass<RevisionChangedError>()(
  "ContextLink.RevisionChangedError",
  {},
) {}
export class CorruptLinkError extends Schema.TaggedErrorClass<CorruptLinkError>()("ContextLink.CorruptLinkError", {}) {}

export type Error = InvalidLinkError | BatchStateError | RevisionChangedError | CorruptLinkError

export interface RevisionAuthorityInterface {
  readonly withCurrent: <A, E, R>(
    input: { readonly producerId: string; readonly revision: SnapshotRevision },
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RevisionChangedError, R>
  readonly isCurrent: (input: {
    readonly producerId: string
    readonly revision: SnapshotRevision
  }) => Effect.Effect<boolean>
}

export class RevisionAuthority extends Context.Service<RevisionAuthority, RevisionAuthorityInterface>()(
  "@deepagent-code/ContextLinkRevisionAuthority",
) {}

export interface Interface {
  readonly stageProjectionBatch: (input: {
    readonly securityNamespaceId: SecurityNamespaceID
    readonly projectScopeKey: ProjectScopeKey
    readonly producerId: string
    readonly projectionKind: typeof ProjectionKind.Type
    readonly sourceRevision: SnapshotRevision
    readonly links: readonly LinkInput[]
    readonly createdBy: string
    readonly now?: number
  }) => Effect.Effect<Batch, Error>
  readonly activateProjectionBatch: (batchId: string, now?: number) => Effect.Effect<Batch, Error>
  readonly put: (input: {
    readonly securityNamespaceId: SecurityNamespaceID
    readonly projectScopeKey: ProjectScopeKey
    readonly producer: {
      readonly kind: "runner" | "model" | "reviewed_promotion" | "human"
      readonly id: string
    }
    readonly source: "runner" | "model" | "human"
    readonly link: LinkInput
    readonly createdBy: string
    readonly validUntil?: number
    readonly now?: number
  }) => Effect.Effect<Link, Error>
  readonly retire: (input: {
    readonly linkId: string
    readonly state: "broken" | "revoked"
    readonly now?: number
  }) => Effect.Effect<Link, Error>
  readonly neighbors: (input: {
    readonly securityNamespaceId: SecurityNamespaceID
    readonly projectScopeKey: ProjectScopeKey
    readonly ref: ContextRef
    readonly principal: Principal
    readonly egress: EgressPolicy
    readonly relations?: readonly Relation[]
    readonly limit?: number
    readonly now?: number
  }) => Effect.Effect<{ readonly links: readonly Link[]; readonly refreshPending: boolean }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextLinkStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const authority = yield* RevisionAuthority

    const stageProjectionBatch = Effect.fn("ContextLink.stageProjectionBatch")(function* (
      input: Parameters<Interface["stageProjectionBatch"]>[0],
    ) {
      const rows = yield* Effect.try({
        try: () =>
          input.links
            .map((link) => requireLink(input.securityNamespaceId, input.projectScopeKey, link))
            .toSorted((a, b) => a.canonical.localeCompare(b.canonical)),
        catch: (error) => (error instanceof InvalidLinkError ? error : new InvalidLinkError({ reason: "invalid" })),
      })
      if (input.sourceRevision.projectionKind !== input.projectionKind) {
        return yield* new InvalidLinkError({ reason: "projection_kind" })
      }
      const sourceRevision = canonicalProjectionRevision(input.sourceRevision)
      const batchId = `link_batch_${Hash.sha256(
        JSON.stringify({
          securityNamespaceId: input.securityNamespaceId,
          projectScopeKey: input.projectScopeKey,
          producerId: input.producerId,
          projectionKind: input.projectionKind,
          sourceRevision,
          links: rows.map((row) => row.canonical),
        }),
      )}`
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(ContextLinkBatchTable)
              .where(
                and(
                  eq(ContextLinkBatchTable.security_namespace_id, input.securityNamespaceId),
                  eq(ContextLinkBatchTable.project_scope_key, input.projectScopeKey),
                  eq(ContextLinkBatchTable.producer_id, input.producerId),
                  eq(ContextLinkBatchTable.projection_kind, input.projectionKind),
                  eq(ContextLinkBatchTable.source_snapshot_revision, sourceRevision),
                ),
              )
              .get()
            if (existing) {
              if (existing.batch_id !== batchId) return yield* new InvalidLinkError({ reason: "batch_content" })
              return batch(existing)
            }
            const now = input.now ?? Date.now()
            const created = {
              batch_id: batchId,
              security_namespace_id: input.securityNamespaceId,
              project_scope_key: input.projectScopeKey,
              producer_id: input.producerId,
              projection_kind: input.projectionKind,
              source_snapshot_revision: sourceRevision,
              state: "staged" as const,
              created_at: now,
              activated_at: null,
              superseded_at: null,
            }
            yield* tx.insert(ContextLinkBatchTable).values(created).run()
            if (rows.length > 0) {
              yield* tx
                .insert(ContextLinkTable)
                .values(
                  rows.map((row) => ({
                    ...linkRow(input.securityNamespaceId, input.projectScopeKey, row, {
                      kind: "projection",
                      id: input.producerId,
                      source: "parser",
                      createdBy: input.createdBy,
                      now,
                    }),
                    batch_id: batchId,
                  })),
                )
                .run()
            }
            return batch(created)
          }),
        )
        .pipe(preserveErrors)
    })

    const activateProjectionBatch = Effect.fn("ContextLink.activateProjectionBatch")(function* (
      batchId: string,
      now = Date.now(),
    ) {
      const row = yield* db
        .select()
        .from(ContextLinkBatchTable)
        .where(eq(ContextLinkBatchTable.batch_id, batchId))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new BatchStateError()
      const revision = yield* parse(ProjectionSnapshotRevision, row.source_snapshot_revision)
      return yield* authority
        .withCurrent(
          { producerId: row.producer_id, revision },
          db.transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(ContextLinkBatchTable)
                .where(eq(ContextLinkBatchTable.batch_id, batchId))
                .get()
              if (!current) return yield* new BatchStateError()
              if (current.state === "active") return batch(current)
              if (current.state !== "staged") return yield* new BatchStateError()
              yield* tx
                .update(ContextLinkBatchTable)
                .set({ state: "superseded", superseded_at: now })
                .where(
                  and(
                    eq(ContextLinkBatchTable.security_namespace_id, current.security_namespace_id),
                    eq(ContextLinkBatchTable.project_scope_key, current.project_scope_key),
                    eq(ContextLinkBatchTable.producer_id, current.producer_id),
                    eq(ContextLinkBatchTable.projection_kind, current.projection_kind),
                    eq(ContextLinkBatchTable.state, "active"),
                  ),
                )
                .run()
              const activated = yield* tx
                .update(ContextLinkBatchTable)
                .set({ state: "active", activated_at: now })
                .where(and(eq(ContextLinkBatchTable.batch_id, batchId), eq(ContextLinkBatchTable.state, "staged")))
                .returning()
                .get()
              if (!activated) return yield* new BatchStateError()
              return batch(activated)
            }),
          ),
        )
        .pipe(preserveErrors)
    })

    const put = Effect.fn("ContextLink.put")(function* (input: Parameters<Interface["put"]>[0]) {
      const required = yield* Effect.try({
        try: () => requireLink(input.securityNamespaceId, input.projectScopeKey, input.link),
        catch: (error) => (error instanceof InvalidLinkError ? error : new InvalidLinkError({ reason: "invalid" })),
      })
      const now = input.now ?? Date.now()
      const created = linkRow(input.securityNamespaceId, input.projectScopeKey, required, {
        ...input.producer,
        source: input.source,
        createdBy: input.createdBy,
        now,
        validUntil: input.validUntil,
      })
      const existing = yield* db
        .insert(ContextLinkTable)
        .values(created)
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      const row =
        existing ??
        (yield* db
          .select()
          .from(ContextLinkTable)
          .where(eq(ContextLinkTable.link_id, created.link_id))
          .get()
          .pipe(Effect.orDie))
      if (!row) return yield* new CorruptLinkError()
      return yield* decodeLink(row, "forward")
    })

    const retire = Effect.fn("ContextLink.retire")(function* (input: Parameters<Interface["retire"]>[0]) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(ContextLinkTable)
              .where(eq(ContextLinkTable.link_id, input.linkId))
              .get()
            const now = input.now ?? Date.now()
            if (!current || !["active", "candidate"].includes(current.state) || now <= current.updated_at) {
              return yield* new InvalidLinkError({ reason: "state" })
            }
            const row = yield* tx
              .update(ContextLinkTable)
              .set({ state: input.state, updated_at: now })
              .where(and(eq(ContextLinkTable.link_id, input.linkId), eq(ContextLinkTable.state, current.state)))
              .returning()
              .get()
            if (!row) return yield* new InvalidLinkError({ reason: "state" })
            return yield* decodeLink(row, "forward")
          }),
        )
        .pipe(preserveErrors)
    })

    const neighbors = Effect.fn("ContextLink.neighbors")(function* (input: Parameters<Interface["neighbors"]>[0]) {
      if (
        input.principal.securityNamespaceId !== input.securityNamespaceId ||
        !input.principal.projectScopeKeys.includes(input.projectScopeKey) ||
        !ContextAuthorization.authorizeScope(input.ref, input.principal).allowed
      ) {
        return { links: [], refreshPending: false }
      }
      const hash = Hash.sha256(canonicalContextRef(input.ref))
      const now = input.now ?? Date.now()
      const limit = Math.min(Math.max(input.limit ?? 8, 0), 32)
      if (limit === 0 || input.relations?.length === 0) return { links: [], refreshPending: false }
      const rows = yield* db
        .select({ link: ContextLinkTable, batch: ContextLinkBatchTable })
        .from(ContextLinkTable)
        .leftJoin(ContextLinkBatchTable, eq(ContextLinkTable.batch_id, ContextLinkBatchTable.batch_id))
        .where(
          and(
            eq(ContextLinkTable.security_namespace_id, input.securityNamespaceId),
            eq(ContextLinkTable.project_scope_key, input.projectScopeKey),
            eq(ContextLinkTable.state, "active"),
            or(eq(ContextLinkTable.from_ref_hash, hash), eq(ContextLinkTable.to_ref_hash, hash)),
            input.relations?.length ? inArray(ContextLinkTable.relation, [...input.relations]) : undefined,
            or(isNull(ContextLinkTable.valid_until), gt(ContextLinkTable.valid_until, now)),
          ),
        )
        .orderBy(asc(ContextLinkTable.link_id))
        .all()
        .pipe(Effect.orDie)
      let refreshPending = false
      const visible: Link[] = []
      for (const row of rows) {
        if (row.batch && row.batch.state !== "active") continue
        const decoded = yield* decodeLink(row.link, row.link.from_ref_hash === hash ? "forward" : "inverse")
        if (!allows(decoded.constraints, input.principal)) continue
        if (
          ![decoded.from, decoded.to, ...decoded.evidenceRefs].every(
            (ref) =>
              ContextAuthorization.authorizeScope(ref, input.principal).allowed &&
              input.egress.graphs.includes(ref.graph),
          )
        ) {
          continue
        }
        if (row.batch) {
          const revision = yield* parse(ProjectionSnapshotRevision, row.batch.source_snapshot_revision)
          if (!(yield* authority.isCurrent({ producerId: row.batch.producer_id, revision }))) {
            refreshPending = true
            continue
          }
        }
        visible.push(decoded)
        if (visible.length >= limit) break
      }
      return { links: visible, refreshPending }
    })

    return Service.of({ stageProjectionBatch, activateProjectionBatch, put, retire, neighbors })
  }),
)

function requireLink(securityNamespaceId: SecurityNamespaceID, projectScopeKey: ProjectScopeKey, link: LinkInput) {
  if (!Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1) {
    throw new InvalidLinkError({ reason: "confidence" })
  }
  const refs = [link.from, link.to, ...link.evidenceRefs]
  const constraints = new Map<string, AccessConstraint>()
  for (const ref of refs) {
    const binding = ref.binding
    if (binding.scope !== "builtin" && binding.securityNamespaceId !== securityNamespaceId) {
      throw new InvalidLinkError({ reason: "security_namespace" })
    }
    if (
      (binding.scope === "location" || binding.scope === "project" || binding.scope === "session") &&
      binding.projectScopeKey !== projectScopeKey
    ) {
      throw new InvalidLinkError({ reason: "project_scope" })
    }
    if (binding.scope === "location") {
      constraints.set(`location:${binding.locationKey}`, { scope: "location", locationKey: binding.locationKey })
    }
    if (binding.scope === "session") {
      constraints.set(`session:${binding.sessionId}`, { scope: "session", sessionId: binding.sessionId })
    }
    if (binding.scope === "user") {
      constraints.set(`subject:${binding.subjectId}`, { scope: "subject", subjectId: binding.subjectId })
    }
  }
  const sorted = [...constraints.values()].toSorted((a, b) => constraintKey(a).localeCompare(constraintKey(b)))
  const accessFingerprint = Hash.sha256(JSON.stringify(sorted))
  const canonical = JSON.stringify({
    from: canonicalContextRef(link.from),
    to: canonicalContextRef(link.to),
    relation: link.relation,
    evidenceRefs: link.evidenceRefs.map(canonicalContextRef).toSorted(),
    confidence: link.confidence,
    accessFingerprint,
  })
  return { link, constraints: sorted, accessFingerprint, canonical }
}

function linkRow(
  securityNamespaceId: SecurityNamespaceID,
  projectScopeKey: ProjectScopeKey,
  required: ReturnType<typeof requireLink>,
  producer: {
    readonly kind: "projection" | "runner" | "model" | "reviewed_promotion" | "human"
    readonly id: string
    readonly source: "parser" | "runner" | "model" | "human"
    readonly createdBy: string
    readonly now: number
    readonly validUntil?: number
  },
): typeof ContextLinkTable.$inferInsert {
  return {
    link_id: `link_${Hash.sha256(
      JSON.stringify({
        producer: { kind: producer.kind, id: producer.id },
        link: required.canonical,
        validUntil: producer.validUntil,
      }),
    )}`,
    security_namespace_id: securityNamespaceId,
    project_scope_key: projectScopeKey,
    access_fingerprint: required.accessFingerprint,
    access_constraints: JSON.stringify(required.constraints),
    from_ref_hash: Hash.sha256(canonicalContextRef(required.link.from)),
    to_ref_hash: Hash.sha256(canonicalContextRef(required.link.to)),
    from_ref: canonicalContextRef(required.link.from),
    to_ref: canonicalContextRef(required.link.to),
    relation: required.link.relation,
    evidence_refs: JSON.stringify(required.link.evidenceRefs),
    producer_kind: producer.kind,
    producer_id: producer.id,
    source: producer.source,
    created_by: producer.createdBy,
    state: producer.kind === "model" ? "candidate" : "active",
    confidence: required.link.confidence,
    created_at: producer.now,
    updated_at: producer.now,
    valid_until: producer.validUntil,
  }
}

function decodeLink(row: typeof ContextLinkTable.$inferSelect, direction: "forward" | "inverse") {
  return Effect.gen(function* () {
    return {
      linkId: row.link_id,
      from: yield* parse(ContextRef, row.from_ref),
      to: yield* parse(ContextRef, row.to_ref),
      relation: yield* parse(Relation, JSON.stringify(row.relation)),
      evidenceRefs: yield* parse(Schema.Array(ContextRef), row.evidence_refs),
      confidence: row.confidence,
      accessFingerprint: row.access_fingerprint,
      constraints: yield* parse(Schema.Array(AccessConstraint), row.access_constraints),
      producer: { kind: row.producer_kind, id: row.producer_id },
      source: row.source,
      state: row.state,
      direction,
      createdAt: row.created_at,
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
    } satisfies Link
  })
}

function batch(row: typeof ContextLinkBatchTable.$inferSelect): Batch {
  return {
    batchId: row.batch_id,
    securityNamespaceId: SecurityNamespaceID.make(row.security_namespace_id),
    projectScopeKey: ProjectScopeKey.make(row.project_scope_key),
    producerId: row.producer_id,
    projectionKind: row.projection_kind,
    sourceRevision: Schema.decodeUnknownSync(ProjectionSnapshotRevision)(JSON.parse(row.source_snapshot_revision)),
    state: row.state,
    createdAt: row.created_at,
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at }),
  }
}

function allows(constraints: readonly AccessConstraint[], principal: Principal) {
  return constraints.every((constraint) => {
    if (constraint.scope === "location") return principal.locationKeys.includes(constraint.locationKey)
    if (constraint.scope === "session") return principal.sessionIds.includes(constraint.sessionId)
    return principal.subjectIds.includes(constraint.subjectId)
  })
}

function constraintKey(constraint: AccessConstraint) {
  if (constraint.scope === "location") return `0:${constraint.locationKey}`
  if (constraint.scope === "session") return `1:${constraint.sessionId}`
  return `2:${constraint.subjectId}`
}

function parse<A>(schema: Schema.Decoder<A>, value: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(JSON.parse(value)),
    catch: () => new CorruptLinkError(),
  })
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => (isError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return [
    "ContextLink.InvalidLinkError",
    "ContextLink.BatchStateError",
    "ContextLink.RevisionChangedError",
    "ContextLink.CorruptLinkError",
  ].includes(String(value._tag))
}
