import { afterEach, describe, expect, test } from "bun:test"
import { desktopApi, isDesktop, isLocalFilesystemOp } from "./desktop-api"

// The accessor is a thin typed wrapper over the optional `window.api` injected by the desktop
// preload. Tests mutate the global between cases and restore it in afterEach. DesktopApi's fields
// are all optional, so an empty object is a valid bridge for these reference-equality checks.

const original = (window as { api?: unknown }).api

afterEach(() => {
  if (original === undefined) delete (window as { api?: unknown }).api
  else (window as { api?: unknown }).api = original
})

describe("desktopApi", () => {
  test("returns undefined when the desktop bridge is absent (web build)", () => {
    delete (window as { api?: unknown }).api
    expect(desktopApi()).toBeUndefined()
  })

  test("returns the injected bridge when present (desktop build)", () => {
    const api = {}
    ;(window as { api?: unknown }).api = api
    expect(desktopApi()).toBe(api)
  })
})

describe("isDesktop", () => {
  test("is false in the web build", () => {
    delete (window as { api?: unknown }).api
    expect(isDesktop()).toBe(false)
  })

  test("is true once the desktop bridge is injected", () => {
    ;(window as { api?: unknown }).api = {}
    expect(isDesktop()).toBe(true)
  })
})

describe("isLocalFilesystemOp", () => {
  // Gates every local-only file-tree operation (copy/cut/paste/delete/rename/archive/extract and
  // the git timeline). The rule is the AND of two independent conditions: the desktop bridge must
  // be present (Electron preload) AND the sidecar must be on loopback. A remote Server Edition
  // connection must NOT let the local bridge touch paths that only exist on the remote host.
  test("is true only when the desktop bridge is present AND the sidecar is loopback", () => {
    expect(isLocalFilesystemOp({ desktop: true, localSidecar: true })).toBe(true)
  })

  test("is false on the web build (no desktop bridge) even for a local sidecar", () => {
    expect(isLocalFilesystemOp({ desktop: false, localSidecar: true })).toBe(false)
  })

  test("is false on the desktop build when the sidecar is remote (Server Edition)", () => {
    // a remote sidecar means the workspace paths do not exist locally; the bridge must stay idle
    expect(isLocalFilesystemOp({ desktop: true, localSidecar: false })).toBe(false)
  })

  test("is false when neither condition holds", () => {
    expect(isLocalFilesystemOp({ desktop: false, localSidecar: false })).toBe(false)
  })
})
