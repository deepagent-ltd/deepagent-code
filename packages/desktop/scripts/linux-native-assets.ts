import { inspectLinuxNativeAssets, type LinuxNativeTarget } from "../../deepagent-code/script/build-linux-native-assets"

/** Physical package completeness only; this does not mint installed Native authority. */
export async function verifyLinuxNativeAssets(input: { directory: string; target: LinuxNativeTarget; expectedManifestHash?: string }) {
  return inspectLinuxNativeAssets(input)
}
