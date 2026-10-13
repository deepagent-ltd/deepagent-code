export * as SecretRefScope from "./secret-ref-scope"

import path from "node:path"
import { createHmac } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { AbsolutePath } from "@deepagent-code/core/schema"
import type { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { ConfigFileWrite } from "@/config/file-write"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { LocalAuthority } from "@/installation/local-authority"
import { isRecord } from "@/util/record"

export const ACCOUNT_PREFIX = "mcp-scoped-v1:"
export const Field = Schema.Literals(["environment", "headers", "oauth"])
export type Field = typeof Field.Type
export class Error extends Schema.TaggedErrorClass<Error>()("McpSecretScopeError", {
  reason: Schema.Literals(["unavailable", "changed", "work_unsettled"]),
}) {
  override get message() {
    return `MCP scoped credential ${this.reason}`
  }
}
export const Binding = Schema.Struct({
  version: Schema.Literal(1),
  installationID: Schema.String,
  namespace: Schema.String,
  location: Schema.String,
  project: Schema.String,
  rootTag: Schema.String,
  principalTag: Schema.String,
  source: Schema.String,
  name: Schema.String,
  templateTag: Schema.String,
})
export type Binding = typeof Binding.Type
const identity: unique symbol = Symbol("McpSecretCapture")
const permission: unique symbol = Symbol("McpSecretPermit")
const repair: unique symbol = Symbol("McpBindingRepair")
export type BindingRepairPreview = Readonly<{
  name: string
  source: string
  old: LocationIdentity.ObservedProjectBinding
  nextObservedProjectId: string
}>
export type RepairCapture = Readonly<{ preview: BindingRepairPreview; readonly [repair]: true }>
export type Capture = Readonly<{
  binding: Binding
  file: ConfigFileWrite.File
  entry: Record<string, unknown>
  readonly [identity]: true
}>
export type Permit = Readonly<{ readonly [permission]: true }>
const captures = new WeakMap<
  Capture,
  {
    sign: (domain: string, value: unknown) => string
    binding: Binding
    entry: Record<string, unknown>
    live: () => boolean
  }
>()
const permits = new WeakMap<Permit, { account: string; live: () => boolean }>()

export interface Interface {
  readonly capture: (name: string, initialize?: boolean) => Effect.Effect<Capture, Error>
  readonly inspectBinding: (name: string) => Effect.Effect<RepairCapture, Error>
  readonly repairBinding: (
    captured: RepairCapture,
  ) => Effect.Effect<Readonly<{ name: string; source: string; state: "repaired" }>, Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpSecretRefScope") {}
/** Only the direct CLI supplies its actual cwd. HTTP/GUI consumers retain InstanceRef placement. */
export const CliDirectory = Context.Reference<string | undefined>("~deepagent-code/McpSecretCliDirectory", {
  defaultValue: () => undefined,
})
/** Only the authenticated local HTTP route supplies its validated WorkspaceRouteContext directory. */
export const RequestDirectory = Context.Reference<string | undefined>("~deepagent-code/McpSecretRequestDirectory", {
  defaultValue: () => undefined,
})
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const owner = { live: true }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        owner.live = false
      }),
    )
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { AccountRepo } = yield* Effect.promise(() => import("@/account/repo"))
    const { LocationIdentity } = yield* Effect.promise(() => import("@deepagent-code/core/context-federation/identity"))
    const config = yield* Config.Service
    const accounts = yield* AccountRepo.Service
    const identities = yield* LocationIdentity.Service
    const { Project } = yield* Effect.promise(() => import("@/project/project"))
    const projects = yield* Project.Service
    const filesystem = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const observe = (name: string, initialize = false) =>
      Effect.gen(function* () {
        if (!owner.live) return yield* new Error({ reason: "unavailable" })
        const instance = yield* InstanceRef
        const directory = yield* CliDirectory
        const requestedDirectory = yield* RequestDirectory
        if (!instance && !directory && !requestedDirectory) return yield* new Error({ reason: "unavailable" })
        const context = yield* projects.observeDirectory(requestedDirectory ?? instance?.directory ?? directory!)
        if ((yield* InstanceState.workspaceID) !== undefined || !config.mcpSnapshot)
          return yield* new Error({ reason: "unavailable" })
        const snapshot =
          instance && !requestedDirectory
            ? yield* config.mcpSnapshot()
            : config.readonlySnapshot
              ? yield* config.readonlySnapshot(context)
              : undefined
        if (!snapshot) return yield* new Error({ reason: "unavailable" })
        const source = snapshot.config.mcp_origins?.[name]
        if (!source || !path.isAbsolute(source)) return yield* new Error({ reason: "unavailable" })
        const file = yield* ConfigFileWrite.read(source)
        if (file.text === undefined) return yield* new Error({ reason: "unavailable" })
        const errors: ParseError[] = []
        const raw: unknown = parse(file.text, errors, { allowTrailingComma: true })
        const entry = isRecord(raw) && isRecord(raw.mcp) ? raw.mcp[name] : undefined
        if (errors.length || !isRecord(entry) || !["local", "remote"].includes(String(entry.type)))
          return yield* new Error({ reason: "unavailable" })
        const current = snapshot.config.mcp?.[name]
        if (
          !current ||
          !("type" in current) ||
          current.type !== entry.type ||
          (current.type === "remote" && current.url !== entry.url) ||
          (current.type === "local" &&
            CanonicalJson.stringify(current.command) !== CanonicalJson.stringify(entry.command))
        )
          return yield* new Error({ reason: "changed" })
        const installation = yield* initialize
          ? LocalAuthority.ensurePrivateInstallation()
          : LocalAuthority.readInstallation
        const requested = {
          boundary: { kind: "implicit_local" as const },
          directory: AbsolutePath.make(context.directory),
          project:
            context.project?.vcs === "git"
              ? { kind: "git" as const, observedProjectId: context.project.id }
              : { kind: "registered_root" as const, observedProjectId: projectIdForWorkspace(context.directory) },
        }
        const principal = yield* accounts.authority()
        if (principal.account && !principal.account.identity_generation)
          return yield* new Error({ reason: "unavailable" })
        const tag = (domain: string, value: unknown) =>
          createHmac("sha256", Buffer.from(installation.secret, "hex"))
            .update(`dac.mcp.secret.${domain}.v1\0`)
            .update(CanonicalJson.stringify(value))
            .digest("hex")
        const principalTag = tag(
          "principal",
          principal.account
            ? {
                kind: "account",
                id: principal.account.id,
                issuer: principal.account.url,
                generation: principal.account.identity_generation,
                orgID: principal.orgID,
                selectionRevision: principal.selectionRevision,
              }
            : { kind: "local", selectionRevision: principal.selectionRevision },
        )
        return { file, entry, installation, requested, tag, principalTag }
      })
    const repairs = new WeakMap<
      RepairCapture,
      {
        installationID: string
        principalTag: string
        file: ConfigFileWrite.File
      }
    >()
    return Service.of({
      inspectBinding: (name) =>
        Effect.gen(function* () {
          const observed = yield* observe(name)
          if (observed.requested.project.kind !== "registered_root") return yield* new Error({ reason: "unavailable" })
          const old = yield* identities.inspectObservedProjectBinding(observed.requested)
          const captured: RepairCapture = {
            [repair]: true,
            preview: Object.freeze({
              name,
              source: observed.file.path,
              old: Object.freeze(old),
              nextObservedProjectId: observed.requested.project.observedProjectId,
            }),
          }
          Object.freeze(captured)
          repairs.set(captured, {
            installationID: observed.installation.instanceID,
            principalTag: observed.principalTag,
            file: observed.file,
          })
          return captured
        }).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error({ reason: "unavailable" })))),
      repairBinding: (captured) =>
        Effect.gen(function* () {
          const saved = repairs.get(captured)
          if (!saved || !owner.live) return yield* new Error({ reason: "unavailable" })
          yield* ConfigFileWrite.transaction([saved.file.path], (tx) =>
            Effect.gen(function* () {
              const observed = yield* observe(captured.preview.name)
              if (
                !owner.live ||
                observed.installation.instanceID !== saved.installationID ||
                observed.principalTag !== saved.principalTag ||
                observed.requested.project.kind !== "registered_root" ||
                observed.requested.project.observedProjectId !== captured.preview.nextObservedProjectId ||
                observed.file.path !== saved.file.path ||
                !ConfigFileWrite.sameObservation(observed.file, saved.file) ||
                !ConfigFileWrite.sameObservation(tx.file(saved.file.path), saved.file)
              )
                return yield* new Error({ reason: "changed" })
              yield* identities.repairObservedProjectBinding({
                boundary: observed.requested.boundary,
                directory: observed.requested.directory,
                expected: captured.preview.old,
                nextObservedProjectId: observed.requested.project.observedProjectId,
              })
              yield* identities.lookup(observed.requested)
            }),
          ).pipe(Effect.provideService(FSUtil.Service, filesystem), Effect.provideService(EffectFlock.Service, flock))
          repairs.delete(captured)
          return { name: captured.preview.name, source: captured.preview.source, state: "repaired" as const }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof LocationIdentity.WorkUnsettledError
              ? new Error({ reason: "work_unsettled" })
              : error instanceof LocationIdentity.ConflictError ||
                  (error instanceof ConfigFileWrite.Error && error.reason === "changed")
                ? new Error({ reason: "changed" })
                : error instanceof Error
                  ? error
                  : new Error({ reason: "unavailable" }),
          ),
        ),
      capture: (name, initialize = false) =>
        Effect.gen(function* () {
          const observed = yield* observe(name, initialize)
          if (initialize) yield* identities.resolve(observed.requested)
          const placed = yield* identities.lookup(observed.requested)
          const file = observed.file
          const entry = observed.entry
          const installation = observed.installation
          const tag = observed.tag
          const template = {
            ...entry,
            ...Object.fromEntries(
              ["environment", "headers", "oauth"].flatMap((field) => {
                if (!isRecord(entry[field])) return []
                return [
                  [
                    field,
                    Object.fromEntries(
                      Object.entries(entry[field]).map(([key, value]) => [
                        key,
                        field !== "oauth" || key === "clientSecret" ? "<credential-slot>" : value,
                      ]),
                    ),
                  ],
                ]
              }),
            ),
          }
          const captured: Capture = {
            [identity]: true,
            file,
            entry,
            binding: {
              version: 1,
              installationID: installation.instanceID,
              namespace: placed.securityNamespaceId,
              location: placed.locationKey,
              project: placed.projectScopeKey,
              rootTag: tag("root", placed.canonicalRoot),
              principalTag: observed.principalTag,
              source: file.path,
              name,
              templateTag: tag("template", template),
            },
          }
          Object.freeze(captured.binding)
          if (captured.file.stamp) Object.freeze(captured.file.stamp)
          Object.freeze(captured.file)
          captures.set(captured, {
            sign: tag,
            binding: captured.binding,
            entry: structuredClone(entry),
            live: () => owner.live,
          })
          return captured
        }).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error({ reason: "unavailable" })))),
    })
  }),
)
// Project imports Command -> MCP. Delay dependency selection until the existing
// composition builds; return the original layer objects so the memo map still deduplicates them.
export const defaultLayer = Layer.unwrap(
  Effect.promise(async () => {
    const { Config } = await import("@/config/config")
    const { AccountRepo } = await import("@/account/repo")
    const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
    const { Project } = await import("@/project/project")
    return layer.pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(AccountRepo.defaultLayer),
      Layer.provide(LocationIdentity.defaultLayer),
      Layer.provide(Project.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(EffectFlock.defaultLayer),
    )
  }),
)

export function value(captured: Capture, field: Field, key: string) {
  if (!captures.get(captured)?.live() || (field === "oauth" && key !== "clientSecret"))
    throw new Error({ reason: "unavailable" })
  const record = captures.get(captured)!.entry[field]
  return isRecord(record) && typeof record[key] === "string" ? record[key] : undefined
}
export function tag(captured: Capture, domain: "value", value: unknown) {
  const saved = captures.get(captured)
  if (!saved?.live()) throw new Error({ reason: "unavailable" })
  return saved.sign(domain, value)
}
export function prefix(captured: Capture, field: Field, key: string) {
  const saved = captures.get(captured)
  if (!saved?.live() || value(captured, field, key) === undefined) throw new Error({ reason: "unavailable" })
  return `${ACCOUNT_PREFIX}${saved.sign("reference", { binding: saved.binding, field, key })}:`
}
/** Only a capture minted from the actual services can create a backend permit. */
export function permit(captured: Capture, field: Field, key: string, account: string) {
  if (
    !account.startsWith(prefix(captured, field, key)) ||
    !/^[a-f0-9]{32}$/.test(account.slice(prefix(captured, field, key).length))
  )
    throw new Error({ reason: "changed" })
  const result: Permit = { [permission]: true }
  permits.set(result, { account, live: captures.get(captured)!.live })
  return result
}
export function account(permit: Permit) {
  const result = permits.get(permit)
  if (!result?.live()) throw new Error({ reason: "unavailable" })
  return result.account
}
