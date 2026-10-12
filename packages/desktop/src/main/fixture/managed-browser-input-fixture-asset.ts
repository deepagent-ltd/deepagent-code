import path from "node:path"
import type { ManagedBrowserInputAsset } from "../managed-browser-input-observer"

declare const __DAC_MANAGED_BROWSER_INPUT_ASSET__: Omit<ManagedBrowserInputAsset, "path"> | undefined

// Bun folds import.meta.dirname to the source directory in a CJS QA bundle.
// These private fixtures inject their fixed publisher output through Main's
// existing constructor, without adding a runtime path selector to the product.
export function managedBrowserInputFixtureAsset(root: string) {
  if (typeof __DAC_MANAGED_BROWSER_INPUT_ASSET__ === "undefined") return
  return { ...__DAC_MANAGED_BROWSER_INPUT_ASSET__,
    path: path.join(root, "managed-browser-input/managed-browser-input-darwin.node") }
}
