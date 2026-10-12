import type { IMGroup } from "@/components/im/types"
import { validateIMName, type IMNameInvalidReason } from "@deepagent-code/core/im/facade-contract"

// Pure create-group flow, extracted so it can be unit-tested without a DOM and
// without window.prompt (which throws in the Electron renderer — the original
// bug this replaces). Returns the created group on success, or an error string
// describing the failure. A blank name is a no-op (returns { skipped: true }).
export type CreateGroupResult =
  | { skipped: true }
  | { group: IMGroup }
  | { error: string }

export async function submitCreateGroup(
  rawName: string,
  createGroup: (payload: {
    name: string
    type: "project" | "system" | "direct"
    projectID?: string
    member?: { memberID: string; memberType: "user" | "agent" }
  }) => Promise<IMGroup>,
): Promise<CreateGroupResult> {
  const name = rawName.trim()
  if (!name) return { skipped: true }
  try {
    const group = await createGroup({ name, type: "project" })
    return { group }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// §B3 私聊 — create a "direct" 1:1 group with a counterparty (a user or an agent). The server user is
// always the first participant; `member` names the second. Returns the same result shape.
export async function submitCreateDirect(
  name: string,
  member: { memberID: string; memberType: "user" | "agent" },
  createGroup: (payload: {
    name: string
    type: "project" | "system" | "direct"
    projectID?: string
    member?: { memberID: string; memberType: "user" | "agent" }
  }) => Promise<IMGroup>,
): Promise<CreateGroupResult> {
  const trimmed = name.trim() || member.memberID
  if (!member.memberID.trim()) return { skipped: true }
  try {
    const group = await createGroup({ name: trimmed, type: "direct", member })
    return { group }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ── B2 门面操作的纯流程 ───────────────────────────────────────────────────────
// claim/rename/resolve/direct/invite 共用一个名字流：本地预校验（core 归一化/规则与门面一致，
// 门面仍是权威）→ 调用 → 错误逐码透出。UI 按 errorCode 取 i18n 文案（facade-errors.ts），
// invalidReason 在场 ⇒ 本地规则失败，用 im.facade.name.error.<reason> 的规则文案。
export type FacadeOpResult<T> =
  | { skipped: true }
  | { value: T }
  | { errorCode: string; errorMessage: string; invalidReason?: IMNameInvalidReason }

// IMFacadeRequestError 之外的错误（fetch 网络错等）归入 transport_error——对 UI 来说等价于门面不可达。
const toFacadeFailure = (error: unknown): { errorCode: string; errorMessage: string } => {
  const code = (error as { code?: unknown })?.code
  return {
    errorCode: typeof code === "string" ? code : "transport_error",
    errorMessage: error instanceof Error ? error.message : String(error),
  }
}

/** 名字类门面操作（claim/rename/resolve/direct/invite）：本地预校验通过后把归一化名字发给 op。 */
export async function submitFacadeName<T>(raw: string, op: (name: string) => Promise<T>): Promise<FacadeOpResult<T>> {
  const validated = validateIMName(raw)
  if (!validated.ok) {
    if (validated.reason === "empty") return { skipped: true }
    return { errorCode: "im_invalid_name", errorMessage: validated.reason, invalidReason: validated.reason }
  }
  try {
    return { value: await op(validated.name) }
  } catch (error) {
    return toFacadeFailure(error)
  }
}

/** rebind 的输入是 key 不是名字：只查空，不走命名规则。 */
export async function submitFacadeRebind<T>(rawKey: string, op: (key: string) => Promise<T>): Promise<FacadeOpResult<T>> {
  const key = rawKey.trim()
  if (!key) return { skipped: true }
  try {
    return { value: await op(key) }
  } catch (error) {
    return toFacadeFailure(error)
  }
}

/** 内核建群：群名走名字流；成员名清单原样透传（成员解析失败由门面整体拒绝 im_member_not_found）。 */
export async function submitFacadeGroupCreate(
  rawName: string,
  memberNames: readonly string[],
  createGroup: (name: string, memberNames: string[]) => Promise<IMGroup>,
): Promise<FacadeOpResult<IMGroup>> {
  return submitFacadeName(rawName, (name) => createGroup(name, [...memberNames]))
}
