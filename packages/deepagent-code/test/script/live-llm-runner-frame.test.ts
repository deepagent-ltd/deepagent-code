import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Flag } from "@deepagent-code/core/flag/flag"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { liveLocationServiceMap } from "../../script/live-llm/runner-frame"
import { tmpdir } from "../fixture/fixture"

// A1-06 regression pin: the live harness must serve the PRODUCTION V2 context-tool seam, not
// Core's honest-unavailable bare host. This builds the real harness map (no mocks) for a fresh
// workspace and asserts the keyed Location tree advertises code_intel/context_query — the exact
// wiring `script/live-llm/runtime.ts` consumes. Offline: the models.dev fetch is disabled and the
// index runtime cold-bootstraps from the fixture directory.
describe("live-llm harness runner frame", () => {
  test("liveLocationServiceMap advertises the real code_intel/context_query tools", async () => {
    await using fixture = await tmpdir()
    const root = path.join(fixture.path, "repo")
    await Bun.write(
      path.join(root, "src", "evidence.ts"),
      "export function codeIntelSentinel() { return 'sentinel' }\n",
    )

    const previous = Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH
    Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
    try {
      const definitions = await Effect.runPromise(
        Effect.gen(function* () {
          return (yield* (yield* ToolRegistry.Service).materialize()).definitions.map((tool) => tool.name)
        }).pipe(
          Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(root) })),
          Effect.provide(liveLocationServiceMap()),
          Effect.scoped,
        ),
      )

      expect(definitions).toContain("code_intel")
      expect(definitions).toContain("context_query")
    } finally {
      Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = previous
    }
  }, 30_000)
})
