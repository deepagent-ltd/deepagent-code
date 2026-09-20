export * as AgentID from "./id"

import { Schema } from "effect"

// Schema-only Agent ID extracted from agent.ts (which owns the ModelV2/ProviderV2 service
// edges) for the same browser-bundle reason as model/ref and location/ref.
export const ID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type ID = typeof ID.Type
