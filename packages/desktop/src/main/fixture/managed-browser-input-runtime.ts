import { createRequire } from "node:module"

// The explicit path belongs only to isolated qualification fixtures, never the product loader.
export const managedBrowserInputFixtureExecutable =
  process.env.DAC_BROWSER_INPUT_ELECTRON_EXECUTABLE ??
  createRequire(import.meta.url)("electron") as string

// Isolated children keep only the OS display/runtime variables they need;
// model credentials and unrelated user configuration are never inherited.
export const managedBrowserInputFixtureEnvironment = Object.fromEntries(
  ["DISPLAY", "XAUTHORITY", "SystemRoot", "WINDIR"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]!]] : []),
)
