import type { IMGroup } from "@/components/im/types"

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
