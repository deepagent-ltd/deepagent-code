import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { it } from "../lib/effect"

const fromConfig = (input: Record<string, unknown>) =>
  RuntimeFlags.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readFlags = RuntimeFlags.Service.useSync((flags) => flags)

describe("RuntimeFlags", () => {
  it.effect("defaultLayer defaults autoShare to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.autoShare).toBe(false)
    }),
  )

  it.effect("U5: background subagents default ON (stable local capability) and can be disabled with =false", () =>
    Effect.gen(function* () {
      const on = yield* readFlags.pipe(Effect.provide(fromConfig({})))
      expect(on.experimentalBackgroundSubagents).toBe(true)
      const off = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false" })),
      )
      expect(off.experimentalBackgroundSubagents).toBe(false)
    }),
  )

  it.effect("defaultLayer parses plugin flags from the active ConfigProvider", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            DEEPAGENT_CODE_PURE: "true",
            DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "true",
            DEEPAGENT_CODE_AUTO_SHARE: "true",
            DEEPAGENT_CODE_DISABLE_EMBEDDED_WEB_UI: "true",
            DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "true",
            DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "true",
            DEEPAGENT_CODE_EXPERIMENTAL: "true",
            DEEPAGENT_CODE_ENABLE_EXA: "true",
            DEEPAGENT_CODE_ENABLE_PARALLEL: "true",
            DEEPAGENT_CODE_ENABLE_EXPERIMENTAL_MODELS: "true",
            DEEPAGENT_CODE_ENABLE_QUESTION_TOOL: "true",
            DEEPAGENT_CODE_CLIENT: "desktop",
          }),
        ),
      )

      expect(flags.pure).toBe(true)
      expect(flags.autoShare).toBe(true)
      expect(flags.disableDefaultPlugins).toBe(true)
      expect(flags.disableEmbeddedWebUi).toBe(true)
      expect(flags.disableExternalSkills).toBe(true)
      expect(flags.disableLspDownload).toBe(true)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.enableExa).toBe(true)
      expect(flags.enableParallel).toBe(true)
      expect(flags.enableExperimentalModels).toBe(true)
      expect(flags.enableQuestionTool).toBe(true)
      expect(flags.experimentalReferences).toBe(true)
      expect(flags.experimentalBackgroundSubagents).toBe(true)
      expect(flags.experimentalLspTy).toBe(false)
      expect(flags.experimentalLspTool).toBe(true)
      expect(flags.experimentalOxfmt).toBe(true)
      expect(flags.experimentalPlanMode).toBe(true)
      expect(flags.experimentalEventSystem).toBe(true)
      expect(flags.experimentalWorkspaces).toBe(true)
      expect(flags.experimentalIconDiscovery).toBe(true)
      expect(flags.experimentalNativeLlm).toBe(false)
      expect(flags.experimentalWebSockets).toBe(false)
      expect(flags.client).toBe("desktop")
    }),
  )

  it.effect("§H3 / V4.1: flag rollout posture — promoted-ON vs still-opt-in", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))
      // Still operator opt-in (default OFF): experimental or risky features not yet broadly tested.
      expect(flags.v4EventDrivenIm).toBe(false)
      expect(flags.v4ThreadEnabled).toBe(false)
      expect(flags.v4FileUploadEnabled).toBe(false)
      // Promoted ON (stableOn): daemon audit GO, broadly deployed.
      expect(flags.v4AgentPushEnabled).toBe(true)
      expect(flags.v4PanelAutoConvene).toBe(true)
      // V4.1: the Multi-Agent Runtime master switch is PROMOTED ON — the daemon audit is GO and the §N
      // event-driven goal-tick chain (with cross-process cold recovery) is now the live driver.
      expect(flags.v4MultiAgentRuntime).toBe(true)
    }),
  )

  it.effect("V4.1: v4MultiAgentRuntime is a real kill-switch (=false restores the inert posture)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "false" })),
      )
      expect(flags.v4MultiAgentRuntime).toBe(false)
    }),
  )

  it.effect("§H1: each still-opt-in V4.0 flag is an independent opt-in (=true enables just that one)", () =>
    Effect.gen(function* () {
      // turning ONE still-opt-in flag on must not affect others — operator advances rollout
      // capability by capability. Uses v4ThreadEnabled, which remains OFF-by-default.
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_V4_THREAD_ENABLED: "true" })),
      )
      expect(flags.v4ThreadEnabled).toBe(true)
      expect(flags.v4EventDrivenIm).toBe(false)
      expect(flags.v4FileUploadEnabled).toBe(false)
      // stableOn flags are unaffected by the override — they remain ON
      expect(flags.v4AgentPushEnabled).toBe(true)
      expect(flags.v4PanelAutoConvene).toBe(true)
    }),
  )

  it.effect("§H1: all six V4.0 flags can be turned ON together via env (full-stack opt-in)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM: "true",
            DEEPAGENT_CODE_V4_AGENT_PUSH_ENABLED: "true",
            DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "true",
            DEEPAGENT_CODE_V4_THREAD_ENABLED: "true",
            DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED: "true",
            DEEPAGENT_CODE_V4_PANEL_AUTO_CONVENE: "true",
          }),
        ),
      )
      expect(flags.v4EventDrivenIm).toBe(true)
      expect(flags.v4AgentPushEnabled).toBe(true)
      expect(flags.v4MultiAgentRuntime).toBe(true)
      expect(flags.v4ThreadEnabled).toBe(true)
      expect(flags.v4FileUploadEnabled).toBe(true)
      expect(flags.v4PanelAutoConvene).toBe(true)
    }),
  )

  it.effect("defaultLayer parses DEEPAGENT_CODE_EXPERIMENTAL_LSP_TY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            DEEPAGENT_CODE_EXPERIMENTAL_LSP_TY: "true",
          }),
        ),
      )

      expect(flags.experimentalLspTy).toBe(true)
    }),
  )

  it.effect("enables native LLM via dedicated flag only", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL_NATIVE_LLM: "true" })),
      )
      const umbrella = yield* readFlags.pipe(Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL: "true" })))

      expect(explicit.experimentalNativeLlm).toBe(true)
      expect(umbrella.experimentalNativeLlm).toBe(false)
    }),
  )

  it.effect("enables WebSockets via dedicated flag only", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL_WEBSOCKETS: "true" })),
      )
      const umbrella = yield* readFlags.pipe(Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL: "true" })))

      expect(explicit.experimentalWebSockets).toBe(true)
      expect(umbrella.experimentalWebSockets).toBe(false)
    }),
  )

  it.effect("layer accepts partial test overrides and fills defaults from Config definitions", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer({ disableDefaultPlugins: true, bashDefaultTimeoutMs: 1_000 })),
      )

      expect(flags.pure).toBe(false)
      expect(flags.autoShare).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(true)
      expect(flags.disableEmbeddedWebUi).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
      expect(flags.disableLspDownload).toBe(false)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.disableClaudeCodeSkills).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBe(1_000)
      expect(flags.enableExperimentalModels).toBe(false)
      expect(flags.client).toBe("cli")
    }),
  )

  it.effect("experimentalIconDiscovery defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("disableExternalSkills defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableExternalSkills).toBe(false)
    }),
  )

  it.effect("disableExternalSkills reads DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "true" })),
      )

      expect(flags.disableExternalSkills).toBe(true)
    }),
  )

  it.effect("disableLspDownload defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableLspDownload).toBe(false)
    }),
  )

  it.effect("disableLspDownload reads DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "true" })))

      expect(flags.disableLspDownload).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableClaudeCodePrompt).toBe(false)
    }),
  )

  it.effect("disableClaudeCodePrompt reads DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_PROMPT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_PROMPT: "true" })),
      )

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt inherits DEEPAGENT_CODE_DISABLE_CLAUDE_CODE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ DEEPAGENT_CODE_DISABLE_CLAUDE_CODE: "true" })))

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("experimentalIconDiscovery reads DEEPAGENT_CODE_EXPERIMENTAL_ICON_DISCOVERY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL_ICON_DISCOVERY: "true" })),
      )

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("experimentalIconDiscovery inherits DEEPAGENT_CODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ DEEPAGENT_CODE_EXPERIMENTAL: "true" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("specific experimental flags override DEEPAGENT_CODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            DEEPAGENT_CODE_EXPERIMENTAL: "true",
            DEEPAGENT_CODE_EXPERIMENTAL_ICON_DISCOVERY: "false",
          }),
        ),
      )

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalOxfmt).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt is enabled by DEEPAGENT_CODE_EXPERIMENTAL_OXFMT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            DEEPAGENT_CODE_EXPERIMENTAL_OXFMT: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  it.effect("experimentalOxfmt inherits DEEPAGENT_CODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            DEEPAGENT_CODE_EXPERIMENTAL: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "0" }, expected: undefined },
    { name: "negative", config: { DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses bashDefaultTimeoutMs from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.bashDefaultTimeoutMs).toBe(input.expected)
      }),
    )
  }

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "0" }, expected: undefined },
    { name: "negative", config: { DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses outputTokenMax from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.outputTokenMax).toBe(input.expected)
      }),
    )
  }

  it.effect("layer ignores the active ConfigProvider for omitted test overrides", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer()),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              DEEPAGENT_CODE_PURE: "true",
              DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "true",
              DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "true",
              DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "true",
              DEEPAGENT_CODE_EXPERIMENTAL: "true",
              DEEPAGENT_CODE_ENABLE_EXA: "true",
              DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1234",
              DEEPAGENT_CODE_CLIENT: "desktop",
            }),
          ),
        ),
      )

      expect(flags.pure).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(false)
      expect(flags.disableEmbeddedWebUi).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
      expect(flags.disableLspDownload).toBe(false)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.disableClaudeCodeSkills).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBeUndefined()
      expect(flags.client).toBe("cli")
    }),
  )

  it.effect("disableClaudeCodeSkills defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableClaudeCodeSkills).toBe(false)
    }),
  )

  it.effect("disableClaudeCodeSkills reads DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_SKILLS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_SKILLS: "true" })),
      )

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )

  it.effect("disableClaudeCodeSkills inherits DEEPAGENT_CODE_DISABLE_CLAUDE_CODE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ DEEPAGENT_CODE_DISABLE_CLAUDE_CODE: "true" })))

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )
})
