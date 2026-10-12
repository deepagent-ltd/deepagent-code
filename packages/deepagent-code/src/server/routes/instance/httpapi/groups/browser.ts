import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"

const fields = { code: Schema.Union([BrowserSchema.ErrorCode, Schema.Literals(BrowserFileSchema.ErrorCodes)]), message: Schema.String }
export class BrowserForbidden extends Schema.ErrorClass<BrowserForbidden>("BrowserForbidden")(
  fields, { httpApiStatus: 403 },
) {}
export class BrowserMissing extends Schema.ErrorClass<BrowserMissing>("BrowserMissing")(
  fields, { httpApiStatus: 404 },
) {}
export class BrowserConflict extends Schema.ErrorClass<BrowserConflict>("BrowserConflict")(
  fields, { httpApiStatus: 409 },
) {}
export class BrowserUnavailable extends Schema.ErrorClass<BrowserUnavailable>("BrowserUnavailable")(
  fields, { httpApiStatus: 503 },
) {}
const errors = [BrowserForbidden, BrowserMissing, BrowserConflict, BrowserUnavailable] as const
const filePreview = Schema.Union([
  Schema.Struct({ direction: Schema.Literal("upload"), name: BrowserFileSchema.Name, relative: BrowserFileSchema.Relative,
    bytes: BrowserFileSchema.FileBytes, sha256: BrowserFileSchema.Digest, targetPath: BrowserFileSchema.PostPath,
    observedAt: BrowserFileSchema.Count }),
  Schema.Struct({ direction: Schema.Literal("download"), name: BrowserFileSchema.Name, relative: BrowserFileSchema.Relative,
    maxBytes: BrowserFileSchema.FileBytes, targetURL: BrowserFileSchema.URL, observedAt: BrowserFileSchema.Count }),
])
const fileStatus = Schema.Struct({ requestID: BrowserFileSchema.ID,
  state: Schema.Literals(["approved", "used", "expired", "unavailable", "missing"]),
  grant: Schema.NullOr(BrowserFileSchema.GrantSummary) })
export const BrowserApi = HttpApi.make("browser").add(
  HttpApiGroup.make("browser")
    .add(HttpApiEndpoint.post("create", "/api/v1/browser/controls", {
      payload: BrowserSchema.Create, success: BrowserSchema.ControlView, error: errors,
    }))
    .add(HttpApiEndpoint.get("get", "/api/v1/browser/controls/:controlID", {
      params: { controlID: BrowserSchema.ID }, success: BrowserSchema.ControlView, error: errors,
    }))
    .add(HttpApiEndpoint.post("cancel", "/api/v1/browser/controls/:controlID/cancel", {
      params: { controlID: BrowserSchema.ID }, payload: BrowserSchema.Cancel,
      success: BrowserSchema.ControlView, error: errors,
    }))
    .add(HttpApiEndpoint.get("action", "/api/v1/browser/actions/:actionID", {
      params: { actionID: BrowserSchema.ID }, success: BrowserSchema.ActionView, error: errors,
    }))
    .add(HttpApiEndpoint.post("filesPreview", "/api/v1/browser/controls/:controlID/files/preview", {
      params: { controlID: BrowserSchema.ID }, payload: BrowserFileSchema.PreviewRequest,
      success: Schema.Struct({ controlID: BrowserSchema.ID, previewID: BrowserFileSchema.ID,
        controlRevision: BrowserSchema.Revision, preview: filePreview }), error: errors,
    }))
    .add(HttpApiEndpoint.post("filesApprove", "/api/v1/browser/controls/:controlID/files/approve", {
      params: { controlID: BrowserSchema.ID }, payload: BrowserFileSchema.Approve,
      success: Schema.Struct({ controlID: BrowserSchema.ID, grant: BrowserFileSchema.GrantSummary, replayed: Schema.Boolean }), error: errors,
    }))
    .add(HttpApiEndpoint.get("filesStatus", "/api/v1/browser/controls/:controlID/files/requests/:requestID", {
      params: { controlID: BrowserSchema.ID, requestID: BrowserFileSchema.ID },
      success: fileStatus, error: errors,
    }))
    .add(HttpApiEndpoint.get("filesList", "/api/v1/browser/controls/:controlID/files", {
      params: { controlID: BrowserSchema.ID },
      query: { cursor: Schema.optional(BrowserFileSchema.ID), limit: Schema.optional(Schema.NumberFromString.check(
        Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(BrowserFileSchema.MAX_FILES))) },
      success: Schema.Struct({ files: Schema.Array(BrowserFileSchema.Summary).check(Schema.isMaxLength(BrowserFileSchema.MAX_FILES)),
        grants: Schema.Array(BrowserFileSchema.GrantSummary).check(Schema.isMaxLength(BrowserFileSchema.MAX_FILES)),
        nextCursor: Schema.NullOr(BrowserFileSchema.ID) }), error: errors,
    })),
)
