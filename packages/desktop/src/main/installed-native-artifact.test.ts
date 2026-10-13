import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, generateKeyPairSync } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../../deepagent-code/src/installation/native-installation.schema"
import { sealInstalledNativeNode, signMacWithNativeNode } from "../../scripts/native-node-artifact"
import { nativeAssetNames, signNativeNodeAssets } from "../../../deepagent-code/script/sign-native-assets"
import { prepareManagedBrowserInputAsset } from "../../scripts/managed-browser-input-assets"

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "installed macOS utility verifies the final publisher seal after nested and outer signing",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-installed-native-artifact-"))
    await fs.chmod(root, 0o700)
    const project = path.join(root, "project")
    const output = path.join(root, "candidate")
    const name = "DAC Installed Artifact Fixture"
    const key = generateKeyPairSync("ed25519")
    const previous = {
      key: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY,
      publicKey: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY,
      release: process.env.DEEPAGENT_CODE_RELEASE_ID,
      discovery: process.env.CSC_IDENTITY_AUTO_DISCOVERY,
      assetIdentity: process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY,
      assetKeychain: process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN,
    }
    delete process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY
    delete process.env.DEEPAGENT_CODE_RELEASE_ID
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false"
    delete process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY
    delete process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN
    const run = async (app: string) => {
      const child = Bun.spawn([path.join(app, `Contents/MacOS/${name}`)], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          XDG_DATA_HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
          DAC_INSTALLED_ARTIFACT_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 20_000)
      try {
        const result = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ code: result[0], stderr: result[2] }).toMatchObject({ code: 0 })
        return (await Bun.file(path.join(root, "installed-result.json")).json()) as {
          code: number
          stdout: string
          stderr: string
        }
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      await fs.mkdir(path.join(project, "out/main/chunks"), { recursive: true })
      await fs.writeFile(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "dac-installed-artifact-fixture",
          version: "2.0.3",
          main: "main.cjs",
          description: "Private installed artifact oracle",
          author: "DAC tests",
        }),
      )
      const main = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "fixture/installed-native-artifact.ts")],
        outdir: project,
        target: "node",
        format: "cjs",
        external: ["electron"],
        naming: "main.cjs",
      })
      expect(main.success).toBe(true)
      const fixture = path.resolve(
        import.meta.dir,
        "../../../deepagent-code/test/installation/fixture/native-node-installation-process.ts",
      )
      const source = await fs.readFile(fixture)
      const actualAssets = process.env.DAC_INSTALLER_NATIVE_ASSET_FIXTURE
      if (actualAssets) {
        await Promise.all(
          nativeAssetNames.map((name) =>
            fs.copyFile(path.join(actualAssets, name), path.join(project, "out/main/chunks", name)),
          ),
        )
      }
      if (!actualAssets) {
        const { buildWorkFileHelper } = await import("../../../deepagent-code/script/build-work-file-helper")
        const { buildWorkStorageCleanup } = await import("../../../deepagent-code/script/build-work-storage-cleanup")
        await buildWorkFileHelper({ os: process.platform, arch: process.arch, destination: path.join(project, "out/main/chunks") })
        await buildWorkStorageCleanup({ os: process.platform, arch: process.arch, destination: path.join(project, "out/main/chunks") })
        // Match the original native Node producer's physical Bun command asset.
        await fs.copyFile(await fs.realpath(process.execPath), path.join(project, "out/main/chunks/bun-command-runtime"))
        await fs.chmod(path.join(project, "out/main/chunks/bun-command-runtime"), 0o755)
      }
      process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY = "-"
      const signedAssets = await signNativeNodeAssets(path.join(project, "out/main/chunks"))
      expect(signedAssets).toHaveLength(nativeAssetNames.length)
      expect(await prepareManagedBrowserInputAsset({ directory: path.join(project, "out/main/managed-browser-input") })).toBeDefined()
      const components = new NativeInstallationSchema.Components({
        schemaVersion: "dac.native-components.v1",
        target: "darwin-arm64",
        sourceCommit: "a".repeat(40),
        sourceTree: "b".repeat(40),
        components: [
          new NativeInstallationSchema.Component({
            path: "packages/deepagent-code/test/installation/fixture/native-node-installation-process.ts",
            bytes: source.length,
            sha256: createHash("sha256").update(source).digest("hex"),
          }),
          ...signedAssets.map((asset) => new NativeInstallationSchema.Component(asset)),
        ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
      })
      const metadata = CanonicalJson.stringify(components)
      const module = path.join(project, "out/main/chunks/node.js")
      const node = await Bun.build({
        entrypoints: [fixture],
        target: "node",
        format: "esm",
        outdir: path.dirname(module),
        naming: "node.js",
        define: {
          DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(
            key.publicKey.export({ type: "spki", format: "pem" }).toString(),
          ),
          DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(metadata),
          DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: "true",
        },
      })
      expect(node.success).toBe(true)
      await fs.writeFile(`${module}.native-components.json`, metadata)
      const { build } = await import("electron-builder")
      await build({
        projectDir: project,
        mac: ["dir"],
        arm64: true,
        publish: "never",
        config: {
          appId: "ai.deepagent-code.installed-fixture",
          productName: name,
          electronVersion: "41.10.3",
          electronDist: path.resolve(import.meta.dir, "../../node_modules/electron/dist"),
          directories: { output },
          files: ["main.cjs", "out/**/*"],
          asarUnpack: [
            "out/main/chunks/node.js",
            "out/main/chunks/node.js.native-components.json",
            ...nativeAssetNames.map((name) => `out/main/chunks/${name}`),
            "out/main/managed-browser-input/**/*",
          ],
          mac: { identity: null, notarize: false },
          afterPack: async (context) => {
            expect(await sealInstalledNativeNode(context)).toEqual({ state: "publisher_not_configured" })
          },
        },
      })
      const app = path.join(output, "mac-arm64", `${name}.app`)
      const installedModule = path.join(app, "Contents/Resources/app.asar.unpacked/out/main/chunks/node.js")
      const runtime = path.join(app, `Contents/Frameworks/${name} Helper.app/Contents/MacOS/${name} Helper`)
      expect(await fs.realpath(installedModule)).toBe(installedModule)
      expect(await fs.readFile(installedModule)).toEqual(await fs.readFile(module))
      expect(await fs.realpath(runtime)).toBe(runtime)
      const unsigned = await run(app)
      expect(unsigned.code).toBe(2)
      expect(JSON.parse(unsigned.stdout).ok).toBe(false)
      const before = createHash("sha256")
        .update(await fs.readFile(runtime))
        .digest("hex")
      await expect(signMacWithNativeNode({ app, identity: "-", identityValidation: false })).rejects.toThrow(
        "release publisher key",
      )
      expect(
        createHash("sha256")
          .update(await fs.readFile(runtime))
          .digest("hex"),
      ).toBe(before)
      const publisher = path.join(root, "private-qa-publisher.pem")
      await fs.writeFile(publisher, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
      process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY = publisher
      await expect(signMacWithNativeNode({ app, identity: "-", identityValidation: false })).rejects.toThrow(
        "explicit release identity",
      )
      expect(
        createHash("sha256")
          .update(await fs.readFile(runtime))
          .digest("hex"),
      ).toBe(before)
      process.env.DEEPAGENT_CODE_RELEASE_ID = "private-installed-artifact-oracle"
      process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = key.publicKey.export({ type: "spki", format: "pem" }).toString()
      await signMacWithNativeNode({
        app,
        identity: "-",
        identityValidation: false,
        platform: "darwin",
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({
          entitlements: path.resolve(import.meta.dir, "../../resources/entitlements.plist"),
          hardenedRuntime: true,
          timestamp: "none",
        }),
      })
      const receipt = await Bun.file(`${installedModule}.native-installation.json`).json()
      expect(receipt.payload.runtime.sha256).toBe(
        createHash("sha256")
          .update(await fs.readFile(runtime))
          .digest("hex"),
      )
      expect(receipt.payload.runtime.sha256).not.toBe(before)
      for (const asset of signedAssets) {
        const bytes = await fs.readFile(path.join(path.dirname(installedModule), path.basename(asset.path)))
        expect({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual({
          bytes: asset.bytes,
          sha256: asset.sha256,
        })
      }
      if (signedAssets.length) {
        const command = Bun.spawn(
          [
            path.join(path.dirname(installedModule), "bun-command-runtime"),
            "-e",
            "console.log(Array.from({length:10000},(_,n)=>n).reduce((a,b)=>a+b,0))",
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        const result = await Promise.all([
          command.exited,
          new Response(command.stdout).text(),
          new Response(command.stderr).text(),
        ])
        expect({ code: result[0], stdout: result[1].trim(), stderr: result[2] }).toEqual({
          code: 0,
          stdout: "49995000",
          stderr: "",
        })
      }
      const signed = await run(app)
      expect(signed.code, signed.stdout).toBe(0)
      const inspected = JSON.parse(signed.stdout) as { ok: boolean; result: { assets: string; cloneRejected: boolean } }
      expect(inspected.ok).toBe(true)
      expect(inspected.result.assets).toBe(path.dirname(installedModule))
      expect(inspected.result.cloneRejected).toBe(true)
      await expect(signMacWithNativeNode({ app, identity: "-", identityValidation: false })).rejects.toThrow(
        "already carries a receipt",
      )
      expect(
        createHash("sha256")
          .update(await fs.readFile(runtime))
          .digest("hex"),
      ).toBe(receipt.payload.runtime.sha256)
    } finally {
      Object.entries({
        DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY: previous.key,
        DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: previous.publicKey,
        DEEPAGENT_CODE_RELEASE_ID: previous.release,
        CSC_IDENTITY_AUTO_DISCOVERY: previous.discovery,
        DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY: previous.assetIdentity,
        DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN: previous.assetKeychain,
      }).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  90_000,
)
