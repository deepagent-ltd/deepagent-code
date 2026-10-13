import { defineConfig } from "@playwright/test"

// Connects only to the explicitly supplied, already running private Desktop.
// It never starts an app, server, provider, or a second browser.
export default defineConfig({
  testDir: "./e2e/regression",
  testMatch: "im-task-real-chain.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: "line",
  outputDir: process.env.DAC_GUI_IM_OUTPUT_DIR ?? "/tmp/dac-gui-im-real-chain-test-output",
})
