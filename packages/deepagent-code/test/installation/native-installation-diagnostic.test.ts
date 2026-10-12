import { expect, test } from "bun:test"
import { Effect } from "effect"
import { inspectNativeInstallation } from "../../src/cli/cmd/debug/native-installation"

test("source invocation is typed unavailable and cannot describe a fake installed runtime", async () => {
  const result = await Effect.runPromise(inspectNativeInstallation())
  expect(result.state).toBe("unavailable")
  if (result.state !== "unavailable") throw new Error("Source invocation became an installed runtime")
  expect(result.code).toBe("NATIVE_INSTALLATION_UNAVAILABLE")
  expect(result.verifiedAssetCount).toBe(0)
  const text = JSON.stringify(result)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192)
  expect(text).not.toContain("privateKey")
  expect(text).not.toContain(process.cwd())
})
