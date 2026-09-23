import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PluginLoader } from "@/plugin/loader"
import { PluginSignature } from "@/plugin/signature"

test("a pinned Ed25519 signature gates external plugin import and detects tampering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deepagent-plugin-signature-"))
  try {
    const entry = path.join(dir, "index.js")
    const marker = path.join(dir, "imported.marker")
    await Bun.write(entry, `await Bun.write(${JSON.stringify(marker)}, "loaded"); export default () => ({})`)
    const row: PluginLoader.Resolved = {
      spec: pathToFileURL(entry).href,
      options: undefined,
      deprecated: false,
      source: "file",
      target: pathToFileURL(entry).href,
      entry: pathToFileURL(entry).href,
    }
    const keys = generateKeyPairSync("ed25519")
    const trust = JSON.stringify({ release: keys.publicKey.export({ type: "spki", format: "pem" }) })
    await expect(PluginSignature.check(row, trust)).rejects.toBeInstanceOf(PluginSignature.SignatureError)
    expect(await Bun.file(marker).exists()).toBe(false)

    const digest = await PluginSignature.hash(dir, ["index.js"])
    await Bun.write(
      `${entry}.deepagent-code-signature.json`,
      JSON.stringify({
        algorithm: "ed25519-sha256",
        keyId: "release",
        digest,
        signature: sign(null, Buffer.from(digest, "hex"), keys.privateKey).toString("base64"),
      }),
    )
    await PluginSignature.check(row, trust)
    const packageDigest = await PluginSignature.hash(dir)
    await Bun.write(
      path.join(dir, ".deepagent-code-signature.json"),
      JSON.stringify({
        algorithm: "ed25519-sha256",
        keyId: "release",
        digest: packageDigest,
        signature: sign(null, Buffer.from(packageDigest, "hex"), keys.privateKey).toString("base64"),
      }),
    )
    const packageRow: PluginLoader.Resolved = {
      ...row,
      spec: "signed-plugin@1.0.0",
      source: "npm",
      pkg: { dir, pkg: "signed-plugin", json: {} },
    }
    await PluginSignature.check(packageRow, trust)
    // A package can load JSON/configuration from a file with a signature-like name. That file
    // must not be exempt from the signed package content merely because of its suffix.
    await Bun.write(path.join(dir, "runtime.deepagent-code-signature.json"), '{"mode":"changed"}')
    await expect(PluginSignature.check(packageRow, trust)).rejects.toBeInstanceOf(PluginSignature.SignatureError)
    await expect(
      PluginSignature.check(row, JSON.stringify({ other: keys.publicKey.export({ type: "spki", format: "pem" }) })),
    ).rejects.toBeInstanceOf(PluginSignature.SignatureError)

    await Bun.write(entry, "export default () => ({ changed: true })")
    await expect(PluginSignature.check(row, trust)).rejects.toBeInstanceOf(PluginSignature.SignatureError)
    const before = process.env.DEEPAGENT_CODE_PLUGIN_TRUST_KEYS
    process.env.DEEPAGENT_CODE_PLUGIN_TRUST_KEYS = trust
    try {
      const loaded = await PluginLoader.load(row)
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) {
        expect(loaded.stage).toBe("signature")
        expect(loaded.error).toBeInstanceOf(PluginSignature.SignatureError)
      }
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      if (before === undefined) delete process.env.DEEPAGENT_CODE_PLUGIN_TRUST_KEYS
      else process.env.DEEPAGENT_CODE_PLUGIN_TRUST_KEYS = before
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
