# Electron Desktop Applications

## Boundary

This pack governs Electron desktop applications: the main vs renderer process split, IPC between them, context isolation and renderer security, preload scripts, native modules, and packaging with auto-update. Electron embeds Chromium plus Node.js, so an app is a privileged main process orchestrating sandboxed web renderers.

## Out of Scope

It does not cover general web UI work (code.frontend.web), TypeScript language detail (code.typescript), OS-native toolkits (Cocoa/WinUI), or web deployment. It assumes an Electron project with a build/packaging toolchain already exists.

## Default Posture

The renderer is untrusted, the main process is privileged: keep contextIsolation on and nodeIntegration off, expose only a minimal vetted API through a preload bridge, validate every IPC message in the main process, and never load remote content into a Node-enabled renderer.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.desktop.electron.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
