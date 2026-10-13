import runtime from "../native/managed-browser-input/runtime.json"
import manifest from "../package.json"

// A package upgrade cannot silently broaden the private Cocoa/TSF ABI cohort.
if (manifest.devDependencies.electron !== runtime.electronVersion)
  throw new Error("MANAGED_BROWSER_INPUT_PACKAGE_RUNTIME_UNQUALIFIED")

export const managedBrowserInputRuntime = Object.freeze(runtime)
