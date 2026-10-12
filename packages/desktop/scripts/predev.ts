import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.DEEPAGENT_CODE_CHANNEL ?? "dev"}`

await $`cd ../deepagent-code && bun script/build-node.ts`

const publisher = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY?.trim()
if (publisher) {
  const pin = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
  if (!pin) throw new Error("Native dev publisher requires its compiled public release pin")
  if (process.platform !== "darwin") throw new Error("Native dev publisher is not configured for this platform")
  const { realpath, readFile } = await import("node:fs/promises")
  const { createRequire } = await import("node:module")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const { Schema } = await import("effect")
  const { NativeInstallationSchema } = await import("../../deepagent-code/src/installation/native-installation.schema")
  const { requireNativePublisherSigner } = await import("./native-node-artifact")
  const { verifyMacNativeAssets } = await import("./mac-native-assets")
  const executable: unknown = createRequire(import.meta.url)("electron")
  if (typeof executable !== "string") throw new Error("Native dev publisher requires its actual Electron executable")
  // utilityProcess runs the plain Helper, not the Electron main or renderer executable.
  const runtime = await realpath(
    join(dirname(await realpath(executable)), "../Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"),
  )
  const module = await realpath(new URL("../../deepagent-code/dist/node/node.js", import.meta.url))
  await verifyMacNativeAssets(dirname(module), runtime)
  const signed = Schema.decodeUnknownSync(
    Schema.Struct({
      payload: NativeInstallationSchema.NodePayload,
      signerHash: Schema.String,
    }),
    { onExcessProperty: "error" },
  )(
    await $`bun ${fileURLToPath(new URL("../../deepagent-code/script/sign-native-node.ts", import.meta.url))} --module ${module} --runtime ${runtime} --key ${publisher} --release ${process.env.DEEPAGENT_CODE_RELEASE_ID?.trim() || "dac-native-dev-candidate"}`
      .quiet()
      .json(),
  )
  requireNativePublisherSigner(signed.signerHash, pin.includes("-----BEGIN") ? pin : await readFile(pin, "utf8"))
  console.log(
    "Native dev Node artifact sealed",
    JSON.stringify({ target: signed.payload.target, signerHash: signed.signerHash }),
  )
}
