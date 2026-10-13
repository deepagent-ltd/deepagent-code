import { expect, test } from "bun:test"
import { Route } from "../src/route/client"
import { OpenAIResponses } from "../src/protocols/openai-responses"

test("route construction detects an in-place executable endpoint replacement", () => {
  const route = OpenAIResponses.route.with({ endpoint: { path: () => "/responses" } })
  expect(Route.hasIntegrity(route)).toBe(true)
  Reflect.set(route.endpoint, "path", () => "/different")
  expect(Route.hasIntegrity(route)).toBe(false)
})
