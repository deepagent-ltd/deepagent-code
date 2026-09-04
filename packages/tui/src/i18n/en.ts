// W2-7 — TUI locale dictionaries. Keys are namespaced "tui.<area>.<name>"; en is the source of
// truth for the key union, other locales mirror it with `Keys` enforcing coverage at typecheck.
export const dict = {
  "tui.reviews.title": "Run reviews",
  "tui.reviews.empty": "No run reviews yet",
  "tui.reviews.readonly": "Read-only list — promote/reject opens in the full review flow",
  "tui.reviews.statusUnknown": "status unknown",
  "tui.reviews.next": "next",
  "tui.reviews.candidates": "candidates",
  "tui.wiki.title": "Wiki (read-only)",
  "tui.wiki.editableGuiOnly": "editable (GUI only)",
  "tui.wiki.emptyPage": "(empty page)",
  "tui.archive.title": "Archived sessions",
  "tui.archive.restore": "restore",
  "tui.archive.delete": "delete",
  "tui.archive.restored": "Session restored",
  "tui.archive.deleted": "Session deleted",
  "tui.archive.restoreFailed": "Failed to restore session",
  "tui.archive.deleteFailed": "Failed to delete session",
  "tui.archive.confirmDelete": "Press delete again to confirm",
  "tui.archive.empty": "No archived sessions",
  "tui.queue.title": "Queued inputs",
  "tui.queue.empty": "No queued inputs — explicit queue-mode inputs open the next activity when this one settles",
  "tui.queue.promotesInOrder": "promotes in admit order",
  "tui.suggest.none": "No next-step suggestion available yet",
  "tui.suggest.label": "Next-step suggestion",
  "tui.archive.archived": "Session archived",
  "tui.archive.archiveFailed": "Failed to archive session",
}

export type TuiI18nKey = keyof typeof dict
