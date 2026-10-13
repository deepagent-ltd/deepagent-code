import { app } from "electron"
import path from "node:path"
import type { ManagedBrowserInputAsset } from "./managed-browser-input-observer"

declare const __DAC_MANAGED_BROWSER_INPUT_ASSET__: Omit<ManagedBrowserInputAsset, "path"> | undefined

/** Only the fixed build can select a native module. No renderer or Host path is accepted. */
export function builtManagedBrowserInputAsset(): ManagedBrowserInputAsset | undefined {
  if (typeof __DAC_MANAGED_BROWSER_INPUT_ASSET__ === "undefined") return
  if (process.platform !== "darwin" || __DAC_MANAGED_BROWSER_INPUT_ASSET__.target !== `darwin-${process.arch}`) return
  return Object.freeze({ ...__DAC_MANAGED_BROWSER_INPUT_ASSET__, path: path.join(
    app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked/out/main") : import.meta.dirname,
    "managed-browser-input/managed-browser-input-darwin.node",
  ) })
}
