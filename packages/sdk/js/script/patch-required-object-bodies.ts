import ts from "typescript"

/** Repair only required JSON objects in the generated operation that owns them. */
export function patchRequiredObjectBodies(source: string, document: unknown) {
  const api = object(document)
  const paths = object(api.paths)
  const operations = Object.entries(paths).flatMap(([url, value]) => Object.entries(object(value)).flatMap(([method, value]) => {
    if (!["post", "put", "patch", "delete"].includes(method)) return []
    const operation = object(value)
    const body = object(operation.requestBody)
    if (body.required !== true) return []
    const schema = resolve(object(object(body.content)["application/json"]).schema, api)
    if (schema.type !== "object" || (Array.isArray(schema.required) && schema.required.length)) return []
    if (typeof operation.operationId !== "string") throw new Error("Required object operation has no ID")
    return [{ method, url }]
  }))
  const file = ts.createSourceFile("sdk.gen.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const edits: number[] = []
  const matched = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)) {
      const call = node.expression
      const method = node.expression.expression.name.text
      const request = call.arguments[0]
      const url = request && ts.isObjectLiteralExpression(request) ? request.properties.find((property) =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "url") : undefined
      const value = url && ts.isPropertyAssignment(url) && ts.isStringLiteral(url.initializer) ? url.initializer.text : undefined
      const operation = operations.find((operation) => operation.method === method && operation.url === value)
      if (operation) {
        const key = `${method} ${value}`
        if (matched.has(key)) throw new Error(`Ambiguous generated required object operation: ${key}`)
        // Generated operations construct params immediately before this return.
        // Refuse an upstream shape change rather than injecting an unknown name.
        if (!ts.isBlock(node.parent) || !node.parent.statements.some((statement) =>
          ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === "params")))
          throw new Error(`Generated params missing for ${key}`)
        matched.add(key)
        edits.push(node.getStart(file))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (matched.size !== operations.length) throw new Error("Required object patch did not match every API operation")
  return edits.sort((a, b) => b - a).reduce((result, offset) =>
    result.slice(0, offset) + "params.body ??= {}\n    " + result.slice(offset), source)
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function resolve(value: unknown, document: Record<string, unknown>) {
  const seen = new Set<string>()
  const state = { schema: object(value) }
  while (typeof state.schema.$ref === "string") {
    const ref = state.schema.$ref
    if (!ref.startsWith("#/components/schemas/") || seen.has(ref)) throw new Error("Unsupported JSON body schema reference")
    seen.add(ref)
    state.schema = object(object(object(document.components).schemas)[ref.slice("#/components/schemas/".length)])
  }
  return state.schema
}
