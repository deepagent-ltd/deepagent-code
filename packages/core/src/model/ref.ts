export * as ModelRef from "./ref"

import { Schema } from "effect"

// Schema-only model reference types, dependency-free (effect alone). Extracted from model.ts so
// schema modules that only need a Ref (session/message.ts) don't drag model.ts's
// contract/model-protocol edge (node:crypto digest) into browser-reachable bundles.
export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  // mirror of ProviderV2.ID (Schema.String brand) defined locally to stay dependency-free
  providerID: Schema.String.pipe(Schema.brand("ProviderV2.ID")),
  variant: VariantID.pipe(Schema.optional),
})
export type Ref = typeof Ref.Type
