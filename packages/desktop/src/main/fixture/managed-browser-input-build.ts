import path from "node:path"
import { prepareManagedBrowserInputAsset } from "../../../scripts/managed-browser-input-assets"

/** Actual Main fixtures use the same fixed publisher step as the product build. */
export async function managedBrowserInputFixtureDefine(root: string) {
  const asset = await prepareManagedBrowserInputAsset({ directory: path.join(root, "managed-browser-input") })
  return { __DAC_MANAGED_BROWSER_INPUT_ASSET__: asset ? JSON.stringify(asset) : "undefined" }
}
