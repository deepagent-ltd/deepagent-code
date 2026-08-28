// CLI permission tri-state auto-responder (PARITY-002).
//
// Mirrors the GUI directory approval modes (packages/app permission.tsx):
//   request      → every permission prompt is auto-rejected (legacy default)
//   read-only    → mutating tools (MUTATING_PERMISSIONS from core) are
//                  rejected, everything else is approved once so the agent
//                  can still inspect the workspace
//   full-access  → every prompt is approved once
//                  (`--dangerously-skip-permissions` is kept as an alias)
import { isMutatingPermission } from "@deepagent-code/core/permission/mutating"

export const PERMISSION_MODES = ["request", "read-only", "full-access"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export type PermissionAutoReply = "once" | "reject"

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value)
}

// Resolves the effective mode from the parsed CLI args. Throws (caller turns
// into a CLI usage error) on unknown values or contradictory flag combos.
export function resolvePermissionMode(input: {
  "permission-mode"?: string
  "dangerously-skip-permissions"?: boolean
}): PermissionMode {
  const raw = input["permission-mode"]
  if (raw !== undefined && !isPermissionMode(raw)) {
    throw new Error(`--permission-mode must be one of: ${PERMISSION_MODES.join(", ")}`)
  }
  const mode: PermissionMode = raw ?? "request"
  if (input["dangerously-skip-permissions"]) {
    // The legacy flag is an alias for full-access; combining it with a
    // different mode is contradictory.
    if (raw !== undefined && mode !== "full-access") {
      throw new Error(
        "--dangerously-skip-permissions is an alias for --permission-mode full-access and cannot be combined with another mode",
      )
    }
    return "full-access"
  }
  return mode
}

// Decides the auto-reply for one permission prompt under the given mode.
export function permissionReplyFor(mode: PermissionMode, permission: string): PermissionAutoReply {
  if (mode === "full-access") return "once"
  if (mode === "read-only") return isMutatingPermission(permission) ? "reject" : "once"
  return "reject"
}
