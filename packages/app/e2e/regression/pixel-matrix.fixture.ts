import type { MockServerConfig } from "../utils/mock-server"

// C6-10 真像素矩阵 fixture — real-browser states: 中文/英文 session titles,
// a long typed error with a stable code, and a multi-item recovery dock. The
// messages reuse the exact renderable shapes of the smoke fixture so the
// timeline is representative; only the content focus changes.

export const pixelDirectory = "C:/DeepAgent Code/PixelProject"
export const pixelProjectID = "proj_pixel_matrix"
export const pixelProject = {
  id: pixelProjectID,
  worktree: pixelDirectory,
  vcs: "git",
  name: "Pixel Matrix",
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
  directory: pixelDirectory,
}

const model = { providerID: "deepagent-code", modelID: "claude-opus-4-6", variant: "max" }

const pixelProvider = {
  all: [
    {
      id: "deepagent-code",
      name: "DeepAgent Code",
      models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
    },
  ],
  connected: ["deepagent-code"],
  default: { providerID: "deepagent-code", modelID: "claude-opus-4-6" },
}

export const cnID = "ses_pixel_cn"
export const enID = "ses_pixel_en"
export const errorID = "ses_pixel_error"
export const recoveryID = "ses_pixel_recovery"

type MessageInfo = Record<string, unknown> & { id: string; role: "user" | "assistant" }
type MessagePart = Record<string, unknown> & { id: string; type: string; text?: string; tool?: string }
type Message = { info: MessageInfo; parts: MessagePart[] }

function userMessage(sessionID: string, id: string, text: string): Message {
  const messageID = `msg_${id}`
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1700000000000 },
      summary: { diffs: [] },
      agent: "build",
      model,
    },
    parts: [{ id: `prt_${id}_user`, sessionID, messageID, type: "text", text }],
  }
}

function assistantMessage(sessionID: string, id: string, parentID: string, parts: MessagePart[]): Message {
  const messageID = `msg_${id}`
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 1700000000000 + 1_000, completed: 1700000000000 + 8_000 },
      parentID,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: pixelDirectory, root: pixelDirectory },
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: "max",
      finish: "stop",
    },
    parts,
  }
}

function textPart(sessionID: string, messageID: string, id: string, text: string): MessagePart {
  return { id, sessionID, messageID, type: "text", text }
}

function toolPart(
  sessionID: string,
  messageID: string,
  id: string,
  tool: string,
  input: Record<string, unknown>,
  output: string,
  state: { status: "completed" | "error" } = { status: "completed" },
): MessagePart {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: {
      status: state.status,
      input,
      output,
      title: tool === "bash" ? "Verify generated output" : String(input.filePath ?? input.command ?? "completed"),
      time: { start: 1700000000000 + 2_000, end: 1700000000000 + 4_000 },
    },
  }
}

const cnMessages: Message[] = [
  userMessage(
    cnID,
    "cn_user",
    "请分析跨代码库依赖关系，并设计重构方案。要求：保留现有接口兼容性，拆分公共模块，并给出迁移步骤与风险清单。",
  ),
  assistantMessage(cnID, "cn_assistant", "msg_cn_user", [
    textPart(cnID, "msg_cn_assistant", "prt_cn_reasoning", "分析依赖图并评估拆分方案…"),
    toolPart(cnID, "msg_cn_assistant", "prt_cn_grep", "grep", { path: pixelDirectory, pattern: "import.*sample", include: "*.ts" }, "src/sample/core.ts\nimport { deps } from \"../common/deps\"\n…"),
    textPart(
      cnID,
      "msg_cn_assistant",
      "prt_cn_text",
      "方案：将公共依赖抽取到 `src/common/deps`，保持 `sample` 包对外接口不变；迁移分三步：\n1. 新增公共模块并建立 re-export 兼容层；\n2. 逐包切换 import 路径（每步独立可回滚）；\n3. 删除旧实现并运行全量回归。\n\n风险：跨仓库版本对齐、CI 缓存失效、发布窗口内并发变更。",
    ),
  ]),
]

const enMessages: Message[] = [
  userMessage(enID, "en_user", "Refactor the dependency graph across 3 repositories and keep the public API stable."),
  assistantMessage(enID, "en_assistant", "msg_en_user", [
    textPart(enID, "msg_en_assistant", "prt_en_text", "Plan: extract the shared kernel, re-export a compatibility layer, migrate one repository per release, and run the full regression after each step."),
    toolPart(enID, "msg_en_assistant", "prt_en_bash", "bash", { command: "bun typecheck", description: "Verify generated output" }, "✓ checked 214 files 0 errors"),
  ]),
]

const longError = `${"x".repeat(6000)}${"a".repeat(4000)}`
const errorMessages: Message[] = [
  userMessage(errorID, "err_user", "The workspace load in session r7 keeps failing — investigate the error and give me the stable code."),
  assistantMessage(errorID, "err_assistant", "msg_err_user", [
    textPart(errorID, "msg_err_assistant", "prt_err_text", `Failed to load workspace snapshot.\n${longError}\nSTABLE_CODE_7F3A9C — the workspace is read-only after a fork; re-open the session via the recovery dock.`),
    toolPart(
      errorID,
      "msg_err_assistant",
      "prt_err_tool",
      "bash",
      { command: "bun run test", description: "Run verification" },
      "ecosystem:x:126: workspace snapshot load failed: 0x7F3A9C (snapshot registry mismatch)\n" + `${"y".repeat(3000)}`,
      { status: "error" },
    ),
  ]),
]

export function pixelPageMessages(sessionID: string, limit: number, before?: string): { items: unknown[]; cursor?: string } {
  const all = sessionID === cnID ? cnMessages : sessionID === enID ? enMessages : sessionID === errorID ? errorMessages : []
  const end = before ? Math.max(0, all.findIndex((message) => message.info.id === before)) : all.length
  const start = Math.max(0, end - limit)
  return { items: all.slice(start, end) as unknown[], cursor: start > 0 ? (all[start] as Message).info.id : undefined }
}

const descriptorBase = {
  schemaVersion: "recovery-descriptor.v1" as const,
  provenance: { origin: "recorded" as const, sourceRefs: [] as string[] },
  baseline: { baselineHash: "b1", sourceSnapshotRef: "snap-1", verified: true },
  terminalBridge: { bridgeId: "b", bridgeType: "type", terminalRef: "t" },
  casTokens: { expectedState: "s", expectedVersion: 0, ownerToken: "ot" },
}

const exact = (index: number) => ({
  ...descriptorBase,
  id: `descriptor-exact-${index}`,
  requestHash: `req-exact-${index}`,
  descriptorKind: "resolvable_exact" as const,
  exact: { attemptHash: "a", selectionHash: "s", historyHash: "h", baselineHash: "b", allVerified: true },
})

const coordination = (index: number) => ({
  ...descriptorBase,
  id: `descriptor-coord-${index}`,
  requestHash: `req-coord-${index}`,
  descriptorKind: "coordination_required" as const,
  coordination: { reason: "network_unknown" as const, requiredActor: "admin" as const, evidenceExportRef: `export-${index}` },
})

/** Five pending recovery descriptors for the dock pixel state. */
export const pixelRecoveryDescriptors = [exact(0), exact(1), exact(2), coordination(3), coordination(4)]

export const pixelSessions = [
  { id: cnID, slug: "cn", projectID: pixelProjectID, directory: pixelDirectory, title: "中文长标题：跨代码库检索重构方案与依赖分析", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
  { id: enID, slug: "en", projectID: pixelProjectID, directory: pixelDirectory, title: "Refactor dependency graph across 3 repositories", version: "dev", time: { created: 1700000001000, updated: 1700000001000 } },
  { id: errorID, slug: "error", projectID: pixelProjectID, directory: pixelDirectory, title: "Long error handler", version: "dev", time: { created: 1700000002000, updated: 1700000002000 } },
  { id: recoveryID, slug: "recovery", projectID: pixelProjectID, directory: pixelDirectory, title: "Recovery dock pixel state", version: "dev", time: { created: 1700000003000, updated: 1700000003000 } },
]

export const pixelMockConfig: MockServerConfig = {
  provider: pixelProvider,
  directory: pixelDirectory,
  project: pixelProject,
  sessions: pixelSessions,
  pageMessages: pixelPageMessages,
}
