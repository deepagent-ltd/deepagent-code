export * as ConfigIM from "./im"

import { Schema } from "effect"
import { ModelRef } from "../model/ref"

export class Info extends Schema.Class<Info>("Config.IM")({
  model: Schema.optional(Schema.String.check(Schema.isPattern(/^[^\s/]+\/.+$/), Schema.isMaxLength(2048))),
}) {}

export function modelReference(model: string) {
  const parts = model.split("/")
  return Schema.decodeUnknownSync(ModelRef.Ref)({ providerID: parts[0], id: parts.slice(1).join("/") })
}
