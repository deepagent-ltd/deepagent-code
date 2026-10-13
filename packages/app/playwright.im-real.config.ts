import { defineConfig } from "@playwright/test"

const missing = ["DAC_GUI_IM_CDP_URL", "DAC_GUI_IM_SOURCE_TEXT", "DAC_GUI_IM_COMMAND", "DAC_GUI_IM_OUTPUT_DIR"]
  .filter((name) => !process.env[name]?.trim())
if (missing.length) throw new Error(`Private IM /dac acceptance requires: ${missing.join(", ")}`)

// Connects only to the explicitly supplied, already running private Desktop.
// It never starts an app, server, provider, or a second browser.
export default defineConfig({
  testDir: "./e2e/regression",
  testMatch: "im-dac-real-chain.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: "line",
  outputDir: process.env.DAC_GUI_IM_OUTPUT_DIR,
})
