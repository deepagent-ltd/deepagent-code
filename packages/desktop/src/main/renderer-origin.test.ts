import { expect, test } from "bun:test"
import { rendererOrigin } from "./renderer-origin"

test("development renderer keeps its exact origin without broadening ports or hosts", () => {
  expect(rendererOrigin("http://localhost:5173/")).toBe("http://localhost:5173")
  expect(rendererOrigin("http://127.0.0.1:5174")).toBe("http://127.0.0.1:5174")
  expect(rendererOrigin("http://[::1]:5175/")).toBe("http://[::1]:5175")
  expect(rendererOrigin("http://localhost:5173/")).not.toBe("http://localhost:52279")
})

test("missing or noncanonical development sources cannot add a renderer origin", () => {
  for (const value of [
    undefined,
    "",
    "not-a-url",
    "oc://renderer",
    "https://localhost:5173/",
    "http://localhost/",
    "http://localhost.example.com:5173/",
    "http://example.com:5173/",
    "http://user:secret@localhost:5173/",
    "http://localhost:5173/index.html",
    "http://localhost:5173/?credential=value",
    "http://localhost:5173/#fragment",
    "http://localhost:5173/other",
  ])
    expect(rendererOrigin(value)).toBeUndefined()
})
