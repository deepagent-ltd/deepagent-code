import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { preparePackageVersions, ReleasePackageManifests } from "./prepare-release-files"

test("release version preparation preserves upstream, native and nested dependency versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-owned-release-versions-"))
  const untouched = [
    ["packages/im-kernel-sdk/upstream/package.json", "{\"name\":\"webim-sdk\",\"version\":\"1.9.17\"}\n"],
    ["packages/tui/package.json", "{\"name\":\"@deepagent-code/tui\",\"version\":\"0.0.0\"}\n"],
    ["packages/http-recorder/package.json", "{\"name\":\"@deepagent-code/http-recorder\",\"version\":\"0.0.0\"}\n"],
    ["packages/desktop/native/package.json", "{\"name\":\"dac-native-helper\",\"version\":\"0.0.0\"}\n"],
    ["node_modules/vendor/package.json", "{\"name\":\"vendor\",\"version\":\"2.0.3\"}\n"],
  ] as const
  try {
    await Promise.all(ReleasePackageManifests.map((entry) => Bun.write(path.join(root, entry[0]), JSON.stringify({
      name: entry[1], version: "2.0.3", dependencies: { fixture: "2.0.3" }, metadata: { version: "upstream-version" },
    }))))
    await Promise.all(untouched.map((entry) => Bun.write(path.join(root, entry[0]), entry[1])))
    await preparePackageVersions("2.0.4", root)
    for (const entry of ReleasePackageManifests)
      expect(await Bun.file(path.join(root, entry[0])).json()).toEqual({
        name: entry[1], version: "2.0.4", dependencies: { fixture: "2.0.3" }, metadata: { version: "upstream-version" },
      })
    for (const entry of untouched) expect(await Bun.file(path.join(root, entry[0])).text()).toBe(entry[1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a wrong distribution identity fails before modifying any release package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-owned-release-identity-"))
  try {
    await Promise.all(ReleasePackageManifests.map((entry) => Bun.write(path.join(root, entry[0]), JSON.stringify({
      name: entry[0] === "packages/desktop/package.json" ? "unexpected-upstream" : entry[1], version: "2.0.3",
    }))))
    await expect(preparePackageVersions("2.0.4", root)).rejects.toThrow("Unexpected release package identity")
    for (const entry of ReleasePackageManifests)
      expect((await Bun.file(path.join(root, entry[0])).json()).version).toBe("2.0.3")
    await expect(preparePackageVersions("", root)).rejects.toThrow("release version is required")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
