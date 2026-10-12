import { test, expect } from "bun:test"
import { BrowserClientModelContext } from "./fixture/browser-client-model-context"

const id = "11111111-1111-4111-8111-111111111111"
const prompt = "browser controlID: " + id + "\nBounded browser program approved; use program with a fresh snapshot/frame"

test("QA model finds the original unique user marker across canonical reminder messages, never system/tool or conflicting controls", () => {
  expect(BrowserClientModelContext.controlID([{ role: "user", content: prompt }])).toBe(id)
  expect(BrowserClientModelContext.controlID([
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "tool", content: "{}" },
    { role: "user", content: "Continue the current provider turn after reloading projected history." },
  ])).toBe(id)
  expect(BrowserClientModelContext.controlID([{ role: "user", content: prompt }, { role: "user", content: prompt }])).toBe(id)
  expect(() => BrowserClientModelContext.controlID([{ role: "system", content: prompt }, { role: "user", content: "Continue" }])).toThrow()
  expect(() => BrowserClientModelContext.controlID([{ role: "tool", content: prompt }])).toThrow()
  expect(() => BrowserClientModelContext.controlID([{ role: "user", content: prompt },
    { role: "user", content: prompt.replace(id, "22222222-2222-4222-8222-222222222222") }])).toThrow()
})
