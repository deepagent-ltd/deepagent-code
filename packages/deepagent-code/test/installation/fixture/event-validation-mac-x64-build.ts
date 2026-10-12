import fs from "node:fs/promises"
import path from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../../src/installation/native-installation.schema"
import { signNativeNodeAssets } from "../../../script/sign-native-assets"

const directory = process.argv[2]
const helper = process.argv[3]
const cleanup = process.argv[4]
const runtime = process.argv[5]
if (!directory || !helper || !cleanup || !runtime || process.platform !== "darwin" || process.arch !== "x64")
  throw new Error("Build requires native Intel QA inputs")
const repository = path.resolve(import.meta.dir, "../../../../..")
const observation = await Bun.file(path.join(repository, ".qa-source-observation.json")).json()
const install = path.join(directory, "install")
await fs.mkdir(install, { mode: 0o700 })
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const pair = generateKeyPairSync("ed25519")
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const reads = new Map<string, { path: string; bytes: number; sha256: string }>()
const options = {
  entrypoints: [path.join(import.meta.dir, "event-validation-mac-x64-native.ts")], target: "bun" as const,
  minify: false, define: { DEEPAGENT_CODE_VERSION: '"2.0.3"',
    DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(publicKey), DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: '""' },
}
const discovery = await Bun.build({ ...options, plugins: [{ name: "actual-source-inputs", setup(build) {
  build.onLoad({ filter: /\.(?:ts|tsx|js|json)$/ }, async (args) => {
    const relative = path.relative(repository, args.path)
    if (!relative.startsWith("../") && !relative.startsWith("node_modules/")) {
      const bytes = await fs.readFile(args.path)
      reads.set(relative, { path: relative, bytes: bytes.length, sha256: hash(bytes) })
    }
    return undefined
  })
} }] })
if (!discovery.success) throw new Error(discovery.logs.join("\n"))
for (const [source, filename] of [[helper, "deepagent-work-file-helper"], [cleanup, "deepagent-work-storage-cleanup"], [runtime, "bun-command-runtime"]]) {
  const canonical = await fs.realpath(source!)
  const stat = await fs.lstat(canonical)
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || !(stat.mode & 0o111)) throw new Error("Unsafe original QA asset")
  const bytes = await fs.readFile(canonical)
  const name = filename!
  await fs.writeFile(path.join(install, name), bytes, { mode: 0o755 })
}
if (process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY !== "-") throw new Error("This fixture permits private QA ad-hoc signing only")
const assets = await signNativeNodeAssets(install)
assets.forEach((asset) => reads.set(asset.path, asset))
const componentText = CanonicalJson.stringify(new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1",
  target: "darwin-x64", sourceCommit: observation.sourceCommit, sourceTree: observation.sourceTree,
  components: [...reads.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
}))
const binary = path.join(install, "intel-ev")
const built = await Bun.build({ ...options, compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
  define: { ...options.define, DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(componentText) },
})
if (!built.success) throw new Error(built.logs.join("\n"))
for (const item of reads.values()) {
  if (item.path.startsWith("packages/work-file-helper/bin/")) continue
  if (hash(await fs.readFile(path.join(repository, item.path))) !== item.sha256) throw new Error("Source changed during QA compile")
}
const bytes = await fs.readFile(binary)
const payload = new NativeInstallationSchema.Payload({ domain: NativeInstallationSchema.DOMAIN, releaseID: "intel-ev-qa",
  target: "darwin-x64", sourceCommit: observation.sourceCommit, sourceTree: observation.sourceTree,
  componentsHash: hash(componentText), executable: { bytes: bytes.length, sha256: hash(bytes) },
})
await fs.writeFile(binary + NativeInstallationSchema.SIDECAR_SUFFIX, CanonicalJson.stringify({ payload,
  signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), pair.privateKey).toString("hex") }), { mode: 0o600 })
await fs.writeFile(path.join(directory, "native-build-safe.json"), JSON.stringify({ binary, bytes: bytes.length, sha256: hash(bytes),
  target: "darwin-x64", sourceCommit: observation.sourceCommit, sourceTree: observation.sourceTree,
  sourceObservation: hash(await fs.readFile(path.join(repository, ".qa-source-observation.json"))),
  components: [...reads.values()], sourceDrift: [], qaPublisherOnly: true }, null, 2) + "\n", { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, binary, sourceEntries: reads.size, target: "darwin-x64" })}\n`)
