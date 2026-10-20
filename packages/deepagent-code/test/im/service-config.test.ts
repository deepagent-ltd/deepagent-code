import { expect, test } from "bun:test"
import { Effect } from "effect"
import { IMServiceConfig } from "../../src/im/service-config"

test("IM service prioritizes global config, environment and the formal default, preserving explicit disable", async () => {
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
  expect(await Effect.runPromise(IMServiceConfig.read(undefined, {}))).toEqual({
    url: "https://ai.deepagent.ltd/im",
    source: "default",
  })
  expect(await Effect.runPromise(IMServiceConfig.read({ getGlobal: () => Effect.succeed({}) }, {}))).toEqual({
    url: "https://ai.deepagent.ltd/im",
    source: "default",
  })
  expect(
    await Effect.runPromise(IMServiceConfig.read({ getGlobal: () => Effect.succeed({ im: { url: null } }) }, {})),
  ).toEqual({ url: null, source: "config" })
  expect(await Effect.runPromise(IMServiceConfig.read(undefined, { DEEPAGENT_IM_FACADE_URL: "" }))).toEqual({
    url: null,
    source: "environment",
  })
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
