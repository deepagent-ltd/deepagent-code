import { describe, expect, test } from "bun:test"
import { PathAcl } from "@deepagent-code/core/deepagent/path-acl"

// PathAcl.isPathAllowed is a PURE function — plain unit tests. It decides containment LEXICALLY after
// path.resolve collapses `.`/`..`, so no filesystem is touched.

const ROOT = "/workspace/project"

describe("PathAcl.isPathAllowed — within root", () => {
  test("the root itself and files under it are allowed", () => {
    expect(PathAcl.isPathAllowed("/workspace/project", [ROOT])).toBe(true)
    expect(PathAcl.isPathAllowed("/workspace/project/src/app.ts", [ROOT])).toBe(true)
    expect(PathAcl.isPathAllowed("/workspace/project/deep/nested/file.md", [ROOT])).toBe(true)
  })

  test("workspace-relative paths resolve UNDER a root", () => {
    expect(PathAcl.isPathAllowed("src/app.ts", [ROOT])).toBe(true)
    expect(PathAcl.isPathAllowed("./README.md", [ROOT])).toBe(true)
  })
})

describe("PathAcl.isPathAllowed — traversal / escape / absolute", () => {
  test("../.. traversal that climbs above the root is rejected", () => {
    expect(PathAcl.isPathAllowed("../../etc/passwd", [ROOT])).toBe(false)
    expect(PathAcl.isPathAllowed("/workspace/project/../../etc/passwd", [ROOT])).toBe(false)
  })

  test("absolute path outside the root is rejected", () => {
    expect(PathAcl.isPathAllowed("/etc/passwd", [ROOT])).toBe(false)
    expect(PathAcl.isPathAllowed("/workspace/other/secret", [ROOT])).toBe(false)
  })

  test("home-dir escape (sibling prefix) is rejected", () => {
    // a sibling whose name shares the root's prefix must NOT be treated as inside it.
    expect(PathAcl.isPathAllowed("/workspace/project-evil/x", [ROOT])).toBe(false)
    expect(PathAcl.isPathAllowed("/Users/attacker/.ssh/id_rsa", [ROOT])).toBe(false)
  })
})

describe("PathAcl.isPathAllowed — fail-closed edges", () => {
  test("empty allowedRoots allows nothing", () => {
    expect(PathAcl.isPathAllowed("/workspace/project/src/app.ts", [])).toBe(false)
    expect(PathAcl.isPathAllowed("anything", [])).toBe(false)
  })

  test("empty candidate is rejected", () => {
    expect(PathAcl.isPathAllowed("", [ROOT])).toBe(false)
  })

  test("multiple roots: allowed if within ANY root", () => {
    const roots = ["/a/one", "/b/two"]
    expect(PathAcl.isPathAllowed("/b/two/file.ts", roots)).toBe(true)
    expect(PathAcl.isPathAllowed("/a/one/x", roots)).toBe(true)
    expect(PathAcl.isPathAllowed("/c/three/x", roots)).toBe(false)
  })
})
