export * as IMTaskSession from "./task-session"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskAuthoritySchema } from "@deepagent-code/core/im/task-authority.schema"
import { IMTaskSourceTable } from "@deepagent-code/core/im/task-authority.sql"
import { GroupTable, MemberTable, MessageTable } from "@deepagent-code/core/im/sql"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"

const failure = (code: IMTaskAuthoritySchema.ErrorCode) => new IMTaskAuthoritySchema.Error({
  code,
  message: "The original task Session is unavailable or its current source, grant, or placement changed",
})

/** A current task read locates its original Session. It never wakes, resumes, or forwards
 * assistant content to a recipient; the existing authenticated Session channel owns that read. */
export const make = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const read = Effect.fn("IMTaskSession.read")(function* (input: {
    requestID: string
    directory: string
    workspaceID: string
    userID: string
  }) {
    // Authenticate the original request before any external source observation. Historical
    // management remains a separate port when the current source has expired or retired.
    const before = yield* IMTaskAuthority.readManagement(db, input)
    if (!before.grant || !before.work || before.work.admission_state !== "ready")
      return yield* failure("IM_TASK_AUTHORITY_UNAVAILABLE")
    if (before.grant.state !== "active" || before.work.control_state !== "active")
      return yield* failure("IM_TASK_REVOKED")
    if (Math.min(before.request.expires_at, before.grant.expires_at,
      before.work.binding.deadline, before.work.created_at + before.work.binding.budget.maxDurationMs) <= Date.now())
      return yield* failure("IM_TASK_EXPIRED")
    const source = yield* db.select().from(IMTaskSourceTable)
      .where(eq(IMTaskSourceTable.source_id, before.request.source_id)).get()
    if (!source) return yield* failure("IM_TASK_SOURCE_UNAVAILABLE")
    if (source.proof.reader) return yield* failure("IM_TASK_SOURCE_UNAVAILABLE")
    const current = db.transaction((tx) => Effect.gen(function* () {
      const actual = yield* IMTaskAuthority.authorizeStatusSourceInTransaction(tx, input)
      const work = actual.work
      const grant = actual.grant
      if (!work || !grant || work.admission_state !== "ready")
        return yield* failure("IM_TASK_AUTHORITY_UNAVAILABLE")
      if (work.work_id !== before.work!.work_id || work.session_id !== before.work!.session_id ||
        actual.request.revision !== before.request.revision || grant.grant_id !== before.grant!.grant_id ||
        grant.revision !== before.grant!.revision || work.control_revision !== before.work!.control_revision)
        return yield* failure("IM_TASK_IDENTITY_CONFLICT")
      if (grant.state !== "active" || work.control_state !== "active")
        return yield* failure("IM_TASK_REVOKED")
      const expiresAt = Math.min(actual.request.expires_at, grant.expires_at, actual.source.proof.expiresAt,
        work.binding.deadline, work.created_at + work.binding.budget.maxDurationMs)
      if (expiresAt <= Date.now()) return yield* failure("IM_TASK_EXPIRED")
      const binding = work.binding
      const placed = yield* tx.select({ session: SessionTable, namespace: SecurityNamespaceTable,
        project: ProjectScopeIdentityTable, location: LocationIdentityTable,
        message: MessageTable, group: GroupTable, member: MemberTable })
        .from(SessionTable)
        .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, binding.scope.securityNamespaceID))
        .innerJoin(ProjectScopeIdentityTable, and(
          eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
          eq(ProjectScopeIdentityTable.project_scope_key, binding.scope.projectScopeKey)))
        .innerJoin(LocationIdentityTable, and(
          eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
          eq(LocationIdentityTable.project_scope_key, ProjectScopeIdentityTable.project_scope_key),
          sql`${LocationIdentityTable.canonical_root}=${binding.location.directory}`))
        .innerJoin(MessageTable, sql`${MessageTable.id}=${actual.source.message_id}`)
        .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
        .innerJoin(MemberTable, and(eq(MemberTable.group_id, GroupTable.id),
          eq(MemberTable.member_id, input.userID), eq(MemberTable.member_type, "user")))
        .where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id))).get()
      const admitted = yield* tx.select().from(SessionInputTable).where(sql`${SessionInputTable.id}=${work.input_id}`).get()
      const prompt = Schema.decodeUnknownOption(Prompt, { onExcessProperty: "error" })(admitted?.prompt)
      if (!placed || !admitted || !placed.session.v2_authority || placed.session.parent_id !== null ||
        placed.session.directory !== input.directory || placed.session.directory !== binding.location.directory ||
        placed.session.workspace_id !== (binding.location.workspaceID ?? null) ||
        binding.scope.workspaceID !== input.workspaceID ||
        input.workspaceID !== (placed.session.workspace_id ?? placed.session.directory) ||
        placed.session.agent !== binding.agentID || placed.session.model?.id !== binding.provider.modelID ||
        placed.session.model.providerID !== binding.provider.providerID ||
        placed.namespace.id !== actual.source.proof.securityNamespaceID ||
        placed.namespace.binding_hash !== actual.source.proof.namespaceBindingHash ||
        placed.namespace.kind !== "implicit_local" || placed.namespace.retired_at !== null ||
        placed.project.retired_at !== null || placed.location.retired_at !== null ||
        placed.project.observed_project_id !== placed.session.project_id ||
        placed.location.observed_project_id !== placed.session.project_id || placed.location.workspace_binding !== null ||
        ("version" in actual.request.target && actual.request.target.projectScope.projectID !== placed.session.project_id) ||
        placed.message.deleted_at !== null || placed.group.deleted_at !== null ||
        placed.group.workspace_id !== input.workspaceID ||
        admitted.session_id !== work.session_id || admitted.admitted_seq !== work.admitted_seq ||
        admitted.delivery !== "queue" || admitted.revert_epoch !== null || Option.isNone(prompt) ||
        !Prompt.equivalence(prompt.value, new Prompt({ text: actual.request.audited_text })))
        return yield* failure("IM_TASK_IDENTITY_CONFLICT")
      // A late operator/member/source change cannot turn the preceding reads into a pointer.
      const final = yield* IMTaskAuthority.authorizeStatusSourceInTransaction(tx, input)
      if (final.work?.work_id !== work.work_id || final.work.control_revision !== work.control_revision ||
        final.grant?.grant_id !== grant.grant_id || final.grant.state !== "active" ||
        final.grant.revision !== grant.revision || final.source.proof_hash !== actual.source.proof_hash ||
        final.source.snapshot_hash !== actual.source.snapshot_hash || expiresAt <= Date.now())
        return yield* failure("IM_TASK_IDENTITY_CONFLICT")
      return { version: 1 as const, requestID: actual.request.request_id,
        requestRevision: actual.request.revision, instanceID: actual.request.instance_id,
        source: { messageID: placed.message.id, groupID: placed.group.id },
        placement: { securityNamespaceID: placed.namespace.id, projectID: placed.session.project_id,
          directory: placed.session.directory, workspaceID: placed.session.workspace_id, sessionID: placed.session.id },
        attempt: { workID: work.work_id, inputID: work.input_id }, expiresAt }
    }))
    return yield* current
  })
  return { read }
})
export type Interface = Effect.Success<typeof make>
export type Location = Effect.Success<ReturnType<Interface["read"]>>
