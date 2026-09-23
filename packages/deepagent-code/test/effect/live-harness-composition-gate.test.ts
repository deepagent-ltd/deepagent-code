import { expect, test } from "bun:test"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { Root } from "../../src/effect/root"
import { assertHarnessComposition } from "../../script/live-llm/composition-gate"
import { liveFrameIdentity } from "../../script/live-llm/runner-frame"

test("G3 rejects a live harness whose fixture plugin bridge did not register", async () => {
  const production = await Root.compositionDigest()
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
  assertHarnessComposition(harness, production.v2Registry.applicationTools.ids)
  expect(() => assertHarnessComposition(harness, [...production.v2Registry.applicationTools.ids, "missing_plugin_tool"]))
    .toThrow("fixture application tools")
  expect(() =>
    assertHarnessComposition(
      {
        ...harness,
        locationHost: { ...harness.locationHost, seams: production.locationHost.seams },
      },
      production.v2Registry.applicationTools.ids,
    ),
  ).toThrow("digest content")
}, 180_000)
