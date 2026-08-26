import { defineConfig } from "drizzle-kit"
import os from "node:os"

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration",
  dbCredentials: {
    url: process.env.DEEPAGENT_CODE_DB ?? `${os.homedir()}/.deepagent/code/deepagent-code.db`,
  },
})
