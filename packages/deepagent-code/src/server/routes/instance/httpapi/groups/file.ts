import { FileSystem } from "@deepagent-code/core/filesystem"
import { Ripgrep } from "@deepagent-code/core/filesystem/ripgrep"
import { NonNegativeInt } from "@deepagent-code/core/schema"
import { LSP } from "@/lsp/lsp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const FileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
})

export const FindTextQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  pattern: Schema.String,
})

export const FindFileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
  dirs: Schema.optional(Schema.Literals(["true", "false"])),
  type: Schema.optional(Schema.Literals(["file", "directory"])),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
})

export const FindSymbolQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
})

export const LegacyEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
}).annotate({ identifier: "FileNode" })

export const LegacyContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  diff: Schema.optional(Schema.String),
  patch: Schema.optional(
    Schema.Struct({
      oldFileName: Schema.String,
      newFileName: Schema.String,
      oldHeader: Schema.optional(Schema.String),
      newHeader: Schema.optional(Schema.String),
      hunks: Schema.Array(
        Schema.Struct({
          oldStart: NonNegativeInt,
          oldLines: NonNegativeInt,
          newStart: NonNegativeInt,
          newLines: NonNegativeInt,
          lines: Schema.Array(Schema.String),
        }),
      ),
      index: Schema.optional(Schema.String),
    }),
  ),
  encoding: Schema.optional(Schema.Literal("base64")),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "FileContent" })

export const LegacyStatus = Schema.Struct({
  path: Schema.String,
  added: NonNegativeInt,
  removed: NonNegativeInt,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "File" })

export const FilePaths = {
  findText: "/find",
  findFile: "/find/file",
  findSymbol: "/find/symbol",
  list: "/file",
  content: "/file/content",
  status: "/file/status",
  // V3.6 Phase 1A — human-driven file mutations (bypass agent PermissionV2 gate)
  write: "/file/write",
  createFile: "/file/create",
  deleteFile: "/file/delete",
  rename: "/file/rename",
  mkdir: "/file/mkdir",
  // V3.6 Phase 2 LSP (human IDE smart capabilities, L1/L2)
  lspDiagnostics: "/lsp/diagnostics",
  lspHover: "/lsp/hover",
  lspDefinition: "/lsp/definition",
  lspCompletion: "/lsp/completion",
  lspCodeAction: "/lsp/code-action",
  lspRename: "/lsp/rename",
  // V3.7 Phase 4.1C — 人/Agent 编辑锁
  lockAcquire: "/file/lock",
  lockRenew: "/file/lock/renew",
  lockRelease: "/file/lock/release",
  lockStatus: "/file/lock/status",
} as const

// ── V3.6 mutation request / response schemas ──────────────────────────────────

/**
 * Write (overwrite) a file. If `expected` is supplied (base64 of the bytes
 * that were last loaded), the write is a compare-and-swap: it fails with
 * `error:"stale_content"` when the on-disk bytes differ.  Without `expected`
 * the write is unconditional (truncate-and-replace).
 */
export const WriteBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
  content: Schema.String,
  /** Base64-encoded snapshot of the bytes that were read; enables CAS save. */
  expected: Schema.optional(Schema.String),
}).annotate({ identifier: "FileWriteBody" })

/** Create a new file; fails if it already exists. */
export const CreateFileBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
  content: Schema.optional(Schema.String),
}).annotate({ identifier: "FileCreateBody" })

/** Delete a file or empty directory. */
export const DeleteFileBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
}).annotate({ identifier: "FileDeleteBody" })

/** Rename / move a path within the same workspace. */
export const RenameBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  from: Schema.String,
  to: Schema.String,
}).annotate({ identifier: "FileRenameBody" })

/** Create a directory (and any missing parents). */
export const MkdirBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
}).annotate({ identifier: "FileMkdirBody" })

/**
 * Mutation result envelope. `ok:true` means the operation succeeded.
 * `ok:false` + `error` surfaces a recoverable conflict:
 *   - "stale_content"  — CAS write: on-disk bytes changed since last load
 *   - "already_exists" — createFile: target already exists
 *   - "path_escape"    — requested path escapes the workspace root
 */
export const MutationResult = Schema.Struct({
  ok: Schema.Boolean,
  path: Schema.String,
  existed: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.Literals(["stale_content", "already_exists", "path_escape", "locked_by_human"])),
}).annotate({ identifier: "FileMutationResult" })

// ── V3.6 Phase 2 LSP request schemas ──────────────────────────────────────────
// All coordinates are 0-based (raw LSP protocol convention).

/** Single cursor position in a file. */
export const LspLocBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** Relative file path within the workspace. */
  file: Schema.String,
  /** Line number (0-based). */
  line: Schema.Number,
  /** Character offset on the line (0-based). */
  character: Schema.Number,
}).annotate({ identifier: "LspLocInput" })

/** A range in a file (start/end positions). */
export const LspRangeBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  file: Schema.String,
  startLine: Schema.Number,
  startCharacter: Schema.Number,
  endLine: Schema.Number,
  endCharacter: Schema.Number,
}).annotate({ identifier: "LspRangeInput" })

/** Rename request — includes the new name for the symbol. */
export const LspRenameBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  file: Schema.String,
  line: Schema.Number,
  character: Schema.Number,
  newName: Schema.String,
}).annotate({ identifier: "LspRenameInput" })

// ── V3.7 Phase 4.1C 编辑锁 schemas ───────────────────────────────────────────

export const LockAcquireBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
  kind: Schema.Literals(["human", "agent"]),
}).annotate({ identifier: "LockAcquireBody" })

export const LockRenewBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  lockId: Schema.String,
}).annotate({ identifier: "LockRenewBody" })

export const LockReleaseBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  lockId: Schema.String,
}).annotate({ identifier: "LockReleaseBody" })

export const LockEntry = Schema.Struct({
  lockId: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["human", "agent"]),
  expiresAt: Schema.Number,
}).annotate({ identifier: "FileLockEntry" })

export const LockAcquireResult = Schema.Struct({
  ok: Schema.Boolean,
  lock: Schema.optional(LockEntry),
  error: Schema.optional(Schema.Literals(["already_locked", "path_escape"])),
}).annotate({ identifier: "LockAcquireResult" })

export const FileApi = HttpApi.make("file")
  .add(
    HttpApiGroup.make("file")
      .add(
        HttpApiEndpoint.get("findText", FilePaths.findText, {
          query: FindTextQuery,
          success: described(Schema.Array(Ripgrep.SearchMatch), "Matches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.text",
            summary: "Find text",
            description: "Search for text patterns across files in the project using ripgrep.",
          }),
        ),
        HttpApiEndpoint.get("findFile", FilePaths.findFile, {
          query: FindFileQuery,
          success: described(Schema.Array(Schema.String), "File paths"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.files",
            summary: "Find files",
            description: "Search for files or directories by name or pattern in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("findSymbol", FilePaths.findSymbol, {
          query: FindSymbolQuery,
          success: described(Schema.Array(LSP.Symbol), "Symbols"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.symbols",
            summary: "Find symbols",
            description: "Search for workspace symbols like functions, classes, and variables using LSP.",
          }),
        ),
        HttpApiEndpoint.get("list", FilePaths.list, {
          query: FileQuery,
          success: described(Schema.Array(LegacyEntry), "Files and directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.list",
            summary: "List files",
            description: "List files and directories in a specified path.",
          }),
        ),
        HttpApiEndpoint.get("content", FilePaths.content, {
          query: FileQuery,
          success: described(LegacyContent, "File content"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.read",
            summary: "Read file",
            description: "Read the content of a specified file.",
          }),
        ),
        HttpApiEndpoint.get("status", FilePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LegacyStatus), "File status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.status",
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
          }),
        ),
        // ── V3.6 Phase 1A mutation endpoints (human IDE, bypass agent permission gate) ──
        HttpApiEndpoint.post("write", FilePaths.write, {
          payload: WriteBody,
          success: described(MutationResult, "Write result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.write",
            summary: "Write file",
            description:
              "Overwrite a file with new content. When `expected` (base64 snapshot) is provided the write is a compare-and-swap: it fails with error:stale_content if the on-disk bytes changed since the snapshot was taken.",
          }),
        ),
        HttpApiEndpoint.post("createFile", FilePaths.createFile, {
          payload: CreateFileBody,
          success: described(MutationResult, "Create result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.create",
            summary: "Create file",
            description: "Create a new file. Returns error:already_exists if the target path already exists.",
          }),
        ),
        HttpApiEndpoint.post("deleteFile", FilePaths.deleteFile, {
          payload: DeleteFileBody,
          success: described(MutationResult, "Delete result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.delete",
            summary: "Delete file",
            description: "Delete a file or empty directory.",
          }),
        ),
        HttpApiEndpoint.post("rename", FilePaths.rename, {
          payload: RenameBody,
          success: described(MutationResult, "Rename result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.rename",
            summary: "Rename / move",
            description: "Rename or move a file/directory within the same workspace root.",
          }),
        ),
        HttpApiEndpoint.post("mkdir", FilePaths.mkdir, {
          payload: MkdirBody,
          success: described(MutationResult, "Mkdir result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.mkdir",
            summary: "Make directory",
            description: "Create a directory and any missing parent directories.",
          }),
        ),

        // ── V3.6 Phase 2 LSP endpoints ─────────────────────────────────────
        // Expose LSP.Service capabilities so the built-in CodeEditor can provide
        // diagnostics, hover, go-to-definition, and autocomplete (L1/L2).
        // Coordinate convention: line/character are 0-based (raw LSP protocol).
        HttpApiEndpoint.get("lspDiagnostics", FilePaths.lspDiagnostics, {
          // V3.7 #7: optional `path` opens/syncs that file before pulling diagnostics.
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, path: Schema.optional(Schema.String) }),
          success: described(Schema.Unknown, "Diagnostics map {[file]: Diagnostic[]}"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.diagnostics",
            summary: "Get diagnostics",
            description: "Return the current per-file diagnostics from the language server.",
          }),
        ),
        HttpApiEndpoint.post("lspHover", FilePaths.lspHover, {
          payload: LspLocBody,
          success: described(Schema.Unknown, "Hover result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.hover",
            summary: "Hover info",
            description: "Return hover information (type / docs) at a position. Coordinates are 0-based.",
          }),
        ),
        HttpApiEndpoint.post("lspDefinition", FilePaths.lspDefinition, {
          payload: LspLocBody,
          success: described(Schema.Unknown, "Location list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.definition",
            summary: "Go to definition",
            description: "Return definition location(s) for the symbol at a position.",
          }),
        ),
        HttpApiEndpoint.post("lspCompletion", FilePaths.lspCompletion, {
          payload: LspLocBody,
          success: described(Schema.Unknown, "CompletionList"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.completion",
            summary: "Autocomplete",
            description: "Return completion items at a position.",
          }),
        ),
        HttpApiEndpoint.post("lspCodeAction", FilePaths.lspCodeAction, {
          payload: LspRangeBody,
          success: described(Schema.Unknown, "CodeAction list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.codeAction",
            summary: "Code actions",
            description: "Return code actions (quick fixes) for the given range.",
          }),
        ),
        HttpApiEndpoint.post("lspRename", FilePaths.lspRename, {
          payload: LspRenameBody,
          success: described(Schema.Unknown, "WorkspaceEdit preview"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.rename",
            summary: "Rename preview",
            description: "Return a WorkspaceEdit preview for renaming the symbol. Does NOT apply changes.",
          }),
        ),

        // ── V3.7 Phase 4.1C 编辑锁 endpoints ─────────────────────────────────
        HttpApiEndpoint.post("lockAcquire", FilePaths.lockAcquire, {
          payload: LockAcquireBody,
          success: described(LockAcquireResult, "Lock acquire result"),
        }).annotateMerge(OpenApi.annotations({
          identifier: "file.lock.acquire",
          summary: "Acquire file lock",
          description: "Acquire an edit lock for a file. Human locks take priority over agent locks.",
        })),
        HttpApiEndpoint.post("lockRenew", FilePaths.lockRenew, {
          payload: LockRenewBody,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Renew result"),
        }).annotateMerge(OpenApi.annotations({
          identifier: "file.lock.renew",
          summary: "Renew file lock",
          description: "Extend the TTL of an existing lock. Call every 15s from the editor (heartbeat).",
        })),
        HttpApiEndpoint.post("lockRelease", FilePaths.lockRelease, {
          payload: LockReleaseBody,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Release result"),
        }).annotateMerge(OpenApi.annotations({
          identifier: "file.lock.release",
          summary: "Release file lock",
          description: "Release a lock. No-op if the lockId does not match.",
        })),
        HttpApiEndpoint.get("lockStatus", FilePaths.lockStatus, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, path: Schema.String }),
          success: described(Schema.NullOr(LockEntry), "Lock status"),
        }).annotateMerge(OpenApi.annotations({
          identifier: "file.lock.status",
          summary: "Get lock status",
          description: "Returns the current lock entry for a path, or null if not locked.",
        })),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "file",
          description: "Experimental HttpApi file routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "deepagent-code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
