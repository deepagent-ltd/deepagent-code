// Typed accessor for the optional Electron desktop bridge (`window.api`). In the web build it is
// undefined; in the desktop build the preload script injects it. The global `Window.api` type is
// declared in `src/app.tsx` via `DesktopApi` so the shared app package stays free of desktop-only
// type dependencies.

type FileOpResult = { ok: boolean; error?: string; path?: string }

type FileOpsApi = {
  copy: (root: string, source: string, destDir: string) => Promise<FileOpResult>
  move: (root: string, source: string, destDir: string) => Promise<FileOpResult>
  remove: (root: string, target: string) => Promise<FileOpResult>
  rename: (root: string, target: string, nextName: string) => Promise<FileOpResult>
  archive: (root: string, target: string) => Promise<FileOpResult>
  extract: (root: string, zipPath: string) => Promise<FileOpResult>
}

type GitLogEntry = { hash: string; author: string; date: string; subject: string }

type GitApi = {
  isTracked: (workDir: string, relPath: string) => Promise<{ ok: boolean; tracked: boolean; error?: string }>
  fileLog: (workDir: string, relPath: string) => Promise<{ ok: boolean; entries: GitLogEntry[]; error?: string }>
}

export type DesktopApi = {
  setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
  exportDebugLogs?: (options?: { windowMs?: number; pick?: boolean }) => Promise<string | null>
  fileOps?: FileOpsApi
  git?: GitApi
}

export function desktopApi(): DesktopApi | undefined {
  return window.api
}

export function isDesktop(): boolean {
  return Boolean(desktopApi())
}

/**
 * Whether local filesystem operations (the file-ops/git bridge) are usable. Requires BOTH the
 * desktop bridge (Electron preload injected `window.api`) AND a loopback sidecar — a remote
 * Server Edition connection must not let the local bridge touch paths that only exist on the
 * remote host. Extracted as a pure function so the degradation rule is unit-testable and the
 * three call sites (file-tree menu, timeline dialog, tree wiring) share one definition.
 */
export function isLocalFilesystemOp(input: { desktop: boolean; localSidecar: boolean }): boolean {
  return input.desktop && input.localSidecar
}
