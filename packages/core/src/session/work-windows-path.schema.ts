export * as WorkWindowsPathSchema from "./work-windows-path.schema"

import { Schema } from "effect"

const Volume = /^\\\\\?\\Volume\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}\\/
const Device = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)/i

/** Portable grant paths keep slash separators. Native consumers open each
 * component relative to a held root and still check FileID/reparse/8.3 aliases. */
export const MemberRelative = Schema.String.check(Schema.makeFilter((value: string) =>
  value.isWellFormed() && Buffer.byteLength(value) <= 2048 && value.split("/").length <= 16 &&
  value.split("/").every(component)))
export const Relative = MemberRelative.check(Schema.makeFilter((value: string) =>
  ![".DAC-HOME", ".DAC-TMP"].includes(value.split("/")[0]!.toUpperCase())))
export type Relative = typeof Relative.Type
// Internal retirement inventories also include the factory's private home/tmp.
export const DirectoryRelative = Schema.Union([Schema.Literal(""), MemberRelative])

/** Only canonical local drive and Volume GUID forms are descriptions. UNC, NT
 * device namespaces, drive-relative names and alternate streams are excluded. */
export const Absolute = Schema.String.check(Schema.makeFilter((value: string) => {
  if (!value.isWellFormed() || Buffer.byteLength(value) > 2048) return false
  const prefix = value.match(Volume)?.[0] ?? value.match(/^[A-Z]:\\/)?.[0]
  if (!prefix) return false
  const parts = value.slice(prefix.length).split("\\")
  return value === prefix || (parts.length <= 32 && parts.every(component))
}))
export type Absolute = typeof Absolute.Type

// This conservative precheck does not replace native identity equality. It also
// rejects some distinct Unicode names whose uppercase expansions coincide.
export const unique = (paths: readonly string[]) => new Set(paths.map((value) => value.toUpperCase())).size === paths.length
export const nonOverlapping = (paths: readonly string[]) => {
  const names = paths.map((value) => value.toUpperCase())
  return unique(paths) && !names.some((value) => names.some((parent) => value.startsWith(`${parent}/`)))
}

function component(value: string) {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) && !/[. ]$/.test(value) && !Device.test(value)
}
