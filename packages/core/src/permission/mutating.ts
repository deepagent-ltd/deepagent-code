// Shared mutating-permission set used by every read-only approval mode.
//
// Tools that write, execute, or otherwise mutate state — denied in read-only
// mode. Everything else (read/glob/grep/list/lsp/webfetch/websearch/
// todowrite/…) is left to the normal permission flow so the agent can still
// inspect the workspace.
//
// Consumers: the GUI directory read-only mode (packages/app) and the CLI
// `run --permission-mode read-only` auto-responder (packages/deepagent-code)
// must agree on this set, so it lives in core.
export const MUTATING_PERMISSIONS = new Set(["edit", "write", "patch", "bash", "task", "external_directory"])

export function isMutatingPermission(permission: string) {
  return MUTATING_PERMISSIONS.has(permission)
}
