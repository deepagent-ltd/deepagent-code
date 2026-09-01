// W4 step 7 build gate: the frozen capability catalog must not advertise entry tools that the
// builtin registry does not ship — otherwise the model is promised tools that never execute.
// Runs in CI (branding-check.yml) and locally (`bun script/assert-capability-inventory.ts`).
// Throws (exit 1) on any stable manifest entry_tool missing from the builtin registry; after
// W3.5 the catalog marks not-yet-wired capabilities maintenance_only, so a passing run means the
// directory and the registry are consistent.

import { builtinToolNames } from "@deepagent-code/core/tool/builtins"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import {
  assertInventoryMatchesRegistry,
  findUpgradableMaintenance,
} from "@deepagent-code/core/system-context/capability-manifest"

try {
  assertInventoryMatchesRegistry(builtinToolNames, capabilityCatalog)
  console.log("capability inventory consistent: catalog entry_tools ⊆ builtin registry")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

// W4.1 reverse warning (never a gate failure): a maintenance_only capability whose
// entry tools are ALL registered can be promoted to stable — surface it so the
// directory and the registry stay convergent instead of silently drifting.
const upgradable = findUpgradableMaintenance(builtinToolNames, capabilityCatalog)
if (upgradable.length > 0) {
  console.warn(
    `warning: maintenance_only capabilities fully registered (upgrade candidates): ${upgradable.map((manifest) => manifest.id).join(", ")}`,
  )
}
