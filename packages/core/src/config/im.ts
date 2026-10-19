export * as ConfigIM from "./im"

import { Schema } from "effect"
import { ModelRef } from "../model/ref"

export function normalizeServiceURL(value: string, allowLoopback = false) {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\?#]/.test(value) || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) return undefined
  if (
    url.protocol !== "https:" &&
    !(allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    return undefined
  if (!value.toLowerCase().startsWith(`${url.protocol}//`)) return undefined
  return url.href.replace(/\/+$/, "")
}

export const ServiceURL = Schema.String.check(Schema.makeFilter((value) => normalizeServiceURL(value) !== undefined))
export const ServiceStatus = Schema.Struct({
  url: Schema.NullOr(Schema.String),
  source: Schema.Literals(["config", "environment", "none"]),
  reconnectRequired: Schema.Boolean,
}).annotate({ identifier: "IMServiceStatus" })

export class Info extends Schema.Class<Info>("Config.IM")({
  url: Schema.optional(Schema.NullOr(ServiceURL)),
  model: Schema.optional(Schema.String.check(Schema.isPattern(/^[^\s/]+\/.+$/), Schema.isMaxLength(2048))),
}) {}

export function modelReference(model: string) {
  const parts = model.split("/")
  return Schema.decodeUnknownSync(ModelRef.Ref)({ providerID: parts[0], id: parts.slice(1).join("/") })
}
