import { describe, expect, test } from "bun:test"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Effect } from "effect"
import { stat } from "node:fs/promises"
import path from "node:path"
import { layer } from "../../src/context-federation/token-service"
import { tmpdir } from "../fixture/fixture"

describe("LiveContextTokenCodec", () => {
  test("creates one private keyring under concurrent startup and preserves tokens across restart", async () => {
    if (process.platform === "win32") {
      const runner = process.env.RUNNER_TEMP
      if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
        throw new Error("Native token tests require D: scratch space")
      const { acquire } = await import("../fixture/windows-native-node-cohort")
      const cohort = await acquire({
        directory: runner,
        nodeEntry: path.resolve(import.meta.dir, "../mcp/fixture/windows-native-mcp-host.ts"),
      })
      const result = await cohort.run()
      expect(result, JSON.stringify(result)).toMatchObject({ code: 0 })
      expect(await Bun.file(path.join(result.root, "mcp-probe.json")).json()).toMatchObject({
        nativeInstallation: true,
        originalPreload: true,
        token: { concurrentStartup: true, restartRead: true, privateParentAcl: true, keyringAcl: true },
      })
      return
    }
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "state", "token-keyring.json")
    const [first, second] = await Promise.all([codec(filename), codec(filename)])
    const token = first.sealContextRef(
      {
        graph: "code",
        entityId: "entity",
        binding: { scope: "builtin" },
        revision: "revision",
      },
      { issuedAt: 1, expiresAt: 10_000 },
    )

    expect(await Effect.runPromise(second.openContextRef(token, 2))).toMatchObject({ entityId: "entity" })
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(filename).json()).toMatchObject({
      activeKeyId: expect.any(String),
      keys: [expect.any(Object)],
    })
  }, 300_000)
})

function codec(filename: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ContextTokenCodec.Service
    }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
  )
}
