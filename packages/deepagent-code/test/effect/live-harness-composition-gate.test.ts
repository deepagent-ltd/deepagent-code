import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { AppLayer } from "../../src/effect/app-runtime"
import { assertHarnessComposition } from "../../script/live-llm/composition-gate"
import { liveFrameIdentity } from "../../script/live-llm/runner-frame"

test("G3 rejects a live harness whose fixture plugin bridge did not register", async () => {
  const production = await Effect.runPromise(CompositionDigest.current.pipe(Effect.provide(AppLayer), Effect.scoped))
  const facets = {
    sessionOwner: production.sessionOwner,
    v2Registry: production.v2Registry,
    authoritySurface: production.authoritySurface,
    database: production.database,
    locationHost: {
      ...production.locationHost,
      host: liveFrameIdentity.locationHost.host,
      seams: [...liveFrameIdentity.locationHost.seams],
    },
  }
  const harness = { version: 2 as const, digest: CompositionDigest.compute(facets), ...facets }
  await assertHarnessComposition(harness, production, production.v2Registry.applicationTools.ids)
  await expect(assertHarnessComposition(harness, production, [...production.v2Registry.applicationTools.ids, "missing_plugin_tool"]))
    .rejects.toThrow("fixture application tools")
  await expect(
    assertHarnessComposition(
      {
        ...harness,
        locationHost: { ...harness.locationHost, seams: production.locationHost.seams },
      },
      production,
      production.v2Registry.applicationTools.ids,
    ),
  ).rejects.toThrow("digest content")
  const changedOwner = { ...production.sessionOwner, placement: "different-owner-placement" }
  await expect(assertHarnessComposition(harness, {
    ...production,
    sessionOwner: changedOwner,
    digest: CompositionDigest.compute({ ...facets, sessionOwner: changedOwner, locationHost: production.locationHost }),
  })).rejects.toThrow("production composition drift at sessionOwner.placement")
}, 180_000)
