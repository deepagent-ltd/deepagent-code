import { expect, test } from "bun:test"
import { Effect } from "effect"
import { IMServiceConfig } from "../../src/im/service-config"

test("IM service coordinates come only from global config, with null disabling environment fallback", async () => {
  const env = { DEEPAGENT_IM_FACADE_URL: "https://environment.invalid/old/" }
  const config = { getGlobal: () => Effect.succeed({ im: { url: "https://configured.invalid/platform///" } }) }
  expect(await Effect.runPromise(IMServiceConfig.read(config, env))).toEqual({
    url: "https://configured.invalid/platform",
    source: "config",
  })
  expect(
    await Effect.runPromise(IMServiceConfig.read({ getGlobal: () => Effect.succeed({ im: { url: null } }) }, env)),
  ).toEqual({ url: null, source: "config" })
  expect(await Effect.runPromise(IMServiceConfig.read({ getGlobal: () => Effect.succeed({}) }, env))).toEqual({
    url: "https://environment.invalid/old",
    source: "environment",
  })
  expect(await Effect.runPromise(IMServiceConfig.read(undefined, {}))).toEqual({ url: null, source: "none" })
  expect(
    (
      await Effect.runPromise(
        IMServiceConfig.read(undefined, { DEEPAGENT_IM_FACADE_URL: "http://example.com" }).pipe(Effect.flip),
      )
    ).code,
  ).toBe("im_device_target_invalid")
  expect(
    await Effect.runPromise(
      IMServiceConfig.read(undefined, { DEEPAGENT_IM_FACADE_URL: "http://facade.local" }, false, true),
    ),
  ).toEqual({ url: "http://facade.local", source: "environment" })
})
