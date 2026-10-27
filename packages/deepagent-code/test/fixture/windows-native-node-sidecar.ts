import assert from "node:assert/strict"
import { receiveWindowsNativeSidecar } from "../../../desktop/src/main/windows-native-sidecar-child"

const port = (process as NodeJS.Process & {
  parentPort?: Parameters<typeof receiveWindowsNativeSidecar>[0]
}).parentPort
assert(port, "The original utilityProcess parent port is required")
assert.equal(await receiveWindowsNativeSidecar(port), true)
// Keep the original receipt before the first import of the sealed Node image.
const entry: { main: () => Promise<void> } = await import(new URL("./chunks/node.js", import.meta.url).href)
await entry.main()
