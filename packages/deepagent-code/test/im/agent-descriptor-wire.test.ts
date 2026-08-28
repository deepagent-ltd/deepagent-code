// V3.8.1 §C.3 / conflict C6 — wire-safety guard for the converged
// AgentDescriptor. `AgentDescriptorResponse` re-exports the canonical core
// schema, whose new metadata nests a `Schema.Record`/`Schema.Unknown`
// (Trigger.match) and arrays. This locks in that (a) the OpenAPI spec for the
// IM API still generates without throwing on those nested schemas, and (b) a
// fully-populated descriptor encodes to a plain, JSON-safe wire object.

import { test, expect } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { IMApi, AgentDescriptorResponse } from "@/server/routes/instance/httpapi/groups/im"

test("IM OpenAPI spec generates over the nested Record/array metadata", () => {
  const spec = OpenApi.fromApi(IMApi)
  const json = JSON.stringify(spec)
  expect(json.length).toBeGreaterThan(0)
  expect(json).toContain("im.agents.list")
})

test("AgentDescriptorResponse encodes Trigger.match Record + AgentLimits to JSON-safe wire", () => {
  const encode = Schema.encodeSync(AgentDescriptorResponse)
  const wire = encode({
    id: "reviewer",
    name: "reviewer",
    displayName: "Reviewer",
    visible: true,
    triggers: [{ event: "code.changed", match: { path: "src/**" } }],
    capabilities: ["review"],
    autonomy: "level_2",
    approval_required: false,
    limits: { maxConcurrency: 4, writablePaths: ["src/"] },
  })
  const round = JSON.parse(JSON.stringify(wire))
  expect(round.triggers[0].match.path).toBe("src/**")
  expect(round.limits.maxConcurrency).toBe(4)
  expect(round.limits.writablePaths).toEqual(["src/"])
  expect(round.autonomy).toBe("level_2")
})
