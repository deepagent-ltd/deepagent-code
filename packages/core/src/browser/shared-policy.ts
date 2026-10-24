export * as SharedBrowserPolicy from "./shared-policy"

import { Option, Schema } from "effect"
import { SharedBrowserSchema } from "./shared-schema"
import { CanonicalJson } from "../util/canonical-json"

/** Origin additions never grant POST, script, file, resolver or manual authority. */
export function agent(policy: SharedBrowserSchema.Policy, origins: readonly string[]) {
  if (
    !policy.approvedOrigins.every((origin) => origins.includes(origin)) ||
    origins.some((origin) => !policy.approvedOrigins.includes(origin) && !policy.manualApprovedOrigins.includes(origin))
  )
    return undefined
  const next = Schema.decodeUnknownOption(SharedBrowserSchema.Policy)({ ...policy, approvedOrigins: origins })
  return Option.isSome(next) ? next.value : undefined
}

export function same(left: SharedBrowserSchema.Policy, right: SharedBrowserSchema.Policy) {
  return CanonicalJson.stringify(left) === CanonicalJson.stringify(right)
}
