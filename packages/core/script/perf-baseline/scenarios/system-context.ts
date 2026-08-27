import * as fs from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { SystemContext } from "@deepagent-code/core/system-context"
import { tempRoot, summarizeGroups, timeEffect, Recorder, type ScenarioOutcome } from "../lib"

export interface SystemContextOptions {
  readonly warmup: number
  readonly measured: number
  /** Mirrors the core/builtins environment block size, which scales with cwd depth. */
  readonly environmentBytes: number
}

const dateSource = () =>
  SystemContext.make({
    key: SystemContext.Key.make("perf/date"),
    codec: Schema.toCodecJson(Schema.String),
    load: Effect.succeed(new Date().toDateString()),
    baseline: (date) => `Today's date: ${date}`,
    update: (_previous, date) => `Today's date is now: ${date}`,
  })

/**
 * Builds the real registry layer and registers one combined context group whose
 * sources mirror packages/core/src/system-context/builtins.ts shapes (environment
 * block + date block), then times registry.load() — the combine algebra production
 * runs when system context is built before dispatch. Entry loads here are
 * deterministic strings; the built-in environment source's filesystem/git probing
 * is NOT included in the timed path (declared deviation).
 */
export const runSystemContext = async (options: SystemContextOptions): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const root = tempRoot("system-context")

  const filler = "x".repeat(Math.max(0, options.environmentBytes - 160))
  const environmentText = [
    "<env>",
    `  Working directory: ${process.cwd()}`,
    `  Workspace root folder: ${process.cwd()}`,
    "  Is directory a git repo: yes",
    `  Platform: ${process.platform}`,
    `  Filler: ${filler}`,
    "</env>",
  ].join("\n")

  const environmentSource = () =>
    SystemContext.make({
      key: SystemContext.Key.make("perf/environment"),
      codec: Schema.toCodecJson(Schema.String),
      load: Effect.succeed(environmentText),
      baseline: (environment) => `Environment:\n${environment}`,
      update: (_previous, environment) => `Environment refreshed:\n${environment}`,
    })

  const program = Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const recorder = new Recorder()
    const combined = SystemContext.combine([environmentSource(), dateSource()])
    yield* registry.register({
      key: SystemContext.Key.make("perf/environment-group"),
      load: Effect.succeed(combined),
    })

    for (let index = 0; index < options.warmup; index++) {
      const [, elapsed] = yield* timeEffect(registry.load())
      recorder.add("registry_load_warmup", elapsed)
    }
    for (let index = 0; index < options.measured; index++) {
      const [, elapsed] = yield* timeEffect(registry.load())
      recorder.add("registry_load_measured", elapsed)
    }
    return { groups: recorder.results(), environment_bytes: environmentText.length }
  }).pipe(
    Effect.provide(Layer.mergeAll(SystemContextRegistry.layer)),
    Effect.scoped,
  )

  try {
    const result = await Effect.runPromise(program)
    return summarizeGroups(
      {
        name: "system-context-build",
        owner_note:
          "current authority = SystemContextRegistry.load over registered entries (packages/core/src/system-context/registry.ts); per-entry payloads are deterministic builtin-mirroring strings",
        status: "ok",
        evidence_refs: ["packages/core/src/system-context/registry.ts", "packages/core/src/system-context/builtins.ts"],
        groups: result.groups,
        extras: {
          unit: "ms",
          sample_basis:
            "60 registry.load samples after 5 warmups; sources are deterministic strings so variance is tiny and modest N is sufficient; real builtin filesystem/git probing excluded (see deviation)",
          environment_block_bytes: result.environment_bytes,
          registered_entry_keys: "perf/environment-group (2 sources: perf/environment, perf/date)",
          deviation:
            "timed path excludes the production built-in sources' filesystem/git probing load effects",
        },
      },
      performance.now() - startedAt,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
