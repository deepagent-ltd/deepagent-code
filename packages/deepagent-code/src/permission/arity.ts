// Compatibility shim: the canonical BashArity dictionary now lives in core so the V1 ShellTool
// and the V2 core bash tool share one source (D-W2). Keep this re-export — the package's `./*`
// export map makes `@/permission/arity` a public import path.
export { BashArity } from "@deepagent-code/core/shell/arity"
