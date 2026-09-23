import { Context, Effect, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionStore } from "@deepagent-code/core/session/store"
import { InstanceStore } from "@/project/instance-store"
import { ToolRegistry } from "@/tool/registry"

// RI-36/RI-39/RI-44 composition oracle: ONE stable digest per real composition root (HTTP server
// route graph, AppRuntime). Both roots share `V2RunnerFrame.sessionRuntimeLayer`, so every facet
// below must compare equal when the two roots are equivalent — and must move when any root closes
// over a different execution owner, V2 tool registry, authority surface, database, or Location host.
//
// Stability contract: facets exclude listener port/hostname, wall-clock timestamps, random
// correlation/run ids, and the process pid. Those are runtime accidents of ONE boot, not
// composition facts; two equivalent roots (or one root restarted) must digest identically.

export const SessionOwnerDigest = Schema.Struct({
  // Session execution-ownership semantics of the root: which implementation owns drains, where
  // drains are placed, and how same-Session resumes are coordinated. Declared by the frame layer
  // through `FrameIdentity` (unqualified default marks a root with no production frame).
  execution: Schema.String,
  placement: Schema.String,
  coordination: Schema.String,
  // Tag keys of the owner-graph services the digest resolved LIVE from the root context — a root
  // that fails to export any of them cannot produce a digest at all.
  services: Schema.Array(Schema.String),
}).annotate({ identifier: "CompositionSessionOwnerDigest" })

export const ToolRegistryDigest = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ids: Schema.Array(Schema.String),
  // Stable hash of the sorted registered tool-id set (canonical contract digest).
  digest: Schema.String,
}).annotate({ identifier: "CompositionToolRegistryDigest" })

export const V2RegistryDigest = Schema.Struct({
  applicationTools: ToolRegistryDigest,
  materialized: Schema.Struct({
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ids: Schema.Array(Schema.String),
    effectKinds: Schema.Struct({ readOnly: Schema.Int, mutating: Schema.Int }),
  }),
  legacyEgress: ToolRegistryDigest,
}).annotate({ identifier: "CompositionV2RegistryDigest" })

export const AuthoritySurfaceDigest = Schema.Struct({
  corePublicApi: Schema.Boolean,
  legacyPromptMounted: Schema.Boolean,
  v2AgentRosterConsumers: Schema.Int,
  imAdmission: Schema.String,
}).annotate({ identifier: "CompositionAuthoritySurfaceDigest" })

// Static route inventory: reflect intentional mounts and consumers without request-time reflection.
export const authoritySurface = {
  corePublicApi: true,
  legacyPromptMounted: true,
  v2AgentRosterConsumers: 2,
  imAdmission: "session-v2-direct",
} as const

export const DatabaseDigest = Schema.Struct({
  // The database file THIS root's live connection has open (`PRAGMA database_list` on its own
  // Database service) — not the ambient flag at digest time, which a post-boot flag flip would
  // otherwise rewrite. An in-memory connection reports ":memory:".
  path: Schema.String,
  // Byte-stable digest of the ordered migration registry (ids + content hashes), reusing the core
  // upgrade-run mechanism (`DatabaseUpgradeRun.registryDigest`) rather than a new hash recipe.
  migrationRegistryDigest: Schema.String,
  // The bootstrap-observed build digest of this root's own connection (runtime-observed fact).
  bootstrapDigest: Schema.optional(Schema.String),
  readerProtocol: Schema.Int,
  writerProtocol: Schema.Int,
}).annotate({ identifier: "CompositionDatabaseDigest" })

export const LocationHostDigest = Schema.Struct({
  host: Schema.String,
  map: Schema.String,
  idleTimeToLive: Schema.String,
  seams: Schema.Array(Schema.String),
}).annotate({ identifier: "CompositionLocationHostDigest" })

export const Record = Schema.Struct({
  version: Schema.Literal(2),
  digest: Schema.String,
  sessionOwner: SessionOwnerDigest,
  v2Registry: V2RegistryDigest,
  authoritySurface: AuthoritySurfaceDigest,
  database: DatabaseDigest,
  locationHost: LocationHostDigest,
}).annotate({ identifier: "CompositionDigestRecord" })

export type Record = Schema.Schema.Type<typeof Record>

export interface Facets {
  readonly sessionOwner: Schema.Schema.Type<typeof SessionOwnerDigest>
  readonly v2Registry: Schema.Schema.Type<typeof V2RegistryDigest>
  readonly authoritySurface: Schema.Schema.Type<typeof AuthoritySurfaceDigest>
  readonly database: Schema.Schema.Type<typeof DatabaseDigest>
  readonly locationHost: Schema.Schema.Type<typeof LocationHostDigest>
}

/** Byte-stable top-level digest over the composition facets (canonical JSON + SHA-256). */
export function compute(facets: Facets): string {
  return ContractDigest.contentDigest({ schema: "deepagent-code-composition-digest-v2", ...facets })
}

export interface FrameIdentityShape {
  readonly sessionOwner: {
    readonly execution: string
    readonly placement: string
    readonly coordination: string
  }
  readonly locationHost: {
    readonly host: string
    readonly idleTimeToLive: string
    readonly seams: readonly string[]
  }
}

/**
 * The production frame's self-declared composition identity, provided into the root graph by
 * `V2RunnerFrame.sessionRuntimeLayer`. The default marks every root that never composed the
 * production frame, so a missing/unqualified frame changes the digest instead of going unnoticed.
 */
export const FrameIdentity = Context.Reference<FrameIdentityShape>("@deepagent-code/CompositionDigestFrameIdentity", {
  defaultValue: (): FrameIdentityShape => ({
    sessionOwner: {
      execution: "unqualified:no-production-frame",
      placement: "unqualified:no-production-frame",
      coordination: "unqualified:no-production-frame",
    },
    locationHost: {
      host: "core/default-location-host",
      idleTimeToLive: "60 minutes",
      seams: [
        "core/ContextToolRuntime:unavailable",
        "core/ProductionV2Sources:empty",
        "core/SessionRunner.CurrentOnSessionSettled:none",
        "core/SessionRunner.CurrentToolSettleGate:none",
        "core/V2ProviderTurn.CurrentBuildIdentity",
        "core/V2ProviderTurn.CurrentOwnerAuthorizationPublicKey",
      ],
    },
  }),
})

const ownerServices = [
  SessionV2.Service,
  SessionExecution.Service,
  SessionRestart.Service,
  SessionRuntimeStatus.Service,
  SessionStore.Service,
] as const

/**
 * Collect the composition digest of the root this effect runs in. Every yielded service is a live
 * resolvability proof of the owner graph; the requirements intentionally stay on the effect (not a
 * layer) so the digest always reflects the CALLING root's full context.
 */
export const current: Effect.Effect<
  Record,
  never,
  | Database.Service
  | ApplicationTools.Service
  | ToolRegistry.Service
  | InstanceStore.Service
  | SessionV2.Service
  | SessionExecution.Service
  | SessionRestart.Service
  | SessionRuntimeStatus.Service
  | SessionStore.Service
  | LocationServiceMap
> = Effect.gen(function* () {
  const database = yield* Database.Service
  const identity = yield* FrameIdentity
  yield* Effect.all([...ownerServices, LocationServiceMap], { discard: true })
  const tools = yield* ToolRegistry.Service
  const applications = yield* ApplicationTools.Service
  const instances = yield* InstanceStore.Service
  // Tool registration is instance-scoped; the root's canonical instance is the production workspace
  // (`process.cwd()`, the same directory both roots hand to `productionSourcesLayer`).
  const ids = (yield* instances.provide({ directory: process.cwd() }, tools.ids())).toSorted()
  const applicationIDs = [...applications.entries().keys()].toSorted()
  const coreRegistry = yield* Effect.promise(() => import("@deepagent-code/core/tool/registry"))
  const materialization = yield* coreRegistry.ToolRegistry.Service.use((registry) => registry.materialize()).pipe(
    Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(process.cwd()) })),
  )
  const registeredIDs = [...materialization.registeredIDs].toSorted()
  const files = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list").pipe(Effect.orDie)
  const opened = files.find((row) => row.name === "main")?.file
  const facets: Facets = {
    sessionOwner: {
      execution: identity.sessionOwner.execution,
      placement: identity.sessionOwner.placement,
      coordination: identity.sessionOwner.coordination,
      services: ownerServices.map((service) => service.key).toSorted(),
    },
    v2Registry: {
      applicationTools: {
        count: applicationIDs.length,
        ids: applicationIDs,
        digest: ContractDigest.contentDigest({ kind: "application-tools", ids: applicationIDs }),
      },
      materialized: {
        count: registeredIDs.length,
        ids: registeredIDs,
        effectKinds: {
          readOnly: registeredIDs.filter((id) => materialization.effectKind(id) === "read_only").length,
          mutating: registeredIDs.filter((id) => materialization.effectKind(id) === "mutating").length,
        },
      },
      legacyEgress: {
        count: ids.length,
        ids,
        digest: ContractDigest.contentDigest({ kind: "tool-registry", ids }),
      },
    },
    authoritySurface,
    database: {
      path: opened ? opened : ":memory:",
      migrationRegistryDigest: DatabaseUpgradeRun.registryDigest(migrations),
      ...(database.mode ? { bootstrapDigest: database.mode.diagnostics.buildDigest } : {}),
      readerProtocol: Database.SupportedReaderProtocol,
      writerProtocol: Database.SupportedWriterProtocol,
    },
    locationHost: {
      host: identity.locationHost.host,
      map: LocationServiceMap.key,
      idleTimeToLive: identity.locationHost.idleTimeToLive,
      seams: [...identity.locationHost.seams],
    },
  }
  return { version: 2 as const, digest: compute(facets), ...facets }
})

export * as CompositionDigest from "./composition-digest"
