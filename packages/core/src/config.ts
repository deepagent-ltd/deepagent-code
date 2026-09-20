export * as Config from "./config"

import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import * as Log from "./util/log"

import { Location } from "./location"
import { PermissionSchema } from "./permission/schema"
import { Policy } from "./policy"
import { ServerCapabilities } from "./server-capabilities"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigVariable } from "./config/variable"
import { Flag } from "./flag/flag"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  permissions: PermissionSchema.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  docs_sync: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Maintain docs/deepagent project documents after each session settles (W10; default false — reading the documents needs no flag)",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

/** Every field accepted by the Core V2 runtime schema has a named production consumer. */
export const RuntimeFieldConsumers = {
  $schema: "editor-metadata",
  shell: "BashTool",
  model: "ConfigProviderPlugin",
  default_agent: "ConfigAgentPlugin",
  permissions: "ConfigAgentPlugin",
  agents: "ConfigAgentPlugin-and-SessionRunner",
  watcher: "Watcher",
  attachments: "Image",
  tool_output: "ToolOutputStore",
  compaction: "SessionRunnerCompaction",
  skills: "ConfigSkillPlugin",
  commands: "ConfigCommandPlugin",
  references: "ProjectReference",
  docs_sync: "ProjectDocsSync",
  experimental: "Policy",
  providers: "ConfigProviderPlugin",
} as const satisfies Record<keyof Info, string>

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/Config") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    // "config.jsonc" is the canonical global config name the deepagent-code config service
    // consolidates legacy files into (and removes the originals); without it a consolidated
    // global config — providers, model defaults — is invisible to every V2 Location.
    const names = ["config.json", "deepagent-code.json", "deepagent-code.jsonc", "config.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "error", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownEffect(Info, decodeOptions)
    const decodeV1Info = Schema.decodeUnknownEffect(ConfigV1.Info, decodeOptions)

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return

      const errors: ParseError[] = []
      const input: unknown = parse(
        yield* ConfigVariable.substitute({ text, path: filepath, filesystem: fs }),
        errors,
        { allowTrailingComma: true },
      )
      if (errors.length)
        return yield* Effect.die(
          new Error(
            `Invalid config JSON in ${filepath}: ${errors.map((error) => `${error.error}@${error.offset}`).join(", ")}`,
          ),
        )

      const v1 = ConfigMigrateV1.isV1(input)
      const unsupported = unsupportedRuntimeFields(input, v1)
      if (unsupported.length > 0) {
        return yield* Effect.die(
          new Error(
            `Unsupported Core V2 config in ${filepath}: ${unsupported.join(", ")}. ` +
              "These fields have no active Core V2 production consumer.",
          ),
        )
      }
      // Removed-feature leftovers (the share/autoupdate era) are stripped with a warning
      // instead of failing the load: an upgrading user's stale key must not brick project
      // reloads, and the field has no semantics left to protect.
      const leftover = removedFeatureFields(input)
      if (leftover.length > 0) {
        Log.Default.warn("config", {
          filepath,
          stripped: leftover,
          note: "fields of removed features; no Core V2 consumer exists",
        })      }

      // Disabled-compatibility fields are stripped in BOTH branches: an explicitly-disabled
      // value (formatter/lsp/snapshot/snapshots = false) is accepted regardless of which
      // generation's shape the file uses.
      const stripped = withoutRemovedFeatureFields(withoutDisabledCompatibilityFields(input))
      const info = yield* (v1
        ? decodeV1Info(stripped).pipe(Effect.map(ConfigMigrateV1.migrate), Effect.flatMap(decodeInfo))
        : decodeInfo(stripped)
      ).pipe(
        Effect.mapError((error) => new Error(`Invalid config in ${filepath}: ${error.message}`)),
        Effect.orDie,
      )
      return new Document({ type: "document", path: filepath, info })
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".deepagent-code", ...names.toReversed()],
            start: location.directory,
            stop: location.project.directory,
          })
          .pipe(Effect.orDie)
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => path.basename(item) === ".deepagent-code")
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".deepagent-code").toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.deepagent-code` files.
    const configs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat()]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    // User/repo config statements first, then admin-controlled ServerCapabilities
    // statements LAST: Policy.evaluate is last-match-wins, so admin denies win
    // over anything the user's config tried to allow. In local/desktop mode
    // envStatements() is empty and this is a no-op (see server-capabilities.ts).
    yield* policy.load([
      ...configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
      ...ServerCapabilities.envStatements(),
    ])

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
    })
  }),
)

function unsupportedRuntimeFields(input: unknown, v1: boolean) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const info = input as Record<string, unknown>
  const fields = v1
    ? [
        ["snapshot", "snapshot"],
        ["formatter", "formatter"],
        ["lsp", "lsp"],
        ["mcp", "mcp"],
        ["instructions", "instructions"],
        ["plugin", "plugin"],
        ["reference", "reference (DEEPAGENT_CODE_EXPERIMENTAL_REFERENCES is disabled)"],
      ]
    : [
        ["snapshots", "snapshots"],
        ["formatter", "formatter"],
        ["lsp", "lsp"],
        ["mcp", "mcp"],
        ["instructions", "instructions"],
        ["plugins", "plugins"],
        ["learning", "learning.project_copy"],
        ["references", "references (DEEPAGENT_CODE_EXPERIMENTAL_REFERENCES is disabled)"],
      ]
  return [
    ...fields
      .filter(([key]) => info[key] !== undefined)
      .filter(([key]) => !isDisabledCompatibilityField(key, info[key]))
      .filter(([key]) => (key === "reference" || key === "references" ? !Flag.DEEPAGENT_CODE_EXPERIMENTAL_REFERENCES : true))
      .map(([, label]) => label),
  ]
}

function isDisabledCompatibilityField(key: string, value: unknown) {
  // `false` is the explicit disabled-compat value (live harness configs and product defaults
  // write it); any other value keeps the unsupported-field refusal.
  return (key === "formatter" || key === "lsp" || key === "snapshot" || key === "snapshots") && value === false
}

function withoutDisabledCompatibilityFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !isDisabledCompatibilityField(key, value)),
  )
}

// Fields of features that were REMOVED entirely (share/autoupdate era). Unlike the
// unsupported-runtime gate above, these are stripped with a warning: the feature they
// configured no longer exists, so the only correct action is deletion, and bricking
// project reloads for an upgrading user's stale key is hostile.
const REMOVED_FEATURE_FIELDS = new Set(["autoupdate", "share", "autoshare", "enterprise", "username"])

function removedFeatureFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  return Object.keys(input).filter((key) => REMOVED_FEATURE_FIELDS.has(key))
}

function withoutRemovedFeatureFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !REMOVED_FEATURE_FIELDS.has(key)))
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))
