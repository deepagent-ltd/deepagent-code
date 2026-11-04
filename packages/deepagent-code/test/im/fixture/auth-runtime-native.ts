import assert from "node:assert/strict"
import { NativeWindowsBootstrap } from "../../../src/installation/windows-native-bootstrap"

export async function main() {
  const request = process.env.DAC_AUTH_REQUEST
  const result = process.env.DAC_AUTH_RESULT
  assert(request && result)
  await NativeWindowsBootstrap.installFixedEntry()
  process.argv[3] = request
  process.argv[4] = result
  process.env.DAC_AUTH_NATIVE_COHORT = "1"
  await import("./auth-runtime")
}
