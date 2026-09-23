import { describe, expect, test } from "bun:test"
import { pathKey } from "./path-key"

describe("pathKey", () => {
  test("normalizes posix paths", () => {
    expect(String(pathKey("/a/b/"))).toBe("/a/b")
    expect(String(pathKey("/"))).toBe("/")
  })

  test("normalizes windows paths to forward slashes", () => {
    expect(String(pathKey("C:\\Users\\me"))).toBe("C:/Users/me")
    expect(String(pathKey("C:"))).toBe("C:/")
  })

  test("degrades a missing directory to a neutral key instead of crashing", () => {
    // Regression: session payloads without a directory reached the sidebar sort and the
    // undefined access took the whole layout down via the error boundary.
    expect(String(pathKey(undefined as unknown as string))).toBe("")
  })
})
