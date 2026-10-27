import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MediaSdkOnce } from "./fixture/kernel-media-sdk-once"

test("media SDK fixture refuses unknown roots and an owned-prefix symlink to a different home", async () => {
  const unknown = await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-unknown-"))
  const outside = await fs.mkdtemp(path.join(process.env.DEEPAGENT_CODE_TEST_HOME!, "dac-im-media-product-"))
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), "dac-im-media-product-"))
  const redirected = path.join(unknown, "redirected")
  try {
    await fs.rm(owned, { recursive: true })
    await fs.symlink(outside, owned, process.platform === "win32" ? "junction" : "dir")
    await fs.mkdir(redirected)
    for (const root of [unknown, outside, owned, redirected]) {
      await expect(MediaSdkOnce.run({ peers: { A: { url: "http://127.0.0.1", directory: "", authorizationFile: "" } },
        groups: { A: { id: "unused" } }, files: [] }, root)).rejects.toThrow("Private media fixture requires an owned temporary root")
    }
  } finally {
    await fs.rm(owned, { force: true })
    await fs.rm(unknown, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})
