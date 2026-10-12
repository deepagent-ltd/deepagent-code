import type { WindowsInputPortableAsset } from "../../scripts/managed-browser-input-windows-assets"

/** No loader or environment fallback. Root owns the future qualified publisher integration. */
export function selectWindowsInputCandidate(asset: WindowsInputPortableAsset | undefined) {
  if (!asset) return Object.freeze({ status: "unavailable", reason: "missing_asset" } as const)
  if (process.platform !== "win32" || process.arch !== "x64" || !process.versions.electron || process.type !== "browser")
    return Object.freeze({ status: "unavailable", reason: "unsupported_runtime" } as const)
  // The candidate schema only permits unverified. Even an object cast by a
  // caller cannot make this selector invoke require/observe or mint a lease.
  return Object.freeze({ status: "unavailable", reason: "runtime_qualification_required" } as const)
}
