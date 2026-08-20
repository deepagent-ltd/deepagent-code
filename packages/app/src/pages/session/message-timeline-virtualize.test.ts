import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import type { Part, ToolPart, ToolStateCompleted } from "@deepagent-code/sdk/v2"

let shouldVirtualizeToolDiff: typeof import("./message-timeline").shouldVirtualizeToolDiff
let toolDiffPayloadSize: typeof import("./message-timeline").toolDiffPayloadSize

beforeAll(async () => {
  // Bun test resolves solid-js through the "worker" condition (SSR build). Several
  // packages in message-timeline's import graph assume the client build at module scope:
  // virtua/solid imports a web-only export, and @solidjs/router / @kobalte/core chunks
  // call client-only solid APIs on load. Stub those packages (nothing renders here, the
  // functions under test are pure) while keeping solid-js itself on the single SSR build
  // used by every other test file - mixing client/server solid builds in one process
  // deadlocks the reactive scheduler.
  const componentStub: any = new Proxy(() => null, { get: () => componentStub })
  mock.module("virtua/solid", () => ({ Virtualizer: componentStub }))
  // Keep the real (Kobalte-backed) message-part out of the module cache: other tests
  // (message-timeline.data.test.ts) mock this module and bun re-links cached importers
  // against the real one otherwise.
  mock.module("@deepagent-code/ui/message-part", () => ({
    ContextToolGroup: componentStub,
    Message: componentStub,
    MessageDivider: componentStub,
    Part: componentStub,
    partDefaultOpen: () => false,
    groupParts: () => [],
    renderable: () => true,
  }))
  mock.module("@solidjs/router", () => ({
    A: componentStub,
    Navigate: componentStub,
    Route: componentStub,
    Router: componentStub,
    useIsRouting: () => () => false,
    useLocation: () => ({ pathname: "/" }),
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useSearchParams: () => ({}),
  }))
  const kobalte: Record<string, Record<string, unknown>> = {
    "@kobalte/core/accordion": { Accordion: componentStub },
    "@kobalte/core/button": { Button: componentStub },
    "@kobalte/core/checkbox": { Checkbox: componentStub },
    "@kobalte/core/collapsible": { Collapsible: componentStub },
    "@kobalte/core/context-menu": { ContextMenu: componentStub },
    "@kobalte/core/dialog": { Dialog: componentStub },
    "@kobalte/core/dropdown-menu": { DropdownMenu: componentStub },
    "@kobalte/core/hover-card": { HoverCard: componentStub },
    "@kobalte/core/popover": { Popover: componentStub },
    "@kobalte/core/progress": { Progress: componentStub },
    "@kobalte/core/radio-group": { RadioGroup: componentStub },
    "@kobalte/core/segmented-control": { SegmentedControl: componentStub },
    "@kobalte/core/select": { Select: componentStub },
    "@kobalte/core/switch": { Switch: componentStub },
    "@kobalte/core/tabs": { Tabs: componentStub },
    "@kobalte/core/text-field": { TextField: componentStub },
    "@kobalte/core/toast": { Toast: componentStub, toaster: componentStub },
    "@kobalte/core/tooltip": { Tooltip: componentStub },
  }
  for (const [name, exports] of Object.entries(kobalte)) {
    mock.module(name, () => exports)
  }

  const mod = await import("./message-timeline")
  shouldVirtualizeToolDiff = mod.shouldVirtualizeToolDiff
  toolDiffPayloadSize = mod.toolDiffPayloadSize
})

// Drop the stubs once this file's tests are done so later files link the real modules;
// the modules loaded above stay cached but are harmless (other test files that need
// them, e.g. message-timeline.data.test.ts, register their own mocks).
afterAll(() => mock.restore())

const large = "x".repeat(500_001)
const small = "x".repeat(100)

function completedTool(overrides: Partial<Omit<ToolStateCompleted, "status">> = {}, tool = "edit"): ToolPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool,
    state: {
      status: "completed",
      input: {},
      output: small,
      title: "done",
      metadata: {},
      time: { start: 1, end: 2 },
      ...overrides,
    },
  }
}

describe("shouldVirtualizeToolDiff (UX-001)", () => {
  test("non-tool parts never virtualize", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text",
      text: large,
    } satisfies Part
    expect(toolDiffPayloadSize(part)).toBe(0)
    expect(shouldVirtualizeToolDiff(part)).toBe(false)
  })

  test("streaming (pending/running) parts never virtualize even with large payloads", () => {
    const running: ToolPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "tool",
      callID: "call-1",
      tool: "edit",
      state: { status: "running", input: {}, metadata: { filediff: { after: large } }, time: { start: 1 } },
    }
    expect(shouldVirtualizeToolDiff(running)).toBe(false)

    const pending: ToolPart = { ...running, state: { status: "pending", input: {}, raw: large } }
    expect(shouldVirtualizeToolDiff(pending)).toBe(false)
  })

  test("error parts never virtualize", () => {
    const errored: ToolPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "tool",
      callID: "call-1",
      tool: "edit",
      state: { status: "error", input: {}, error: large, time: { start: 1, end: 2 } },
    }
    expect(shouldVirtualizeToolDiff(errored)).toBe(false)
  })

  test("small completed diffs stay non-virtualized", () => {
    expect(shouldVirtualizeToolDiff(completedTool())).toBe(false)
    expect(shouldVirtualizeToolDiff(completedTool({ output: small, metadata: { filediff: { after: small } } }))).toBe(
      false,
    )
  })

  test("completed edit tool with large filediff payload virtualizes", () => {
    expect(shouldVirtualizeToolDiff(completedTool({ metadata: { filediff: { after: large } } }))).toBe(true)
    expect(shouldVirtualizeToolDiff(completedTool({ metadata: { filediff: { before: large } } }))).toBe(true)
    expect(shouldVirtualizeToolDiff(completedTool({ metadata: { filediff: { patch: large } } }))).toBe(true)
  })

  test("completed apply_patch with large per-file patch virtualizes", () => {
    const part = completedTool({ metadata: { files: [{ filePath: "a.ts", patch: large }] } }, "apply_patch")
    expect(shouldVirtualizeToolDiff(part)).toBe(true)

    const multi = completedTool(
      { metadata: { files: [{ filePath: "a.ts", patch: small }, { filePath: "b.ts", diff: large }] } },
      "apply_patch",
    )
    expect(shouldVirtualizeToolDiff(multi)).toBe(true)
  })

  test("falls back to output length proxy when no diff metadata exists", () => {
    expect(shouldVirtualizeToolDiff(completedTool({ output: large }))).toBe(true)
    expect(toolDiffPayloadSize(completedTool({ output: large }))).toBe(large.length)
  })

  test("threshold boundary is strict (> 500KB)", () => {
    const exact = completedTool({ output: "x".repeat(500_000) })
    expect(shouldVirtualizeToolDiff(exact)).toBe(false)
  })
})
