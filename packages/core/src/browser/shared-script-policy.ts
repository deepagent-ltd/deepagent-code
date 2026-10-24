export * as SharedBrowserScriptPolicy from "./shared-script-policy"

import type { BrowserSchema } from "./schema"
import type { SharedBrowserSchema } from "./shared-schema"
import { Hash } from "../util/hash"

export function allowsScript(policy: SharedBrowserSchema.Policy, command: Extract<BrowserSchema.Command, { type: "evaluate" }>) {
  return policy.scriptContext === "snapshot-json-v1" && command.scriptHash === Hash.sha256(command.source) &&
    policy.scriptGrants?.some((grant) => grant.scriptHash === command.scriptHash && grant.argsHash === Hash.sha256(command.argsJSON)) === true
}

export function allowsProgram(policy: SharedBrowserSchema.Policy, command: Extract<BrowserSchema.Command, { type: "program" }>) {
  return policy.scriptContext === "snapshot-json-v1" && command.scriptHash === Hash.sha256(command.source) &&
    policy.programGrants?.some((grant) => grant.scriptHash === command.scriptHash && grant.argsHash === Hash.sha256(command.argsJSON)) === true
}
