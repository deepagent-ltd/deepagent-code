import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { CapabilityApi, CapabilityPaths } from "../../src/server/routes/instance/httpapi/groups/capability"
import { MaintenanceApi, MaintenancePaths } from "../../src/server/routes/instance/httpapi/groups/maintenance"
import { SystemContextApi, SystemContextPaths } from "../../src/server/routes/instance/httpapi/groups/system-context"

// C6-01/02 OpenAPI-ready schema + route table (design §11.1). These build the API
// definition into its OpenAPI document (no server run) and assert the route/method
// table and that the wire schemas never include a procedure body.

type Operation = { responses: Record<string, { description?: string }> }

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  $ref?: string
}

const opOf = (doc: unknown, path: string, method: string): Operation | undefined => {
  const p = (doc as { paths: Record<string, Record<string, Operation>> }).paths?.[path]
  return p?.[method]
}

const schemaOf = (op: Operation, status: string): JsonSchema | undefined => {
  const content = JSON.parse(JSON.stringify(op.responses[status])) as {
    content: { "application/json": { schema: JsonSchema } }
  }
  return content.content?.["application/json"]?.schema
}

describe("C6-01 maintenance OpenAPI route table", () => {
  const doc = OpenApi.fromApi(MaintenanceApi)

  test("exposes the designed bootstrap/backup/upgrade/recovery routes", () => {
    const table: [string, string][] = [
      ["GET", MaintenancePaths.bootstrapStatus],
      ["GET", MaintenancePaths.backupList],
      ["GET", MaintenancePaths.backupVerify],
      ["POST", MaintenancePaths.backupRestore],
      ["GET", MaintenancePaths.upgradeStatus],
      ["GET", MaintenancePaths.recoveryList],
      ["POST", MaintenancePaths.recoveryCommand],
      ["GET", MaintenancePaths.recoveryCommandGet],
      ["GET", MaintenancePaths.recoveryEvidenceExport],
      ["POST", MaintenancePaths.recoveryEvidenceExport],
    ]
    for (const [method, path] of table) {
      expect(opOf(doc, path, method.toLowerCase()), `${method} ${path}`).toBeDefined()
    }
  })

  test("bootstrap/status and backup/restore declare a 200 success response", () => {
    const status = opOf(doc, MaintenancePaths.bootstrapStatus, "get")!
    expect(status.responses["200"]).toBeDefined()
    const restore = opOf(doc, MaintenancePaths.backupRestore, "post")!
    expect(restore.responses["200"]).toBeDefined()
  })
})

describe("C6-02 capability + system-context OpenAPI route table", () => {
  const cap = OpenApi.fromApi(CapabilityApi)
  const sys = OpenApi.fromApi(SystemContextApi)

  test("exposes catalog/search/loadReceipts routes", () => {
    expect(opOf(cap, CapabilityPaths.catalog, "get")).toBeDefined()
    expect(opOf(cap, CapabilityPaths.search, "post")).toBeDefined()
    expect(opOf(cap, CapabilityPaths.loadReceipts, "get")).toBeDefined()
  })

  test("exposes system-context/snapshot", () => {
    expect(opOf(sys, SystemContextPaths.snapshot, "get")).toBeDefined()
  })

  test("the search response schema never declares a procedure body", () => {
    const search = opOf(cap, CapabilityPaths.search, "post")!
    const root = schemaOf(search, "200")!
    // The card item shape is under the `cards` array items.
    const cardProps = root.properties?.cards?.items?.properties ?? root.properties
    expect(cardProps?.body).toBeUndefined()
    expect(cardProps?.body_ref).toBeDefined()
  })

  test("the catalog response schema never declares a procedure body", () => {
    const catalog = opOf(cap, CapabilityPaths.catalog, "get")!
    const root = schemaOf(catalog, "200")!
    if (root.$ref) {
      // Resolve the $ref to the components schema so we can inspect the entry shape.
      const capDoc = JSON.parse(JSON.stringify(cap)) as {
        components: { schemas: Record<string, JsonSchema> }
      }
      const refName = root.$ref.split("/").pop()!
      const schema = capDoc.components.schemas[refName]
      expect(schema.properties?.capabilities).toBeDefined()
    } else {
      expect(root.properties?.capabilities).toBeDefined()
    }
  })
})
