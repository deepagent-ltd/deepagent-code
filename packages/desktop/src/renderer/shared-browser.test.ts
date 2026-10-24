import { expect, test } from "bun:test"
import type {
  SharedBrowserPlatform,
  SharedBrowserRootBridge,
  SharedBrowserRootResponse,
  SharedBrowserView,
} from "@deepagent-code/core/browser/shared-platform"
import { createSharedBrowserPlatform } from "./shared-browser"

test("root generation drops retired previews and state without reordering input or closing the shared page", async () => {
  const view: SharedBrowserView = {
    resource: {
      version: 2,
      profile: "managed-shared-browser-v1",
      inputAssurance: "shared-document-v1",
      resourceID: "resource",
      requestID: "create",
      requestDigest: "a".repeat(64),
      rootSessionID: "session",
      mainIncarnation: "main",
      scope: {
        principal: "owner",
        securityNamespaceID: "ns",
        locationKey: "local",
        projectScopeKey: "project",
        namespaceBindingHash: "b".repeat(64),
        sessionID: "session",
        projectID: "project",
        directory: "/project",
        workspaceID: null,
      },
      policy: {
        origin: "https://example.com",
        approvedOrigins: ["https://example.com"],
        manualApprovedOrigins: ["https://example.com"],
        resolverPolicy: "system",
        postGrants: [],
      },
      policyHash: "c".repeat(64),
      state: "agent_owned",
      revision: 1,
      manualEpoch: 0,
      barrierOrder: 0,
      coreCutoff: -1,
      liveLeaseID: "lease",
      agentAccessFenced: false,
      resourceAlive: true,
      manualEnabled: false,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
    },
  }
  const listeners = new Set<(value: SharedBrowserRootResponse<SharedBrowserView>) => void>()
  const calls: string[] = []
  const preview = Promise.withResolvers<SharedBrowserRootResponse<{ manualEpoch: number; png?: string }>>()
  const roots = { count: 0 }
  const bridge: SharedBrowserRootBridge = {
    register: () => ({ generation: `root-${++roots.count}` }),
    detach: async (generation) => {
      calls.push(`detach:${generation}`)
    },
    list: async (generation) => {
      calls.push(`list:${generation}`)
      return { generation, value: [view] }
    },
    create: async (generation) => ({ generation, value: view }),
    takeover: async (generation) => ({ generation, value: view }),
    close: async (generation) => {
      calls.push(`close:${generation}`)
      return { generation, value: view }
    },
    preview: async () => preview.promise,
    stampInput: async (generation) => {
      calls.push(`stamp:${generation}`)
      return { generation, value: undefined }
    },
    sealInput: async () => {
      throw new Error("This transport fixture cannot seal owner input")
    },
    onState: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    tuiPending: async (generation) => ({ generation, value: [] }),
    tuiApprove: async () => {
      throw new Error("This generation fixture does not approve terminal ownership")
    },
    tuiDetach: async () => {
      throw new Error("This generation fixture does not retire terminal ownership")
    },
    onTuiState: () => () => {},
  }
  const first = createSharedBrowserPlatform(bridge)
  const updates: SharedBrowserView[] = []
  const off = first.platform.onState((value) => updates.push(value))
  for (const callback of listeners) callback({ generation: "root-1", value: view })
  expect(updates).toHaveLength(1)
  off()
  expect(calls).toEqual([])
  expect(roots.count).toBe(1)
  const oldPreview = first.platform.preview({ resourceID: "resource", sessionID: "session", manualEpoch: 0 })
  first.dispose()
  first.dispose()
  const second = createSharedBrowserPlatform(bridge)
  second.platform.onState((value) => updates.push(value))
  for (const callback of listeners) callback({ generation: "root-1", value: view })
  expect(updates).toHaveLength(1)
  for (const callback of listeners) callback({ generation: "root-2", value: view })
  expect(updates).toHaveLength(2)
  preview.resolve({ generation: "root-1", value: { manualEpoch: 0, png: "retired-frame" } })
  await expect(oldPreview).rejects.toThrow("connection was retired")
  await expect(first.platform.list("session")).rejects.toThrow("connection was retired")
  await expect(
    second.platform.preview({ resourceID: "resource", sessionID: "session", manualEpoch: 0 }),
  ).rejects.toThrow("connection was retired")
  const stamp = second.platform.stampInput({
    sessionID: "session",
    inputID: "input",
    originalSubmissionID: "submission",
    rawInput: "continue",
  })
  expect(calls).toEqual(["detach:root-1", "stamp:root-2"])
  await stamp
  second.dispose()
  expect(calls).toEqual(["detach:root-1", "stamp:root-2", "detach:root-2"])
  expect(listeners.size).toBe(0)
})

test("terminal pairing replies and metadata retire with their exact root generation", async () => {
  const listeners = new Set<Parameters<SharedBrowserRootBridge["onTuiState"]>[0]>()
  const approval = Promise.withResolvers<Awaited<ReturnType<SharedBrowserRootBridge["tuiApprove"]>>>()
  const roots = { value: 0 }
  const retired = async (): Promise<never> => {
    throw new Error("This renderer transport fixture cannot operate a browser")
  }
  const bridge: SharedBrowserRootBridge = {
    register: () => ({ generation: `root-${++roots.value}` }),
    detach: async () => {},
    list: retired,
    create: retired,
    takeover: retired,
    close: retired,
    preview: retired,
    stampInput: retired,
    sealInput: retired,
    onState: () => () => {},
    tuiPending: async (generation) => ({ generation, value: [] }),
    tuiApprove: async () => approval.promise,
    tuiDetach: retired,
    onTuiState: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
  const view: Awaited<ReturnType<SharedBrowserPlatform["tuiPending"]>>[number] = {
    requestID: "request",
    challengeHash: "a".repeat(64),
    rootSessionID: "session",
    directory: "/project",
    attachID: "attach",
    generation: "terminal-stream",
    pendingUntil: 60_000,
    state: "pending",
    streamLive: true,
    barrierOrder: 3,
  }
  const first = createSharedBrowserPlatform(bridge)
  const reply = first.platform.tuiApprove({ ...view, expectedGeneration: view.generation })
  first.dispose()
  const second = createSharedBrowserPlatform(bridge)
  const updates: (typeof view)[] = []
  second.platform.onTuiState((value) => updates.push(value))
  for (const listener of listeners) listener({ generation: "root-1", value: view })
  expect(updates).toHaveLength(0)
  for (const listener of listeners) listener({ generation: "root-2", value: view })
  expect(updates).toEqual([view])
  approval.resolve({ generation: "root-1", value: { ...view, state: "active" } })
  await expect(reply).rejects.toThrow("connection was retired")
  second.dispose()
  expect(listeners.size).toBe(0)
})
