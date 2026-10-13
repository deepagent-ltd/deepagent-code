import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createPrivateKey, generateKeyPairSync, verify } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../deepagent-code/src/installation/native-installation.schema"
import { signNativeNodeArtifact } from "../../deepagent-code/script/sign-native-node"
import { completeMacPackageEnvironment } from "./complete-mac-package"
import { requireNativePublisherSigner } from "./native-node-artifact"

test("final receipt rejects a real publisher key replacement after prebuild captured its public pin", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-native-publisher-current-"))
  await fs.chmod(root, 0o700)
  const keys = generateKeyPairSync("ed25519")
  const replacement = generateKeyPairSync("ed25519")
  const publisher = path.join(root, "publisher.pem")
  try {
    await fs.writeFile(publisher, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    const environment = await completeMacPackageEnvironment({ platform: "darwin", arch: "arm64", args: ["--mac"],
      signingFile: path.join(root, "absent"), environment: { DEEPAGENT_CODE_ALLOW_UNSIGNED: "1",
        DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY: publisher, DEEPAGENT_CODE_RELEASE_ID: "publisher-current-module",
        DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY: "-" } })
    const runtime = path.join(root, "runtime")
    await fs.writeFile(runtime, "private publisher test runtime\n", { mode: 0o700 })
    const source = await fs.readFile(import.meta.path)
    const metadata = CanonicalJson.stringify(new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1",
      target: "darwin-arm64", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), components: [new NativeInstallationSchema.Component({
        path: "packages/desktop/scripts/native-node-artifact.test.ts", bytes: source.length,
        sha256: createHash("sha256").update(source).digest("hex") })] }))
    const module = path.join(root, "node.js")
    await fs.writeFile(module, "export const privateFixture = true\n", { mode: 0o600 })
    await fs.writeFile(`${module}.native-components.json`, metadata, { mode: 0o600 })
    const first = await signNativeNodeArtifact({ module, runtime, releaseID: environment.DEEPAGENT_CODE_RELEASE_ID!,
      privateKey: createPrivateKey(await fs.readFile(publisher)) })
    expect(() => requireNativePublisherSigner(first.signerHash, environment.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY!)).not.toThrow()
    const changed = path.join(root, "changed.js")
    await fs.writeFile(changed, "export const privateFixture = true\n", { mode: 0o600 })
    await fs.writeFile(`${changed}.native-components.json`, metadata, { mode: 0o600 })
    await fs.writeFile(publisher, replacement.privateKey.export({ type: "pkcs8", format: "pem" }))
    const second = await signNativeNodeArtifact({ module: changed, runtime, releaseID: environment.DEEPAGENT_CODE_RELEASE_ID!,
      privateKey: createPrivateKey(await fs.readFile(environment.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY!)) })
    const receipt = await Bun.file(`${changed}${NativeInstallationSchema.SIDECAR_SUFFIX}`).json()
    expect(verify(null, Buffer.from(CanonicalJson.stringify(receipt.payload)), replacement.publicKey,
      Buffer.from(receipt.signature, "hex"))).toBe(true)
    expect(second.signerHash).not.toBe(first.signerHash)
    expect(() => requireNativePublisherSigner(second.signerHash, environment.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY!))
      .toThrow("does not match the compiled public release pin")
    expect(() => requireNativePublisherSigner(first.signerHash, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()))
      .toThrow("public release pin")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
