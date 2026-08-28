import type { SnapshotFileDiff, VcsFileDiff } from "@deepagent-code/sdk/v2"
import type { Message } from "@deepagent-code/sdk/v2/client"

type Diff = SnapshotFileDiff | VcsFileDiff

export const DIFF_PROJECTION_LIMITS = {
  files: 200,
  patchCharsPerFile: 256 * 1024,
  patchCharsTotal: 1024 * 1024,
} as const

function diff(value: unknown): value is Diff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if ("patch" in value && value.patch !== undefined && typeof value.patch !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function diffs(value: unknown): Diff[] {
  const items = Array.isArray(value)
    ? value.filter(diff)
    : diff(value)
      ? [value]
      : object(value)
        ? Object.values(value).filter(diff)
        : []
  let patchChars = 0
  return items.slice(0, DIFF_PROJECTION_LIMITS.files).map((item) => {
    const patch = item.patch ?? ""
    if (
      patch.length > DIFF_PROJECTION_LIMITS.patchCharsPerFile ||
      patchChars + patch.length > DIFF_PROJECTION_LIMITS.patchCharsTotal
    ) {
      return { ...item, patch: "" }
    }
    patchChars += patch.length
    return { ...item, patch }
  })
}

export function message(value: Message): Message {
  if (value.role !== "user") return value

  const raw = value.summary as unknown
  if (raw === undefined) return value
  if (!object(raw)) return { ...value, summary: undefined }

  const title = typeof raw.title === "string" ? raw.title : undefined
  const body = typeof raw.body === "string" ? raw.body : undefined
  const next = diffs(raw.diffs)

  if (title === raw.title && body === raw.body && next === raw.diffs) return value

  return {
    ...value,
    summary: {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      diffs: next,
    },
  }
}
