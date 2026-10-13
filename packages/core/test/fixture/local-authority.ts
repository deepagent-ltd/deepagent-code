export * as LocalAuthorityFixture from "./local-authority"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { LocalAuthoritySchema } from "../../src/session/local-authority.schema"
import { WorkAuthorityFixture } from "./work-authority"

export const principal: LocalAuthoritySchema.Principal = {
  instanceID: "receiver-instance",
  actorID: "operator-real",
  revision: 1,
  identityHash: "a".repeat(64),
}
export const namespace = {
  securityNamespaceID: "task-namespace",
  namespaceBindingHash: "b".repeat(64),
}
export const target: LocalAuthoritySchema.Target = {
  scope: {
    actorID: principal.actorID,
    workspaceID: "receiving-project",
    securityNamespaceID: namespace.securityNamespaceID,
    projectScopeKey: "task-project",
  },
  location: { directory: "/tmp/im-task-target" },
  agentID: "build",
  profile: WorkAuthorityFixture.binding().profile,
  provider: WorkAuthorityFixture.binding().provider,
  budget: WorkAuthorityFixture.binding().budget,
  durationMs: 60_000,
}

// Local identity rows shared by route approval and event tests. No IM message,
// mention, task request, source proof or execution grant is created here.
export const initialize = Effect.fn("LocalAuthorityFixture.initialize")(function* () {
  yield* WorkAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  const now = Date.now()
  yield* db.run(sql`INSERT INTO context_security_namespace (id,kind,binding_hash,created_at)
    VALUES (${namespace.securityNamespaceID},'implicit_local',${namespace.namespaceBindingHash},${now})`)
  yield* db.run(sql`INSERT INTO context_project_scope_identity
    (security_namespace_id,project_scope_key,project_kind,project_identity_hash,created_at)
    VALUES (${namespace.securityNamespaceID},${target.scope.projectScopeKey},'registered_root','task-project-binding',${now})`)
  yield* db.run(sql`INSERT INTO context_location_identity
    (security_namespace_id,location_key,project_scope_key,canonical_root,created_at)
    VALUES (${namespace.securityNamespaceID},'task-location',${target.scope.projectScopeKey},${target.location.directory},${now})`)
})
