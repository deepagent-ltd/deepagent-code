import { createHmac } from "node:crypto"
import fs from "node:fs/promises"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { Hash } from "@deepagent-code/core/util/hash"
import { AuthRuntime } from "../../../src/im/auth-runtime"
import { LocalAuthority } from "../../../src/installation/local-authority"
import { ServerAuth } from "../../../src/server/auth"

/** Credential-only fixture admission through the real Core transaction. The empty
 * capability set and unavailable route are data, never a Native creator proof. */
export const prepare = Effect.fn("OperatorCredentialFixture.prepare")(function* (operationID: string) {
  const config = yield* ServerAuth.Config
  if (Option.isNone(config.password)) throw new Error("Fixture password is required")
  const password = config.password.value
  const installation = yield* LocalAuthority.initializeInstallation()
  const runtime = LocalAuthority.binding(installation, config.username, password)
  const operatorID = `operator_${createHmac("sha256", Buffer.from(installation.secret, "hex")).update(`enroll:${operationID}`).digest("hex").slice(0, 32)}`
  const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(process.cwd())))
  const project = yield* (yield* Project.Service).resolve(directory)
  const identity = yield* (yield* LocationIdentity.Service).resolve({
    boundary: { kind: "implicit_local" },
    directory,
    project: { kind: "registered_root", observedProjectId: project.id },
  })
  const db = (yield* Database.Service).db
  const namespace = yield* db
    .select()
    .from(SecurityNamespaceTable)
    .where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId))
    .get()
    .pipe(Effect.orDie)
  if (!namespace) throw new Error("Fixture namespace was not registered")
  const root = yield* Effect.promise(() => fs.lstat(directory, { bigint: true }))
  const budget = {
    ...WorkAuthorityPolicy.PROJECT_PROFILE.budget,
    maxInputTokens: 4000,
    maxCompletionTokens: 4000,
    maxTotalTokens: 8000,
    maxChildren: 0,
  }
  const policy = {
    version: 2,
    targets: [
      {
        id: "review",
        locationKey: identity.locationKey,
        namespaceBindingHash: namespace.binding_hash,
        target: {
          version: 2,
          scope: {
            actorID: operatorID,
            workspaceID: directory,
            securityNamespaceID: identity.securityNamespaceId,
            projectScopeKey: identity.projectScopeKey,
          },
          location: { directory },
          agentID: "auto",
          profile: {
            id: WorkAuthorityPolicy.PROJECT_PROFILE.id,
            version: 1,
            hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH,
          },
          projectScope: {
            projectID: project.id,
            locationKey: identity.locationKey,
            namespaceBindingHash: namespace.binding_hash,
            canonicalRoot: directory,
            helperHash: Hash.sha256("credential-fixture: native-helper-unavailable"),
            rootIdentity: { kind: "posix", device: String(root.dev), inode: String(root.ino) },
          },
          contextPolicy: {
            kind: "scoped_project_history_v1",
            instructionsRevision: 1,
            history: "same_work_activity",
            graphs: [],
            references: [],
            files: "approved_tool_results_only",
          },
          toolPolicy: {
            kind: "scoped_project_tools_v1",
            capabilities: [],
            fileScope: {
              read: [],
              write: [],
              deny: [],
              maxReadBytes: 0,
              maxPageBytes: 51200,
              maxHashBytes: 16777216,
              maxWriteBytes: 0,
              symlinks: "deny",
            },
            commandScope: [],
            integrations: [],
          },
          childPolicy: "deny_all",
          provider: {
            providerID: "fixture",
            modelID: "probe",
            protocol: "openai.responses",
            routeID: "credential-fixture-unavailable",
            configurationHash: Hash.sha256("credential-fixture-unavailable"),
            endpoint: "https://example.invalid/v1/responses",
            evidenceID: "execution-unavailable",
            evidenceHash: Hash.sha256("execution-unavailable"),
            endpointPinned: false,
            redirectsDenied: false,
            transportRetriesDenied: false,
            completion: { parameter: "unavailable", hardLimit: false, includesReasoning: false, maxTokens: 4000 },
          },
          budget,
          durationMs: budget.maxDurationMs,
        },
      },
    ],
  }
  return yield* LocalOperator.enroll(db, {
    operationID,
    operatorID,
    username: config.username,
    credentialVerifier: yield* Effect.promise(() => AuthRuntime.hash(password)),
    policy,
  }).pipe(Effect.provideService(LocalOperator.Runtime, runtime))
})

export const layer = Project.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))
