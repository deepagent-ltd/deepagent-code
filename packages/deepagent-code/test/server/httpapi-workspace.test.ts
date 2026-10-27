// The builtin worktree adapter imports AppRuntime. Finish the source-only Root
// composition before evaluating any case imports that capture AppLayer.
if (process.platform === "win32") await import("../fixture/source-empty-settings-preload")
await import("./httpapi-workspace.cases")
