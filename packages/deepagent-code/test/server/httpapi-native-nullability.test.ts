import { expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { PermissionGroup } from "@deepagent-code/server/groups/permission"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { IMTaskResultResponse, MarkReadPayload } from "../../src/server/routes/instance/httpapi/groups/im"
import { IMTaskResult } from "../../src/im/task-result"
import { InvestigationControl } from "../../src/server/routes/instance/httpapi/groups/event-investigation"

function at(input: unknown, ...keys: string[]): unknown {
  return keys.reduce((value, key) => value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined, input)
}

function allowsNull(input: unknown): boolean {
  if (at(input, "type") === "null") return true
  const options = at(input, "anyOf") ?? at(input, "oneOf")
  return Array.isArray(options) && options.some(allowsNull)
}

test("permission list HTTP encoders omit absent optional fields and preserve explicit permission details", () => {
  const request = Schema.decodeUnknownSync(PermissionV2.Request)({
    id: "per_http_optional",
    sessionID: "ses_http_optional",
    action: "browser-program",
    resources: ["browser:scope"],
    save: undefined,
    metadata: undefined,
    source: undefined,
  })
  const location = Schema.decodeUnknownSync(Location.Info)({
    directory: "/tmp",
    project: { id: "global", directory: "/tmp" },
  })
  const details = { save: [], metadata: { kind: "browser-program", optional: null },
    source: { type: "tool" as const, messageID: "message", callID: "call" } }
  for (const name of ["permission.request.list", "session.permission.list"] as const) {
    // Exercise the endpoint's real JSON codec, which can differ from its OpenAPI projection.
    const encode = Schema.encodeSync(
      Array.from(PermissionGroup.endpoints[name].success)[0]! as Schema.Encoder<unknown>,
    )
    expect(at(encode({ location, data: [request] }), "data", "0")).toEqual({
      id: request.id, sessionID: request.sessionID, action: request.action, resources: request.resources,
    })
    expect(at(encode({ location, data: [{ ...request, ...details }] }), "data", "0")).toEqual({
      ...request, ...details,
    })
  }
  const view = at(OpenApi.fromApi(PublicApi), "components", "schemas", "PermissionRequestView")
  for (const key of ["save", "metadata", "source"]) {
    expect(at(view, "required")).not.toContain(key)
    expect(allowsNull(at(view, "properties", key))).toBe(false)
    expect(at(view, "properties", key)).toBeDefined()
  }
})

test("task status notices and authenticated remote lookup preserve a refused task's absent execution on the public wire", () => {
  const spec = OpenApi.fromApi(PublicApi)
  for (const [path, method] of [["/api/v1/im/messages/{messageId}/task-status", "get"],
    ["/api/v1/im/tasks/remote-status", "post"]]) {
    const operation = at(spec, "paths", path!, method!)
    const variants = at(operation, "responses", "200", "content", "application/json", "schema", "anyOf")
    const available = Array.isArray(variants) ? variants.find((value) => at(value, "properties", "state", "enum")?.toString() === "available") : undefined
    for (const key of ["grant", "work"]) {
      expect(at(available, "properties", "task", "required")).toContain(key)
      expect(allowsNull(at(available, "properties", "task", "properties", key))).toBe(true)
    }
    for (const status of ["401", "404", "503"]) expect(at(operation, "responses", status)).toBeDefined()
  }
  const tuple = at(spec, "paths", "/api/v1/im/tasks/remote-status", "post", "requestBody", "content", "application/json", "schema", "properties", "tuple")
  for (const key of ["url", "sessionID", "grant", "credential"]) expect(at(tuple, "properties", key)).toBeUndefined()
  expect(at(tuple, "properties", "orgID", "type")).toBe("string")
})

test("MCP credential and binding operations expose native bounded contracts and preserve absent identity", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const binding = at(spec, "components", "schemas", "McpBindingRepairPreview", "properties", "old")
  for (const key of ["locationObservedProjectId", "projectObservedProjectId"]) {
    expect(at(binding, "required")).toContain(key)
    expect(allowsNull(at(binding, "properties", key))).toBe(true)
  }
  for (const key of ["locationCreatedAt", "projectCreatedAt"]) {
    expect(at(binding, "properties", key, "type")).toBe("integer")
    expect(at(binding, "properties", key, "maximum")).toBe(Number.MAX_SAFE_INTEGER)
  }
  for (const [path, method] of [
    ["/mcp/{name}/credentials/initialize", "post"], ["/mcp/{name}/credentials/preview", "get"],
    ["/mcp/{name}/credentials/commit", "post"], ["/mcp/{name}/credentials/{requestID}", "get"],
    ["/mcp/{name}/credentials/{requestID}/reconcile", "post"], ["/mcp/{name}/binding/preview", "get"],
    ["/mcp/{name}/binding/repair", "post"],
  ]) {
    const operation = at(spec, "paths", path!, method!)
    expect(at(operation, "responses", "401")).toBeDefined()
    expect(at(operation, "responses", "409")).toBeDefined()
    expect(at(operation, "responses", "503")).toBeDefined()
  }
})

test("IM task management preserves absent control and independent nullable state on the public wire", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const cancel = at(spec, "paths", "/api/v1/im/tasks/requests/{requestID}/cancel", "post")
  const payload = at(cancel, "requestBody", "content", "application/json", "schema")
  expect(at(cancel, "requestBody", "required")).toBe(true)
  expect(at(payload, "required")).toContain("expectedControlRevision")
  expect(allowsNull(at(payload, "properties", "expectedControlRevision"))).toBe(true)
  const receipt = at(spec, "components", "schemas", "IMTaskCancelReceipt")
  for (const key of ["workID", "sessionID", "expectedControlRevision", "controlRevision", "controlState"]) {
    expect(at(receipt, "required")).toContain(key)
    expect(allowsNull(at(receipt, "properties", key))).toBe(true)
  }
  const state = at(spec, "components", "schemas", "IMTaskState")
  for (const key of ["source", "grant", "work"]) {
    expect(at(state, "required")).toContain(key)
    expect(allowsNull(at(state, "properties", key))).toBe(true)
  }
  expect(allowsNull(at(state, "properties", "targetScope", "properties", "workspaceID"))).toBe(true)
  for (const key of ["outboxStatus", "receiptState"])
    expect(allowsNull(at(state, "properties", "delivery", "properties", key))).toBe(true)
  for (const operation of [cancel, at(spec, "paths", "/api/v1/im/tasks/requests/{requestID}/state", "get")]) {
    expect(at(operation, "responses", "401")).toBeDefined()
    expect(at(operation, "responses", "403")).toBeDefined()
    expect(at(operation, "responses", "409")).toBeDefined()
  }
})

test("remote result lookup exposes a bounded native candidate and retains authenticated nullable placement", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const locator = at(spec, "paths", "/api/v1/im/messages/{messageId}/remote-task-locator", "get")
  const lookup = at(spec, "paths", "/api/v1/im/tasks/remote-result", "post")
  const tuple = at(lookup, "requestBody", "content", "application/json", "schema", "properties", "tuple")
  expect(at(tuple, "properties", "orgID", "type")).toBe("string")
  expect(at(tuple, "required")).toEqual(expect.arrayContaining(["realm", "appkey", "kernelMessageID", "senderID", "receiverID", "conversationType", "conversationID"]))
  for (const key of ["url", "endpoint", "credential", "sessionID", "grant", "auditedText"])
    expect(at(tuple, "properties", key)).toBeUndefined()
  const variants = at(lookup, "responses", "200", "content", "application/json", "schema", "anyOf")
  const available = Array.isArray(variants) ? variants.find((value) => at(value, "properties", "state", "enum")?.toString() === "available") : undefined
  expect(allowsNull(at(available, "properties", "placement", "properties", "workspaceID"))).toBe(true)
  for (const operation of [locator, lookup]) {
    expect(at(operation, "responses", "401")).toBeDefined()
    expect(at(operation, "responses", "503")).toBeDefined()
  }
})

test("task proposal review keeps absent workspace, policy and admission on the actual public wire", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const target = at(spec, "components", "schemas", "IMTaskTargetReview")
  for (const key of ["workspaceID", "projectID", "targetID"]) {
    expect(at(target, "required")).toContain(key)
    expect(allowsNull(at(target, "properties", key))).toBe(true)
  }
  expect(allowsNull(at(target, "properties", "tools", "properties", "fileScope"))).toBe(true)
  for (const key of ["provider", "endpoint", "credential", "commandRecipes", "environment"])
    expect(at(target, "properties", key)).toBeUndefined()
  const conversation = at(spec, "paths", "/api/v1/im/tasks/conversations/{groupID}", "get", "responses", "200", "content", "application/json", "schema")
  expect(allowsNull(at(conversation, "properties", "target"))).toBe(true)
  for (const [endpoint, method] of [["/api/v1/im/tasks/requests", "post"],
    ["/api/v1/im/tasks/requests/{requestID}", "get"],
    ["/api/v1/im/tasks/requests/{requestID}/accept", "post"]]) {
    const response = at(spec, "paths", endpoint!, method!, "responses", "200", "content", "application/json", "schema")
    expect(at(response, "required")).toContain("review")
    for (const key of ["admission", "workID", "sessionID", "inputID", "control"])
      expect(allowsNull(at(response, "properties", key))).toBe(true)
  }
})

test("task result location retains explicit absent workspace and the actual project path bound", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const response = at(spec, "paths", "/api/v1/im/messages/{messageId}/task-result", "get", "responses", "200", "content", "application/json", "schema")
  const variants = at(response, "anyOf")
  expect(Array.isArray(variants)).toBe(true)
  const available = Array.isArray(variants) ? variants.find((value) => at(value, "properties", "state", "enum")?.toString() === "available") : undefined
  const placement = at(available, "properties", "placement")
  expect(at(placement, "required")).toContain("workspaceID")
  expect(allowsNull(at(placement, "properties", "workspaceID"))).toBe(true)
  const value = { version: 1, state: "available", messageID: "message", groupID: "group",
    placement: { instanceID: "instance", securityNamespaceID: "namespace", projectID: "project", directory: "/" + "a".repeat(1024), workspaceID: null, sessionID: "session" },
    attempt: { requestID: "request", workID: "work", inputID: "input", ordinal: 1, outcome: "succeeded" } }
  expect(Schema.is(IMTaskResultResponse)(value)).toBe(true)
  expect(Schema.is(IMTaskResult.Result)(value)).toBe(true)
  expect(Schema.is(IMTaskResultResponse)({ ...value, placement: { ...value.placement, directory: "a".repeat(4097) } })).toBe(false)
  expect(Schema.is(IMTaskResult.Result)({ ...value, placement: { ...value.placement, directory: "a".repeat(4097) } })).toBe(false)
})

test("investigation wire has independent authority controls and bounded read-only reports", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const base = "/api/v1/event-investigation"
  const control = at(spec, "paths", `${base}/control`, "post", "requestBody", "content", "application/json", "schema")
  expect(at(control, "required")).toEqual(expect.arrayContaining(["ruleID", "requestID", "operation", "expectedEpoch", "expectedOperatorRevision", "targetID", "expiresAt", "captureID"]))
  expect(at(control, "properties", "operation", "enum")).toEqual(["enable", "disable"])
  for (const key of ["targetID", "expiresAt", "captureID"]) expect(allowsNull(at(control, "properties", key))).toBe(true)
  for (const key of ["provider", "endpoint", "credential", "tools", "recipe", "argv", "env", "scope", "hash"])
    expect(at(control, "properties", key)).toBeUndefined()
  const disabled = { ruleID: "rule", requestID: "request", operation: "disable", expectedEpoch: 0,
    expectedOperatorRevision: 1, targetID: null, expiresAt: null, captureID: null }
  expect(Schema.is(InvestigationControl)(disabled)).toBe(true)
  expect(Schema.is(InvestigationControl)({ ...disabled, captureID: "capture" })).toBe(false)
  expect(Schema.is(InvestigationControl)({ ...disabled, operation: "enable" })).toBe(false)
  expect(Schema.is(InvestigationControl)({ ...disabled, operation: "enable", targetID: "target", expiresAt: 1, captureID: "capture" })).toBe(true)
  expect(Schema.is(InvestigationControl)({ ...disabled, operation: "enable", targetID: "target", expiresAt: 1, captureID: null })).toBe(true)
  const reports = at(spec, "paths", `${base}/rules/{ruleID}/reports`, "get", "responses", "200", "content", "application/json", "schema")
  expect(at(reports, "maxItems")).toBe(32)
  for (const key of ["auditedText", "grant", "evidence", "logs", "ownerToken"])
    expect(at(reports, "items", "properties", key)).toBeUndefined()
  const candidates = at(spec, "paths", `${base}/rules/{ruleID}/candidates`, "get", "responses", "200", "content", "application/json", "schema")
  expect(at(candidates, "properties", "targets", "maxItems")).toBe(32)
  expect(at(candidates, "properties", "targets", "items", "properties", "profile", "properties", "id", "enum")).toEqual(["event_investigate_v1"])
  for (const [endpoint, method] of [[`${base}/rules/{ruleID}/candidates`, "get"], [`${base}/rules/{ruleID}/reports`, "get"], [`${base}/capture`, "post"], [`${base}/control`, "post"]]) {
    expect(at(spec, "paths", endpoint!, method!, "responses", "401")).toBeDefined()
    expect(at(spec, "paths", endpoint!, method!, "responses", "403")).toBeDefined()
  }
})

test("event validation public contract preserves explicit controls, nullable facts and bounded native evidence", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const base = "/api/v1/event-validation/rules"
  const configure = at(spec, "paths", `${base}/configure`, "post")
  const payload = at(configure, "requestBody", "content", "application/json", "schema")
  expect(at(configure, "requestBody", "required")).toBe(true)
  expect(at(payload, "required")).toEqual(expect.arrayContaining(["requestID", "ruleID", "expectedRevision", "configuration"]))
  const configuration = at(payload, "properties", "configuration")
  expect(at(configuration, "properties", "profile", "enum")).toEqual(["project_validation_v1"])
  expect(allowsNull(at(configuration, "properties", "scope", "properties", "workspaceID"))).toBe(true)
  expect(at(configuration, "properties", "watch", "maxItems")).toBe(256)
  expect(at(configuration, "properties", "investigation", "enum")).toEqual(["disabled"])
  const rules = at(spec, "paths", base, "get", "responses", "200", "content", "application/json", "schema", "items")
  expect(allowsNull(at(rules, "properties", "currentRunID"))).toBe(true)
  expect(allowsNull(at(rules, "properties", "contentHash"))).toBe(true)
  const run = at(spec, "paths", `${base}/{ruleID}/runs`, "get", "responses", "200", "content", "application/json", "schema", "items", "properties", "record")
  expect(allowsNull(at(run, "properties", "result"))).toBe(true)
  expect(allowsNull(at(run, "properties", "processID"))).toBe(true)
  expect(at(run, "properties", "contentRevision", "type")).toBe("integer")
  expect(at(run, "properties", "contentRevision", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
  const preparation = at(run, "properties", "preparationRelease")
  expect(at(run, "required")).not.toContain("preparationRelease")
  expect(allowsNull(preparation)).toBe(false)
  expect(at(preparation, "properties", "kind", "enum")).toEqual(["no_workspace_created", "partial_workspace_cleaned"])
  expect(allowsNull(at(preparation, "properties", "workspaceIdentity"))).toBe(true)
  expect(at(preparation, "properties", "observedAt", "type")).toBe("integer")
  const control = at(spec, "paths", `${base}/{ruleID}/control`, "post", "requestBody", "content", "application/json", "schema")
  expect(at(control, "properties", "action", "enum")).toEqual(["enable", "pause", "revoke", "verify", "cancel"])
  expect(at(control, "properties", "command")).toBeUndefined()
  expect(at(control, "properties", "env")).toBeUndefined()
  for (const [endpoint, method] of [[base, "get"], [`${base}/{ruleID}/runs`, "get"], [`${base}/configure`, "post"], [`${base}/{ruleID}/control`, "post"]]) {
    expect(at(spec, "paths", endpoint!, method!, "responses", "401")).toBeDefined()
    expect(at(spec, "paths", endpoint!, method!, "responses", "403")).toBeDefined()
  }
})

test("event validation capture SDK uses approved project candidates and opaque previews without caller native identities", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const base = "/api/v1/event-validation"
  const candidates = at(spec, "paths", `${base}/candidates`, "post")
  const target = at(candidates, "responses", "200", "content", "application/json", "schema", "properties", "targets", "items")
  expect(at(candidates, "requestBody", "content", "application/json", "schema", "required")).toContain("sessionID")
  const recipe = at(target, "properties", "recipes", "items")
  const variants = at(recipe, "anyOf")
  expect(Array.isArray(variants)).toBe(true)
  const executables = (value: unknown): unknown[] => {
    const variants = at(value, "anyOf")
    if (Array.isArray(variants)) return variants.flatMap(executables)
    const values = at(value, "properties", "executable", "enum")
    return Array.isArray(values) ? values : []
  }
  expect(executables(recipe))
    .toEqual(["installed-bun-v1", "installed-bun-mac-x64-v1", "installed-bun-v2"])
  const capture = at(spec, "paths", `${base}/capture`, "post")
  const input = at(capture, "requestBody", "content", "application/json", "schema")
  expect(at(input, "required")).toEqual(expect.arrayContaining(["sessionID", "targetID", "recipeID", "parameters", "watch", "maxRuns", "expiresAt"]))
  for (const key of ["scope", "helperHash", "rootIdentity", "executable", "argv", "env"])
    expect(at(input, "properties", key)).toBeUndefined()
  expect(at(input, "properties", "watch", "maxItems")).toBe(256)
  expect(at(input, "properties", "expiresAt", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
  const saved = at(spec, "paths", `${base}/rules/configure-captured`, "post")
  expect(at(saved, "requestBody", "content", "application/json", "schema", "required"))
    .toEqual(expect.arrayContaining(["captureID", "ruleID", "requestID", "expectedRevision"]))
  expect(at(saved, "responses", "409")).toBeDefined()
  const run = at(spec, "paths", `${base}/rules/{ruleID}/runs`, "get", "responses", "200", "content", "application/json", "schema", "items")
  expect(at(run, "properties", "observation", "enum")).toEqual(["owned", "known_terminal", "recovery_required"])
  for (const operation of [candidates, capture, saved]) {
    expect(at(operation, "requestBody", "required")).toBe(true)
    expect(at(operation, "responses", "401")).toBeDefined()
    expect(at(operation, "responses", "403")).toBeDefined()
  }
})

test("remote media SDK contract keeps bounded required descriptors and message-scoped locators", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const path = "/api/v1/im/groups/{groupId}/messages/{messageId}/attachments/{attachmentId}"
  const remote = at(spec, "paths", path, "get", "responses", "200", "content", "application/json", "schema")
  const messages = at(spec, "paths", "/api/v1/im/groups/{groupId}/messages", "get", "responses", "200", "content", "application/json", "schema")
  const attachments = at(messages, "properties", "messages", "items", "properties", "remoteAttachments")
  expect(allowsNull(attachments)).toBe(false)
  for (const descriptor of [remote, at(attachments, "items")]) {
    expect(at(descriptor, "required")).toEqual(expect.arrayContaining([
      "profile", "attachmentID", "contentRef", "filename", "mime", "sizeBytes", "sha256", "createdAt", "expiresAt",
    ]))
    expect(at(descriptor, "properties", "profile", "enum")).toEqual(["kernel_media"])
    expect(at(descriptor, "properties", "sizeBytes", "type")).toBe("integer")
    expect(at(descriptor, "properties", "sizeBytes", "minimum")).toBe(0)
    expect(at(descriptor, "properties", "sizeBytes", "maximum")).toBe(52428800)
    expect(at(descriptor, "properties", "expiresAt", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
    expect(at(descriptor, "properties", "storagePath")).toBeUndefined()
    expect(at(descriptor, "properties", "url")).toBeUndefined()
  }
  expect(at(spec, "paths", `${path}/content`, "get")).toBeDefined()
})

test("IM explicit new-read contract keeps legacy requests and requires an independent valid action", () => {
  expect(Schema.decodeUnknownSync(MarkReadPayload)({})).toEqual({})
  const request = { actionID: "gui-read_new-message", newAction: true }
  expect(Schema.decodeUnknownSync(MarkReadPayload)(request)).toEqual(request)
  for (const invalid of [
    { newAction: true },
    { actionID: "gui-read_new-message", newAction: true, reconcile: true },
    { actionID: "gui-read_new-message", newAction: true, continue: true },
    { actionID: "gui-read_new-message", newAction: true, cancel: true },
    { actionID: "../old-action", newAction: true },
  ]) expect(() => Schema.decodeUnknownSync(MarkReadPayload)(invalid)).toThrow()
  const spec = OpenApi.fromApi(PublicApi)
  const properties = at(spec, "paths", "/api/v1/im/groups/{groupId}/read", "post", "requestBody", "content", "application/json", "schema", "properties")
  expect(at(properties, "newAction", "type")).toBe("boolean")
  expect(at(properties, "actionID", "pattern")).toBe("^[A-Za-z0-9_-]{1,128}$")
})

test("native plan contract keeps actual required and optional NullOr values without adding nullable evidence", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const apply = at(spec, "paths", "/deepagent/goal/plan-rebase/apply", "post")
  const candidate = at(apply, "requestBody", "content", "application/json", "schema", "properties", "candidate")
  const step = at(candidate, "properties", "steps", "items")
  expect(at(apply, "requestBody", "required")).toBe(true)
  expect(at(apply, "requestBody", "content", "application/json", "schema", "properties", "requestID", "type")).toBe("string")
  expect(at(step, "properties", "step_id", "type")).toBe("string")
  expect(at(candidate, "required")).toContain("activeStepID")
  expect(allowsNull(at(candidate, "properties", "activeStepID"))).toBe(true)
  expect(allowsNull(at(step, "properties", "acceptance"))).toBe(true)
  expect(allowsNull(at(step, "properties", "assigned_agent"))).toBe(true)
  expect(allowsNull(at(step, "properties", "note"))).toBe(true)
  expect(allowsNull(at(step, "properties", "evidence"))).toBe(false)
  const request = { steps: [{ step_id: "future", title: "中文 future", status: "pending", acceptance: null }], activeStepID: null, dispositions: [] } satisfies typeof GoalPlanRebaseSchema.Candidate.Type
  expect(Schema.decodeUnknownSync(GoalPlanRebaseSchema.Candidate)(request)).toEqual(request)
  expect(() => Schema.decodeUnknownSync(GoalPlanRebaseSchema.Candidate)({
    ...request, steps: [{ ...request.steps[0], evidence: null }],
  })).toThrow()
})

test("every native plan response retains durable absence and actual authentication errors", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const endpoints = [
    ["/deepagent/goal/plan-rebase/begin", "post"],
    ["/deepagent/goal/plan-rebase/apply", "post"],
    ["/deepagent/goal/plan-rebase/cancel", "post"],
    ["/deepagent/goal/plan-rebase/{editID}", "get"],
    ["/deepagent/goal/plan-rebase/{editID}/reconcile", "post"],
  ]
  endpoints.forEach(([path, method]) => {
    const operation = at(spec, "paths", path, method)
    const response = at(operation, "responses", "200", "content", "application/json", "schema")
    expect(at(response, "required")).toContain("originalReceipt")
    expect(allowsNull(at(response, "properties", "originalReceipt"))).toBe(true)
    expect(allowsNull(at(response, "properties", "current", "properties", "editSource"))).toBe(true)
    expect(at(operation, "responses", "401")).toBeDefined()
  })
  const response = {
    version: 1, originalReceipt: null, replayed: false,
    current: { editID: "rebase_fixture", revision: 0, state: "recovery_required", controlRevision: 0,
      planRevision: 0, confirmedDocuments: 0, totalDocuments: 0, partial: false,
      safeToResume: false, execution: "blocked", retry: "refresh", editSource: null },
  } satisfies typeof GoalPlanRebaseSchema.Response.Type
  expect(Schema.decodeUnknownSync(GoalPlanRebaseSchema.Response)(response)).toEqual(response)
})

test("IM protected groups preserve actual null placement, pending unread and no expiry", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const groups = at(spec, "paths", "/api/v1/im/groups", "get", "responses", "200", "content", "application/json", "schema", "items")
  const groupReader = at(groups, "properties", "reader")
  expect(allowsNull(groupReader)).toBe(false)
  expect(at(groupReader, "required")).toContain("liveUnread")
  expect(allowsNull(at(groupReader, "properties", "liveUnread"))).toBe(true)
  expect(at(groups, "required")).toContain("projectID")
  expect(allowsNull(at(groups, "properties", "projectID"))).toBe(true)
  expect(allowsNull(at(groupReader, "properties", "readAction"))).toBe(false)
  expect(at(groupReader, "properties", "readAction", "properties", "cutIndex", "maximum")).toBe(31)
  const messages = at(spec, "paths", "/api/v1/im/groups/{groupId}/messages", "get", "responses", "200", "content", "application/json", "schema")
  const pageReader = at(messages, "properties", "reader")
  expect(allowsNull(pageReader)).toBe(false)
  expect(at(pageReader, "required")).toContain("nextExpiryAt")
  expect(allowsNull(at(pageReader, "properties", "nextExpiryAt"))).toBe(true)
  expect(at(pageReader, "properties", "validatedServerNow", "type")).toBe("integer")
  expect(at(pageReader, "properties", "validatedServerNow", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
})

test("explicit Work recovery contracts require bounded requests and expose auth and conflict failures", () => {
  const spec = OpenApi.fromApi(PublicApi)
  for (const path of ["/api/v1/im/work/{workID}/recover-known", "/api/v1/im/work/{workID}/resume-recovered"]) {
    const operation = at(spec, "paths", path, "post")
    const request = at(operation, "requestBody", "content", "application/json", "schema")
    expect(at(operation, "requestBody", "required")).toBe(true)
    expect(at(request, "required")).toContain("requestID")
    expect(at(request, "properties", "expectedControlRevision", "type")).toBe("integer")
    expect(at(request, "properties", "expectedControlRevision", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
    expect(at(operation, "responses", "401")).toBeDefined()
    expect(at(operation, "responses", "403")).toBeDefined()
    expect(at(operation, "responses", "409")).toBeDefined()
    const response = at(operation, "responses", "200", "content", "application/json", "schema")
    expect(at(response, "required")).toContain("receipt")
    expect(at(response, "properties", "execution", "enum")).toEqual(["not_started", "drained", "attention_required"])
  }
  const recover = at(spec, "paths", "/api/v1/im/work/{workID}/recover-known", "post", "requestBody", "content", "application/json", "schema")
  expect(at(recover, "properties", "expectedClaimToken", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
  expect(allowsNull(at(recover, "properties", "action"))).toBe(false)
  const cleanup = at(spec, "paths", "/api/v1/im/work/cleanup-known", "post")
  expect(at(cleanup, "requestBody", "required")).toBe(true)
  for (const status of ["400", "401", "403", "409", "503"]) expect(at(cleanup, "responses", status)).toBeDefined()
  expect(at(spec, "paths", "/api/v1/im/work/{workID}/cleanup-known")).toBeUndefined()
})

test("IM native page and detail preserve nullable cursors and actual reader proof limits", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const page = at(spec, "paths", "/api/v1/im/groups/page", "get", "responses", "200", "content", "application/json", "schema")
  expect(at(page, "required")).toContain("nextCursor")
  expect(allowsNull(at(page, "properties", "nextCursor"))).toBe(true)
  expect(at(page, "properties", "hasMore", "type")).toBe("boolean")
  expect(allowsNull(at(page, "properties", "groups", "items", "properties", "projectID"))).toBe(true)
  expect(at(page, "properties", "groups", "items", "properties", "createdAt", "type")).toBe("integer")
  expect(at(page, "properties", "groups", "items", "properties", "updatedAt", "maximum")).toBe(Number.MAX_SAFE_INTEGER)
  const detail = at(spec, "paths", "/api/v1/im/groups/{groupId}", "get", "responses", "200", "content", "application/json", "schema")
  expect(at(detail, "required")).toContain("group")
  expect(allowsNull(at(detail, "properties", "group", "properties", "projectID"))).toBe(true)
  expect(at(detail, "properties", "group", "properties", "createdAt", "type")).toBe("integer")
  for (const response of [page, detail]) {
    const reader = at(response, "properties", "reader")
    expect(allowsNull(reader)).toBe(false)
    expect(at(reader, "properties", "proofWindowMs", "maximum")).toBe(1000)
    expect(at(reader, "required")).toContain("nextExpiryAt")
    expect(allowsNull(at(reader, "properties", "nextExpiryAt"))).toBe(true)
  }
})
