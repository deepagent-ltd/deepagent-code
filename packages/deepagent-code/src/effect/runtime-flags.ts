import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
// A capability that ships ON by default but can be explicitly disabled with `=false` (U5: background
// subagents are promoted from experimental to a stable local capability in V3.3).
const stableOn = (name: string) => Config.boolean(name).pipe(Config.withDefault(true))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("DEEPAGENT_CODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@deepagent-code/RuntimeFlags", {
  autoShare: bool("DEEPAGENT_CODE_AUTO_SHARE"),
  pure: bool("DEEPAGENT_CODE_PURE"),
  disableDefaultPlugins: bool("DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("DEEPAGENT_CODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE"),
    direct: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE"),
    direct: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("DEEPAGENT_CODE_ENABLE_EXA"),
    legacy: bool("DEEPAGENT_CODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("DEEPAGENT_CODE_ENABLE_PARALLEL"),
    legacy: bool("DEEPAGENT_CODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("DEEPAGENT_CODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("DEEPAGENT_CODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_REFERENCES"),
  // U5 (V3.3): promoted from experimental to a stable LOCAL capability — background subagents are on
  // by default. NOTE: this is local, non-durable (process restart loses live jobs); cross-restart
  // recovery + remote/cloud agents are deferred to V3.4 (S1 §10). Disable with =false.
  experimentalBackgroundSubagents: stableOn("DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("DEEPAGENT_CODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("DEEPAGENT_CODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("DEEPAGENT_CODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("DEEPAGENT_CODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
