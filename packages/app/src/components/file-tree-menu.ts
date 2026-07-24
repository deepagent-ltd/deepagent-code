// Pure decision logic for the file-tree context menu, kept in a .ts module so it can be unit-tested
// without importing the Solid component (which pulls in context providers and UI primitives).
//
// These rules encode the multi-platform / Server-Edition degradation contract: destructive and
// local-only operations (copy/cut/paste/delete/rename/archive/extract/timeline) are gated on
// `localFs` (desktop bridge present AND sidecar on loopback), and a few items additionally depend
// on node type or filename. Keeping them here means a change to the gating rules surfaces as a
// focused test failure instead of only as a regression in the rendered menu.

export type FileNodeType = "file" | "directory"

/** The parent directory path of a POSIX-style tree path ("" for top-level). */
export function parentPath(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx === -1 ? "" : p.slice(0, idx)
}

/** Paste is offered only on a directory, when a clip exists, and local fs ops are available. */
export function canPaste(input: { nodeType: FileNodeType; hasClip: boolean; localFs: boolean }): boolean {
  return input.nodeType === "directory" && input.hasClip && input.localFs
}

/** Extract is offered only on a file whose name ends with .zip (case-insensitive). */
export function canExtract(input: { nodeType: FileNodeType; name: string }): boolean {
  return input.nodeType === "file" && /\.zip$/i.test(input.name)
}

/** The git timeline is offered only on a file with local fs ops available (local git binary). */
export function canOpenTimeline(input: { nodeType: FileNodeType; localFs: boolean }): boolean {
  return input.nodeType === "file" && input.localFs
}
