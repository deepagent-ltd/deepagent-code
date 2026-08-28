import { expect, test } from "bun:test"
import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSelfClosingElement,
  isStringLiteral,
  type JsxOpeningLikeElement,
  type Node,
} from "typescript"

const nativeInteractive = new Set(["a", "button", "input", "select", "textarea", "summary"])
const interactiveRoles = new Set(["button", "checkbox", "link", "menuitem", "option", "radio", "switch", "tab"])

function interactiveName(opening: JsxOpeningLikeElement) {
  const tag = opening.tagName.getText()
  if (nativeInteractive.has(tag)) return tag
  const role = opening.attributes.properties.find(
    (attribute) => isJsxAttribute(attribute) && attribute.name.getText() === "role",
  )
  if (!role || !isJsxAttribute(role) || !role.initializer) return undefined
  const value = isStringLiteral(role.initializer)
    ? role.initializer.text
    : isJsxExpression(role.initializer) && role.initializer.expression && isStringLiteral(role.initializer.expression)
      ? role.initializer.expression.text
      : undefined
  return value && interactiveRoles.has(value) ? `[role=${value}]` : undefined
}

test("subagent panel JSX has no nested interactive controls", async () => {
  const path = `${import.meta.dir}/side-panel-subagents.tsx`
  const source = createSourceFile(path, await Bun.file(path).text(), ScriptTarget.Latest, true, ScriptKind.TSX)
  const violations: string[] = []

  const visit = (node: Node, parents: string[]) => {
    if (isJsxElement(node)) {
      const current = interactiveName(node.openingElement)
      if (current && parents.length > 0) violations.push(`${parents.join(" > ")} > ${current}`)
      node.children.forEach((child) => visit(child, current ? [...parents, current] : parents))
      return
    }
    if (isJsxSelfClosingElement(node)) {
      const current = interactiveName(node)
      if (current && parents.length > 0) violations.push(`${parents.join(" > ")} > ${current}`)
      return
    }
    forEachChild(node, (child) => visit(child, parents))
  }

  visit(source, [])
  expect(violations).toEqual([])
})
