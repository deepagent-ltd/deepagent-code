import { describe, expect, test } from "bun:test"
import { canExtract, canOpenTimeline, canPaste, parentPath } from "./file-tree-menu"

// These rules encode the file-tree context menu's multi-platform / Server-Edition degradation
// contract: local-only and destructive operations are gated on `localFs` (desktop bridge present
// AND loopback sidecar), plus node-type / filename conditions. A change to the gating surfaces as
// a focused failure here instead of only as a regression in the rendered menu.

describe("parentPath", () => {
  test("returns the directory portion of a nested path", () => {
    expect(parentPath("src/components/file-tree.tsx")).toBe("src/components")
  })

  test("returns the top-level directory for a shallow file", () => {
    expect(parentPath("README.md")).toBe("")
  })

  test("returns '' for a root-level path with no slash", () => {
    expect(parentPath("file")).toBe("")
  })

  test("handles a trailing slash by slicing at the last separator", () => {
    // the menu calls parentPath(node.path) to refresh the containing directory after an op;
    // a directory node path like "src/sub/" still yields "src/sub"
    expect(parentPath("src/sub/")).toBe("src/sub")
  })
})

describe("canPaste", () => {
  test("is offered on a directory with a clip and local fs available", () => {
    expect(canPaste({ nodeType: "directory", hasClip: true, localFs: true })).toBe(true)
  })

  test("is hidden on a file even with a clip and local fs", () => {
    expect(canPaste({ nodeType: "file", hasClip: true, localFs: true })).toBe(false)
  })

  test("is hidden when there is no clip to paste", () => {
    expect(canPaste({ nodeType: "directory", hasClip: false, localFs: true })).toBe(false)
  })

  test("is hidden on the web build / remote Server Edition sidecar (no local fs)", () => {
    // paste is destructive (move on cut) — must not surface when the local bridge is unavailable
    expect(canPaste({ nodeType: "directory", hasClip: true, localFs: false })).toBe(false)
  })
})

describe("canExtract", () => {
  test("is offered on a .zip file", () => {
    expect(canExtract({ nodeType: "file", name: "archive.zip" })).toBe(true)
  })

  test("is case-insensitive on the .zip extension", () => {
    expect(canExtract({ nodeType: "file", name: "ARCHIVE.ZIP" })).toBe(true)
    expect(canExtract({ nodeType: "file", name: "Archive.Zip" })).toBe(true)
  })

  test("is hidden on a non-zip file", () => {
    expect(canExtract({ nodeType: "file", name: "notes.txt" })).toBe(false)
    expect(canExtract({ nodeType: "file", name: "tar.gz" })).toBe(false)
  })

  test("is hidden on a directory even if named *.zip", () => {
    expect(canExtract({ nodeType: "directory", name: "bundle.zip" })).toBe(false)
  })
})

describe("canOpenTimeline", () => {
  test("is offered on a file when local fs is available (local git binary)", () => {
    expect(canOpenTimeline({ nodeType: "file", localFs: true })).toBe(true)
  })

  test("is hidden on a directory (git log is per-file)", () => {
    expect(canOpenTimeline({ nodeType: "directory", localFs: true })).toBe(false)
  })

  test("is hidden on the web build / remote Server Edition sidecar (no local git)", () => {
    expect(canOpenTimeline({ nodeType: "file", localFs: false })).toBe(false)
  })
})
