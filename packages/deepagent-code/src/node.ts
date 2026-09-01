import { applyRuntimeDefaults, RUNTIME_DEFAULTS_SNAPSHOT_ENV, runtimeDefaultsEnvSnapshot } from "./runtime-defaults"

// W0.1 — the desktop-sidecar entry applies the same production runtime defaults as the CLI entry
// (src/index.ts) at module load, before the desktop sidecar calls Server.listen. The only reads of
// these flags (RuntimeFlags config, EventV2Bridge, im.ts gate) happen at request/runtime
// boundaries, never during this module graph's import evaluation, so this placement is safe.
applyRuntimeDefaults()

if (process.env[RUNTIME_DEFAULTS_SNAPSHOT_ENV] === "1") {
  // Test-only backdoor (W0.1 verification case 4): print the canonical defaults vector and exit
  // without starting the server. Any process (or inherited child env) carrying this key exits
  // here — never set it in production shells, packaging, or service managers.
  console.log(JSON.stringify(runtimeDefaultsEnvSnapshot(process.env)))
  process.exit(0)
}

export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export * as Log from "@deepagent-code/core/util/log"
export { Database } from "@deepagent-code/core/database/database"
