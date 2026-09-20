// Test-only: align the test process with a RELEASE install BEFORE InstallationVersion is computed.
// script/mint-owner-campaign.ts defaults its build identity to packages/deepagent-code/package.json
// version, and a release build defines DEEPAGENT_CODE_VERSION to the same value (script/build.ts &
// build-node.ts use Script.version, which CI passes as DEEPAGENT_CODE_VERSION = the released
// version). Defining the global here makes `mint --dev` (default arguments) qualify the DEFAULT
// install end-to-end: campaign v2-owner-<pkg version>, identity from the same version string.
// NOTE: this module must evaluate SYNCHRONOUSLY (no top-level await) — with top-level await the
// ESM async evaluation model would let later imports (installation/version) run before the global
// is set.
import { readFileSync } from "node:fs"

const version = JSON.parse(
  readFileSync(new URL("../../../deepagent-code/package.json", import.meta.url), "utf8"),
).version as string
;(globalThis as { DEEPAGENT_CODE_VERSION?: string }).DEEPAGENT_CODE_VERSION = version

export {}
