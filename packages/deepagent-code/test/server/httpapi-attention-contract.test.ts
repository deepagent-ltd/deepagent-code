import { expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import type { AttentionItem, AttentionList } from "@deepagent-code/sdk/client"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

const item: AttentionSchema.Item = {
  id: "recovery:fixture",
  revision: "revision",
  kind: "execution_recovery",
  state: "execution_claim_pending",
  reasonCode: "claim_only",
  occurredAt: null,
  observedAt: 1000,
  session: { id: "ses_fixture", title: "Fixture", projectID: "project", directory: "/tmp/project", workspaceID: null },
  source: {},
  seen: false,
  seenAt: null,
}

// These assignments are compile-time assertions against the generated SDK as
// well as runtime examples; generated nullable/string-number drift fails typecheck.
const generated: AttentionItem = item
const observed: number = generated.observedAt
const occurred: number | null = generated.occurredAt
const seen: number | null = generated.seenAt
const count = (value: AttentionList): number => value.unseenCount

test("runtime attention schemas preserve required nulls and reject non-finite or string timestamps", () => {
  expect(Schema.is(AttentionSchema.Item)(item)).toBe(true)
  expect(Schema.is(AttentionSchema.Item)({ ...item, occurredAt: undefined })).toBe(false)
  expect(Schema.is(AttentionSchema.Item)({ ...item, seenAt: undefined })).toBe(false)
  for (const field of ["occurredAt", "observedAt", "seenAt"] as const) {
    for (const value of [NaN, Infinity, -Infinity, "NaN", "Infinity", "-Infinity"]) {
      expect(Schema.is(AttentionSchema.Item)({ ...item, [field]: value })).toBe(false)
    }
  }
  const page = { data: [item], scope: "implicit-local", asOf: 1000, unseenCount: 1 }
  expect(Schema.is(AttentionSchema.List)(page)).toBe(true)
  for (const unseenCount of [-1, 0.5, NaN, Infinity, "1", "NaN"]) {
    expect(Schema.is(AttentionSchema.List)({ ...page, unseenCount })).toBe(false)
  }
  expect(Schema.is(AttentionSchema.List)({ ...page, asOf: Infinity })).toBe(false)
  expect([observed, occurred, seen, count({ ...page, scope: "implicit-local" })]).toEqual([1000, null, null, 1])
})

test("public OpenAPI retains attention nullable fields without changing optional legacy properties", () => {
  const schemas = OpenApi.fromApi(PublicApi).components.schemas
  const attention = schemas.AttentionItem
  expect(attention).toMatchObject({
    required: expect.arrayContaining(["occurredAt", "observedAt", "seenAt"]),
    properties: {
      occurredAt: { anyOf: [{ type: "number" }, { type: "null" }] },
      observedAt: { type: "number" },
      seenAt: { anyOf: [{ type: "number" }, { type: "null" }] },
      session: { properties: { parentID: { type: "string" }, workspaceID: { type: "null" } } },
    },
  })
  expect(schemas.AttentionList).toMatchObject({
    properties: { asOf: { type: "number" }, unseenCount: { type: "integer", minimum: 0 } },
  })
  expect(JSON.stringify([attention, schemas.AttentionList])).not.toMatch(/NaN|Infinity/)
})
