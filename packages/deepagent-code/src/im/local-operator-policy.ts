export * as LocalOperatorPolicy from "./local-operator-policy"

import path from "node:path"
import fs from "node:fs/promises"
import { createHmac } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkCommandV2Schema } from "@deepagent-code/core/session/work-command-v2.schema"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { Config } from "@deepagent-code/core/config"
import { AgentV2 } from "@deepagent-code/core/agent"
import { AgentPlugin } from "@deepagent-code/core/plugin/agent"
import { ConfigAgentPlugin } from "@deepagent-code/core/config/plugin/agent"
import { Location } from "@deepagent-code/core/location"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProjectV2 } from "@deepagent-code/core/project"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Global } from "@deepagent-code/core/global"
import { LocalAuthority } from "../installation/local-authority"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { EventWorkRuleSchema } from "@deepagent-code/core/deepagent/event-work-rule.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const LegacyPolicyFile = Schema.Struct({
  version: Schema.Literal(1),
  targets: Schema.Array(
    Schema.Struct({
      id: Text,
      directory: Text,
      agentID: Text,
      providerID: Text,
      modelID: Text,
      budget: WorkAuthoritySchema.Budget,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})

export const ProjectPolicyFile = Schema.Struct({
  version: Schema.Literal(2),
  targets: Schema.Array(
    Schema.Struct({
      ...LegacyPolicyFile.fields.targets.value.fields,
      project: Schema.Struct({
        tools: Schema.Array(Schema.Literal("read")).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
        fileScope: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy.fields.fileScope,
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export const ProjectWritePolicyFile = Schema.Struct({
  version: Schema.Literal(3),
  targets: Schema.Array(
    Schema.Struct({
      ...LegacyPolicyFile.fields.targets.value.fields,
      project: Schema.Struct({
        tools: Schema.Array(Schema.Literals(["read", "write"])).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
        fileScope: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy.fields.fileScope,
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export const ProjectCommandPolicyFile = Schema.Struct({
  version: Schema.Literal(4),
  targets: Schema.Array(
    Schema.Struct({
      ...LegacyPolicyFile.fields.targets.value.fields,
      project: Schema.Struct({
        tools: Schema.Array(Schema.Literals(["read", "write", "managed_command"])).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(3),
        ),
        fileScope: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy.fields.fileScope,
        commandRecipes: Schema.Array(WorkCommandV2Schema.ApprovedRecipeRequest).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(32),
        ),
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export const InvestigationPolicyTarget = Schema.Struct({
  ...LegacyPolicyFile.fields.targets.value.fields,
  profile: Schema.Literal("event_investigate_v1"),
  project: ProjectPolicyFile.fields.targets.value.fields.project,
}).check(
  Schema.makeFilter(
    (entry) =>
      WorkAuthorityPolicy.checkBudgetCeiling(WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget, entry.budget).ok &&
      entry.project.fileScope.read.every((rule) => rule.kind === "file") &&
      entry.project.fileScope.write.length === 0 &&
      entry.project.fileScope.maxWriteBytes === 0 &&
      entry.project.fileScope.maxReadBytes <= WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.maxReadBytes,
  ),
)

export const InvestigationPolicyFile = Schema.Struct({
  version: Schema.Literal(5),
  targets: Schema.Array(
    Schema.Union([
      LegacyPolicyFile.fields.targets.value,
      ProjectPolicyFile.fields.targets.value,
      ProjectWritePolicyFile.fields.targets.value,
      ProjectCommandPolicyFile.fields.targets.value,
      InvestigationPolicyTarget,
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) =>
    policy.targets.every(
      (entry) =>
        !("project" in entry) ||
        "commandRecipes" in entry.project ||
        entry.project.tools.some((tool) => tool === "write") ||
        (entry.project.fileScope.write.length === 0 && entry.project.fileScope.maxWriteBytes === 0),
    ),
  ),
)

export const SharedRootPolicyTarget = Schema.Struct({
  ...LegacyPolicyFile.fields.targets.value.fields,
  profile: Schema.Literal("project_shared_root_v1"),
  children: WorkAuthoritySchema.ProjectBinding.fields.childPolicy.members[2],
  project: Schema.Struct({
    tools: Schema.Array(Schema.Literals(["read", "write", "managed_command", "task"])).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(4),
    ),
    fileScope: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy.fields.fileScope,
    commandRecipes: Schema.optional(ProjectCommandPolicyFile.fields.targets.value.fields.project.fields.commandRecipes),
  }),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.project.tools.includes("task") &&
      new Set(entry.project.tools).size === entry.project.tools.length &&
      new Set(entry.children.agents).size === entry.children.agents.length &&
      new Set(entry.children.toolIDs).size === entry.children.toolIDs.length &&
      !entry.children.toolIDs.includes("task") &&
      entry.children.toolIDs.every((tool) => entry.project.tools.some((allowed) => allowed === tool)) &&
      entry.children.budget.maxChildren === 0 &&
      entry.budget.maxChildren > 0 &&
      WorkAuthorityPolicy.checkBudgetCeiling(WorkAuthorityPolicy.SHARED_ROOT_PROFILE.budget, entry.budget).ok &&
      WorkAuthorityPolicy.checkBudgetCeiling(entry.budget, entry.children.budget).ok &&
      entry.project.tools.includes("managed_command") === !!entry.project.commandRecipes?.length &&
      (entry.project.tools.includes("write") ||
        (entry.project.fileScope.write.length === 0 && entry.project.fileScope.maxWriteBytes === 0)),
  ),
)
export const SharedRootPolicyFile = Schema.Struct({
  version: Schema.Literal(6),
  targets: Schema.Array(
    Schema.Union([...InvestigationPolicyFile.fields.targets.value.members, SharedRootPolicyTarget]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) =>
    policy.targets.every(
      (entry) =>
        !("project" in entry) ||
        entry.project.tools.some((tool) => tool === "write") ||
        (entry.project.fileScope.write.length === 0 && entry.project.fileScope.maxWriteBytes === 0),
    ),
  ),
)

export const DeepSeekPolicyTarget = Schema.Struct({
  ...LegacyPolicyFile.fields.targets.value.fields,
  providerID: Schema.Literal("deepseek"),
  modelID: Schema.Literal("deepseek-flash"),
  profile: Schema.Literal("project_deepseek_context_bound_v1"),
  project: Schema.Struct({
    tools: Schema.Array(Schema.Literals(["read", "write", "managed_command"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
    fileScope: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy.fields.fileScope,
    commandRecipes: Schema.optional(ProjectCommandPolicyFile.fields.targets.value.fields.project.fields.commandRecipes),
  }),
}).check(
  Schema.makeFilter(
    (entry) =>
      WorkAuthorityPolicy.checkBudgetCeiling(WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, entry.budget).ok &&
      WorkAuthorityPolicy.checkContextBoundBudget(entry.budget).ok &&
      entry.budget.maxChildren === 0 &&
      entry.project.tools.includes("managed_command") === !!entry.project.commandRecipes?.length &&
      (entry.project.tools.includes("write") ||
        (entry.project.fileScope.write.length === 0 && entry.project.fileScope.maxWriteBytes === 0)),
  ),
)
export const ContextBoundPolicyFile = Schema.Struct({
  version: Schema.Literal(7),
  targets: Schema.Array(
    Schema.Union([...SharedRootPolicyFile.fields.targets.value.members, DeepSeekPolicyTarget]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) =>
    policy.targets.every(
      (entry) =>
        !("project" in entry) ||
        entry.project.tools.some((tool) => tool === "write") ||
        (entry.project.fileScope.write.length === 0 && entry.project.fileScope.maxWriteBytes === 0),
    ),
  ),
)

export const EventPolicyFile = Schema.Struct({
  version: Schema.Literal(8),
  targets: ContextBoundPolicyFile.fields.targets,
  eventOrigins: Schema.Array(EventWorkRuleSchema.Origin).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) =>
    policy.eventOrigins.every((origin) => {
      const target = policy.targets.find((entry) => entry.id === origin.targetID)
      return (
        !!target &&
        "project" in target &&
        target.project.tools.length === 1 &&
        target.project.tools[0] === "read" &&
        target.project.fileScope.write.length === 0 &&
        target.budget.maxChildren === 0 &&
        !("profile" in target && target.profile === "event_investigate_v1")
      )
    }),
  ),
)

/** A separately reviewed root profile. Existing single/Task policies acquire no new children. */
export const EventDagPolicyTarget = Schema.Struct({
  ...DeepSeekPolicyTarget.fields,
  profile: Schema.Literal("event_deepseek_dag_v1"),
  children: WorkAuthoritySchema.ProjectBinding.fields.childPolicy.members[3],
}).check(
  Schema.makeFilter(
    (entry) =>
      WorkAuthorityPolicy.checkBudgetCeiling(WorkAuthorityPolicy.EVENT_DAG_PROFILE.budget, entry.budget).ok &&
      WorkAuthorityPolicy.checkContextBoundBudget(entry.budget).ok &&
      entry.budget.maxChildren > 0 &&
      entry.children.kind === "event_dag_v1" &&
      entry.children.budget.maxChildren === 0 &&
      WorkAuthorityPolicy.checkBudgetCeiling(entry.budget, entry.children.budget).ok &&
      WorkAuthorityPolicy.checkContextBoundBudget(entry.children.budget).ok &&
      new Set(entry.children.agents).size === entry.children.agents.length &&
      new Set(entry.children.toolIDs).size === entry.children.toolIDs.length &&
      !entry.children.toolIDs.includes("task") &&
      entry.children.toolIDs.every((id) => entry.project.tools.some((tool) => tool === id)) &&
      entry.project.tools.includes("managed_command") === !!entry.project.commandRecipes?.length &&
      (entry.project.tools.includes("write") ||
        (entry.project.fileScope.write.length === 0 && entry.project.fileScope.maxWriteBytes === 0)),
  ),
)
export const EventDagPolicyFile = Schema.Struct({
  version: Schema.Literal(9),
  targets: Schema.Array(
    Schema.Union([...ContextBoundPolicyFile.fields.targets.value.members, EventDagPolicyTarget]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  eventOrigins: Schema.Array(EventWorkRuleSchema.AnyOrigin).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) =>
    policy.eventOrigins.every((origin) => {
      const target = policy.targets.find((entry) => entry.id === origin.targetID)
      if (!target || !("project" in target)) return false
      if ("execution" in origin)
        return (
          "profile" in target &&
          target.profile === "event_deepseek_dag_v1" &&
          "children" in target &&
          target.children.kind === "event_dag_v1"
        )
      return (
        target.project.tools.length === 1 &&
        target.project.tools[0] === "read" &&
        target.project.fileScope.write.length === 0 &&
        target.budget.maxChildren === 0 &&
        !("profile" in target && target.profile === "event_investigate_v1")
      )
    }),
  ),
)

export const PolicyFile = Schema.Union([
  LegacyPolicyFile,
  ProjectPolicyFile,
  ProjectWritePolicyFile,
  ProjectCommandPolicyFile,
  InvestigationPolicyFile,
  SharedRootPolicyFile,
  ContextBoundPolicyFile,
  EventPolicyFile,
  EventDagPolicyFile,
])

/** Pure strict decoding runs before resolver services, filesystem or Native selection. */
export const parse = (input: unknown) => LocalOperator.decode(PolicyFile, input)

/** Offline policy selects configured identities, never accepts authority hashes or proof booleans.
 * This first route selector supports explicit native HTTP model configuration only. It does not
 * import provider SDKs, fetch a model catalog, or establish the independent execution proof. */
export const resolve = Effect.fn("LocalOperatorPolicy.resolve")(function* (input: unknown, operatorID: string) {
  const policy = yield* parse(input)
  if (policy.version === 1 || policy.targets.some((target) => !("project" in target)))
    return yield* LocalOperator.failure(
      "LOCAL_TASK_EXECUTION_UNAVAILABLE",
      "Retired IM text-only policies cannot enroll execution capabilities",
    )
  const database = yield* Database.Service
  const targets = yield* Effect.forEach(
    policy.targets,
    (entry) =>
      Effect.gen(function* () {
        if (!("project" in entry))
          return yield* LocalOperator.failure(
            "LOCAL_TASK_EXECUTION_UNAVAILABLE",
            "Retired IM text-only targets cannot enroll execution capabilities",
          )
        if (!path.isAbsolute(entry.directory))
          return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Policy directories must be absolute")
        const directory = yield* Effect.tryPromise({
          try: () => fs.realpath(entry.directory),
          catch: () =>
            new LocalOperatorSchema.Error({
              code: "LOCAL_TASK_SCOPE_DENIED",
              message: "Policy directory is unavailable",
            }),
        })
        const location = Location.layer({ directory: AbsolutePath.make(directory) }).pipe(
          Layer.provide(
            ProjectV2.layer.pipe(
              Layer.provide(Layer.succeed(Database.Service, database)),
              Layer.provide(FSUtil.defaultLayer),
              Layer.provide(Git.defaultLayer),
            ),
          ),
        )
        const config = Config.locationLayer.pipe(
          Layer.provide(location),
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Global.defaultLayer),
        )
        return yield* Effect.gen(function* () {
          yield* AgentPlugin.Plugin.effect
          yield* ConfigAgentPlugin.Plugin.effect
          const agent = yield* (yield* AgentV2.Service).get(AgentV2.ID.make(entry.agentID))
          if (!agent || agent.hidden || agent.mode === "subagent")
            return yield* LocalOperator.failure(
              "LOCAL_TASK_SCOPE_DENIED",
              "Selected agent is not an available primary agent",
            )
          const documents = yield* (yield* Config.Service).entries()
          const provider = Config.latest(documents, "providers")?.[entry.providerID]
          const model = provider?.models?.[entry.modelID]
          const api = model?.api && "type" in model.api ? model.api : provider?.api
          const protocol = model?.api?.protocol ?? api?.protocol
          if (!provider || !model || model.disabled || !api || api.type !== "native" || !api.url || !protocol)
            return yield* LocalOperator.failure(
              "LOCAL_TASK_SCOPE_DENIED",
              "Selected provider/model requires explicit native HTTP configuration and protocol",
            )
          const endpoint = WorkAuthorityPolicy.normalizeEndpoint(api.url)
          if (!endpoint.ok)
            return yield* LocalOperator.failure(
              "LOCAL_TASK_SCOPE_DENIED",
              "Configured provider endpoint is unsuitable for task policy",
            )
          const eventDag = "profile" in entry && entry.profile === WorkAuthorityPolicy.EVENT_DAG_PROFILE.id
          // Enrollment describes the configured native route before approval can capture its
          // execution proof. Use that adapter's canonical endpoint, preserving the original
          // configuration stamp and unavailable evidence until the real approval succeeds.
          if (
            eventDag &&
            (!["openai.responses", "openai-compatible.responses"].includes(protocol) ||
              !["https://api.deepseek.com", "https://api.deepseek.com/"].includes(endpoint.value))
          )
            return yield* LocalOperator.failure(
              "LOCAL_TASK_SCOPE_DENIED",
              "Event DAG requires the configured official DeepSeek Responses adapter",
            )
          const identity = yield* (yield* LocationIdentity.Service).resolve({
            boundary: { kind: "implicit_local" },
            directory: AbsolutePath.make(directory),
            project: { kind: "registered_root", observedProjectId: (yield* Location.Service).project.id },
          })
          const namespace = yield* database.db
            .select()
            .from(SecurityNamespaceTable)
            .where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId))
            .get()
            .pipe(Effect.orDie)
          if (!namespace)
            return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Registered namespace is unavailable")
          const installation = yield* LocalAuthority.readInstallation
          // This is only a configured-target stamp; execution evidence remains unavailable.
          // Raw provider/model config may contain low-entropy keys and must never use bare SHA.
          const configurationHash = createHmac("sha256", Buffer.from(installation.secret, "hex"))
            .update("dac.local-operator.configured-target.v1\0")
            .update(
              CanonicalJson.stringify([
                installation.instanceID,
                operatorID,
                entry.id,
                identity.securityNamespaceId,
                {
                  providerID: entry.providerID,
                  modelID: entry.modelID,
                  provider,
                  model,
                },
              ]),
            )
            .digest("hex")
          const project = yield* Effect.gen(function* () {
            // A v5 read-only legacy shape keeps v2 rights; only explicit write/recipe shapes opt into v3/v4.
            const version =
              policy.version >= 5
                ? "commandRecipes" in entry.project && entry.project.commandRecipes?.length
                  ? 4
                  : entry.project.tools.some((tool) => tool === "write")
                    ? 3
                    : 2
                : policy.version
            if (version < 3 && (entry.project.fileScope.write.length || entry.project.fileScope.maxWriteBytes !== 0))
              return yield* LocalOperator.failure(
                "LOCAL_TASK_EXECUTION_UNAVAILABLE",
                "Project write sandbox is not installed",
              )
            if (
              version >= 3 &&
              ((process.platform !== "darwin" &&
                process.platform !== "win32" &&
                !(
                  process.platform === "linux" &&
                  (entry.project.tools.some((tool) => tool === "write") ||
                    ("commandRecipes" in entry.project &&
                      entry.project.commandRecipes?.every(
                        (recipe) =>
                          recipe.schemaVersion === "work-command-recipe.v2" &&
                          recipe.target === `${process.platform}-${process.arch}`,
                      )))
                )) ||
                entry.project.fileScope.maxWriteBytes > 51_200 ||
                (entry.project.tools.some((tool) => tool === "write") &&
                  (!entry.project.fileScope.write.length || entry.project.fileScope.maxWriteBytes < 1)))
            )
              return yield* LocalOperator.failure(
                "LOCAL_TASK_EXECUTION_UNAVAILABLE",
                "Current native write policy is unavailable",
              )
            const { NativeRouteCapture } = yield* Effect.promise(() => import("@/installation/native-route-capture"))
            return yield* NativeRouteCapture.projectSelection({
              directory,
              agentID: entry.agentID,
              toolIDs: entry.project.tools,
              ...("commandRecipes" in entry.project ? { commandRecipes: entry.project.commandRecipes } : {}),
              ...("children" in entry ? { childAgentIDs: entry.children.agents } : {}),
            }).pipe(
              Effect.provide(NativeRouteCapture.nativeLayer),
              Effect.tapCause((cause) => NativeRouteCapture.reportDiagnostic("project-select", cause)),
              Effect.mapError(
                () =>
                  new LocalOperatorSchema.Error({
                    code: "LOCAL_TASK_EXECUTION_UNAVAILABLE",
                    message: "Current native project root or registered tool is unavailable",
                  }),
              ),
            )
          })
          const projectTarget = {
            version: 2 as const,
            projectScope: {
              projectID: project.projectID,
              locationKey: identity.locationKey,
              namespaceBindingHash: namespace.binding_hash,
              canonicalRoot: directory,
              helperHash: project.helperHash,
              rootIdentity: project.rootIdentity,
            },
            contextPolicy: {
              kind: "scoped_project_history_v1" as const,
              instructionsRevision: 1,
              history: "same_work_activity" as const,
              graphs: [],
              references: [],
              files: "approved_tool_results_only" as const,
            },
            toolPolicy: {
              kind: "scoped_project_tools_v1" as const,
              capabilities: project.capabilities,
              fileScope: entry.project.fileScope,
              commandScope: [],
              integrations: [],
              ...(project.commandRecipes ? { commandRecipes: project.commandRecipes } : {}),
            },
            childPolicy: "children" in entry ? entry.children : ("deny_all" as const),
            profile:
              "profile" in entry && entry.profile === WorkAuthorityPolicy.EVENT_DAG_PROFILE.id
                ? {
                    id: WorkAuthorityPolicy.EVENT_DAG_PROFILE.id,
                    version: WorkAuthorityPolicy.EVENT_DAG_PROFILE.version,
                    hash: WorkAuthorityPolicy.EVENT_DAG_PROFILE_HASH,
                  }
                : "children" in entry
                  ? {
                      id: WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id,
                      version: WorkAuthorityPolicy.SHARED_ROOT_PROFILE.version,
                      hash: WorkAuthorityPolicy.SHARED_ROOT_PROFILE_HASH,
                    }
                  : "profile" in entry && entry.profile === WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.id
                    ? {
                        id: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.id,
                        version: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.version,
                        hash: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE_HASH,
                      }
                    : "profile" in entry
                      ? {
                          id: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id,
                          version: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.version,
                          hash: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE_HASH,
                        }
                      : {
                          id: "project_work_v1" as const,
                          version: 1 as const,
                          hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH,
                        },
          }
          return {
            id: entry.id,
            locationKey: identity.locationKey,
            namespaceBindingHash: namespace.binding_hash,
            target: {
              scope: {
                actorID: operatorID,
                workspaceID: directory,
                securityNamespaceID: identity.securityNamespaceId,
                projectScopeKey: identity.projectScopeKey,
              },
              location: { directory },
              agentID: entry.agentID,
              ...projectTarget,
              provider: {
                providerID: entry.providerID,
                modelID: entry.modelID,
                protocol: eventDag ? "openai-responses" : protocol,
                routeID: `configured_${configurationHash}`,
                configurationHash,
                endpoint: eventDag ? "https://api.deepseek.com/responses" : endpoint.value,
                evidenceID: "execution-unavailable",
                evidenceHash: LocalOperator.hash("execution-unavailable"),
                endpointPinned: false,
                redirectsDenied: false,
                transportRetriesDenied: false,
                completion: {
                  parameter: "unavailable",
                  hardLimit: false,
                  includesReasoning: false,
                  maxTokens: entry.budget.maxCompletionTokens,
                },
              },
              budget: entry.budget,
              durationMs: entry.budget.maxDurationMs,
            },
          }
        }).pipe(
          Effect.provide(AgentV2.layer),
          Effect.provide(config),
          Effect.provide(location),
          Effect.provide(FSUtil.defaultLayer),
        )
      }),
    { concurrency: 1 },
  )
  // File v5 adds explicit investigation selection; v1-v4 retain their original schemas and profiles.
  return {
    version: policy.version === 9 ? (4 as const) : policy.version === 8 ? (3 as const) : (2 as const),
    targets,
    ...("eventOrigins" in policy ? { eventOrigins: policy.eventOrigins } : {}),
  }
})
