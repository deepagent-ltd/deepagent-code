import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    conditions: ["development", "browser"],
  },
  test: {
    include: ["test/components/**/*.test.tsx"],
    environment: "happy-dom",
    restoreMocks: true,
    maxWorkers: 1,
    minWorkers: 1,
  },
})
