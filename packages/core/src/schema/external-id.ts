export * as ExternalID from "./external-id"

import { Hash } from "../util/hash"

// externalID carries the only crypto edge of core/schema.ts; isolated here so the schema
// barrel stays browser-parseable (browser bundles reach it via legacy-wire → message → schema).
export type ExternalID = {
  readonly namespace: string
  readonly key: string
}

export const externalID = (prefix: string, input: ExternalID) =>
  `${prefix}_${Hash.sha256(JSON.stringify([input.namespace, input.key]))}`
