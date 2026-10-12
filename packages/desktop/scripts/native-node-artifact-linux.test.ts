import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, generateKeyPairSync, verify } from "node:crypto"
import { Packager, LinuxPackager } from "electron-builder"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { verifyLinuxNativeAssets } from "./linux-native-assets"
import { sealInstalledNativeNode } from "./native-node-artifact"

const assets = process.env.DAC_LINUX_NATIVE_TEST_ASSETS
const runtime = process.env.DAC_LINUX_NATIVE_TEST_RUNTIME

// This exercises the actual native cohort and issuer on Linux. A different host
// or absent compiled assets cannot supply Linux package qualification.
test.skipIf(process.platform !== "linux" || !assets || !runtime)(
  "Linux afterPack seals its real builder cohort and rejects foreign pin, source, hardlink and inherited receipt",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-linux-node-package-"))
    await fs.chmod(root, 0o700)
    const previous = {
      privateKey: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY,
      publicKey: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY,
      releaseID: process.env.DEEPAGENT_CODE_RELEASE_ID,
    }
    try {
      const keys = generateKeyPairSync("ed25519")
      const pin = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
      await fs.writeFile(path.join(root, "publisher.pem"), keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
      process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY = path.join(root, "publisher.pem")
      process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = pin
      process.env.DEEPAGENT_CODE_RELEASE_ID = "dac-linux-node-package-module-test"
      const app = path.join(root, "app")
      const chunks = path.join(app, "resources/app.asar.unpacked/out/main/chunks")
      await fs.mkdir(chunks, { recursive: true })
      await fs.cp(assets!, chunks, { recursive: true })
      const target = process.arch === "x64" ? "linux-x64" as const : "linux-arm64" as const
      const cohort = await verifyLinuxNativeAssets({ directory: chunks, target })
      const components = {
        schemaVersion: "dac.native-components.v1", target,
        sourceCommit: cohort.manifest.sourceCommit, sourceTree: cohort.manifest.sourceTree,
        components: cohort.manifest.assets.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      }
      await fs.writeFile(path.join(chunks, "node.js.native-components.json"), CanonicalJson.stringify(components), { mode: 0o600 })
      await fs.writeFile(path.join(root, "entry.ts"), `export const publicPin = ${JSON.stringify(pin)}\n`, { mode: 0o600 })
      expect((await Bun.build({ entrypoints: [path.join(root, "entry.ts")], target: "node", format: "esm",
        outdir: chunks, naming: "node.js" })).success).toBe(true)
      const builder = new Packager({ projectDir: path.resolve(import.meta.dir, ".."), config: {
        extends: null, productName: "DeepAgent Code Dev", extraMetadata: { version: "2.0.3" }, linux: { target: ["dir"] },
      } })
      await builder.validateConfig()
      const packager = new LinuxPackager(builder)
      await fs.copyFile(runtime!, path.join(app, packager.executableName))
      await fs.chmod(path.join(app, packager.executableName), 0o755)
      const context = { appOutDir: app, electronPlatformName: "linux" as const, packager }
      process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
      await expect(sealInstalledNativeNode(context)).rejects.toThrow("signer does not match")
      expect(await Bun.file(path.join(chunks, "node.js.native-installation.json")).exists()).toBe(false)
      process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = pin
      await fs.writeFile(path.join(chunks, "node.js.native-components.json"), CanonicalJson.stringify({ ...components, sourceTree: "e".repeat(40) }))
      await expect(sealInstalledNativeNode(context)).rejects.toThrow("differs from its compiled asset inventory")
      expect(await Bun.file(path.join(chunks, "node.js.native-installation.json")).exists()).toBe(false)
      await fs.writeFile(path.join(chunks, "node.js.native-components.json"), CanonicalJson.stringify(components))
      await fs.link(path.join(chunks, "node.js"), path.join(root, "module-link"))
      await expect(sealInstalledNativeNode(context)).rejects.toThrow("package image rejected")
      expect(await Bun.file(path.join(chunks, "node.js.native-installation.json")).exists()).toBe(false)
      await fs.unlink(path.join(root, "module-link"))
      const sealed = await sealInstalledNativeNode(context)
      expect(sealed.state).toBe("sealed")
      const receipt = await Bun.file(path.join(chunks, "node.js.native-installation.json")).json()
      expect(verify(null, Buffer.from(CanonicalJson.stringify(receipt.payload)), keys.publicKey, Buffer.from(receipt.signature, "hex"))).toBe(true)
      expect(receipt.payload.runtime.sha256).toBe(createHash("sha256").update(await fs.readFile(path.join(app, packager.executableName))).digest("hex"))
      expect(receipt.payload.executable.sha256).toBe(createHash("sha256").update(await fs.readFile(path.join(chunks, "node.js"))).digest("hex"))
      await expect(sealInstalledNativeNode(context)).rejects.toThrow("cannot inherit")
    } finally {
      for (const [name, value] of [
        ["DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY", previous.privateKey],
        ["DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY", previous.publicKey],
        ["DEEPAGENT_CODE_RELEASE_ID", previous.releaseID],
      ]) {
        if (value === undefined) delete process.env[name!]
        if (value !== undefined) process.env[name!] = value
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
