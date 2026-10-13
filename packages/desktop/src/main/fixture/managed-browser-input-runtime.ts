import path from "node:path"

// The explicit path belongs only to isolated qualification fixtures, never the product loader.
export const managedBrowserInputFixtureExecutable =
  process.env.DAC_BROWSER_INPUT_ELECTRON_EXECUTABLE ??
  path.resolve(import.meta.dir, "../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
