import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"

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
const sharedFilePreview = Schema.Union([
  Schema.Struct({ direction: Schema.Literal("upload"), name: BrowserFileSchema.Name, relative: BrowserFileSchema.Relative,
    bytes: BrowserFileSchema.FileBytes, sha256: BrowserFileSchema.Digest, targetURL: SharedBrowserFileSchema.TargetURL,
    observedAt: BrowserFileSchema.Count }),
  Schema.Struct({ direction: Schema.Literal("download"), name: BrowserFileSchema.Name, relative: BrowserFileSchema.Relative,
    maxBytes: BrowserFileSchema.FileBytes, targetURL: SharedBrowserFileSchema.TargetURL, observedAt: BrowserFileSchema.Count }),
])
const fileStatus = Schema.Struct({ requestID: BrowserFileSchema.ID,
  state: Schema.Literals(["approved", "used", "expired", "unavailable", "missing"]),
  grant: Schema.NullOr(BrowserFileSchema.GrantSummary) })
const sharedFileStatus = Schema.Union([fileStatus, Schema.Struct({ requestID: BrowserFileSchema.ID,
  state: Schema.Literal("cancelled"), grant: Schema.Null })])
export const BrowserApi = HttpApi.make("browser").add(
  HttpApiGroup.make("browser")
    .add(
      HttpApiEndpoint.post("tuiPair", "/api/v1/browser/shared/tui/pair", {
        payload: SharedBrowserTuiSchema.Pair,
        success: SharedBrowserTuiSchema.View,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("tuiOwner", "/api/v1/browser/shared/tui/owner", {
        payload: SharedBrowserTuiSchema.Connect,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("tuiReserve", "/api/v1/browser/shared/tui/reserve", {
        payload: SharedBrowserTuiSchema.Reserve,
        success: Schema.Struct({ stamp: Schema.optional(SharedBrowserSchema.InputStamp) }),
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("tuiSeal", "/api/v1/browser/shared/tui/seal", {
        payload: SharedBrowserTuiSchema.Seal,
        success: Schema.Struct({ stamp: SharedBrowserSchema.InputStamp }),
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("tuiDetach", "/api/v1/browser/shared/tui/detach", {
        payload: SharedBrowserTuiSchema.Detach,
        success: SharedBrowserTuiSchema.View,
        error: errors,
      }),
    )
    .add(HttpApiEndpoint.post("sharedCreate", "/api/v1/browser/shared/resources", {
      payload: SharedBrowserSchema.Create, success: Schema.Struct({ resource: SharedBrowserSchema.Resource }), error: errors,
    }))
    .add(HttpApiEndpoint.get("sharedList", "/api/v1/browser/shared/resources", {
      query: { sessionID: BrowserSchema.ID }, success: Schema.Struct({ resources: Schema.Array(SharedBrowserSchema.Resource) }), error: errors,
    }))
    .add(HttpApiEndpoint.get("sharedGet", "/api/v1/browser/shared/resources/:resourceID", {
      params: { resourceID: BrowserSchema.ID }, success: Schema.Struct({ resource: SharedBrowserSchema.Resource }), error: errors,
    }))
    .add(HttpApiEndpoint.post("sharedTakeover", "/api/v1/browser/shared/resources/:resourceID/takeover", {
      params: { resourceID: BrowserSchema.ID }, payload: SharedBrowserSchema.Takeover,
      success: Schema.Struct({ resource: SharedBrowserSchema.Resource }), error: errors,
    }))
    .add(HttpApiEndpoint.post("sharedApproveOrigin", "/api/v1/browser/shared/resources/:resourceID/origins", {
      params: { resourceID: BrowserSchema.ID }, payload: SharedBrowserSchema.ApproveOrigin,
      success: Schema.Struct({ resource: SharedBrowserSchema.Resource }), error: errors,
    }))
    .add(HttpApiEndpoint.post("sharedClose", "/api/v1/browser/shared/resources/:resourceID/close", {
      params: { resourceID: BrowserSchema.ID }, payload: SharedBrowserSchema.Close,
      success: Schema.Struct({ resource: SharedBrowserSchema.Resource }), error: errors,
    }))
    .add(HttpApiEndpoint.post("sharedFilesPreview", "/api/v1/browser/shared/resources/:resourceID/files/preview", {
      params: { resourceID: BrowserSchema.ID }, payload: SharedBrowserFileSchema.PreviewRequest,
      success: Schema.Struct({ resourceID: BrowserSchema.ID, previewID: BrowserSchema.ID, resourceRevision: BrowserSchema.Revision,
        leaseID: BrowserSchema.ID, leaseEpoch: BrowserSchema.Revision, manualEpoch: BrowserSchema.Count, preview: sharedFilePreview }), error: errors,
    }))
    .add(HttpApiEndpoint.post("sharedFilesApprove", "/api/v1/browser/shared/resources/:resourceID/files/approve", {
      params: { resourceID: BrowserSchema.ID }, payload: SharedBrowserFileSchema.Approve,
      success: Schema.Union([
        Schema.Struct({ resourceID: BrowserSchema.ID, grant: BrowserFileSchema.GrantSummary, replayed: Schema.Boolean }),
        Schema.Struct({ resourceID: BrowserSchema.ID, requestID: BrowserFileSchema.ID, state: Schema.Literal("cancelled"),
          grant: Schema.Null, replayed: Schema.Boolean }),
      ]), error: errors,
    }))
    .add(HttpApiEndpoint.get("sharedFilesStatus", "/api/v1/browser/shared/resources/:resourceID/files/requests/:requestID", {
      params: { resourceID: BrowserSchema.ID, requestID: BrowserSchema.ID }, success: sharedFileStatus, error: errors,
    }))
    .add(HttpApiEndpoint.get("sharedFilesList", "/api/v1/browser/shared/resources/:resourceID/files", {
      params: { resourceID: BrowserSchema.ID },
      query: { cursor: Schema.optional(BrowserSchema.ID), limit: Schema.optional(Schema.NumberFromString.check(
        Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(BrowserFileSchema.MAX_FILES))) },
      success: Schema.Struct({ files: Schema.Array(BrowserFileSchema.Summary).check(Schema.isMaxLength(BrowserFileSchema.MAX_FILES)),
        grants: Schema.Array(BrowserFileSchema.GrantSummary).check(Schema.isMaxLength(BrowserFileSchema.MAX_FILES)),
        nextCursor: Schema.NullOr(BrowserSchema.ID) }), error: errors,
    }))
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
