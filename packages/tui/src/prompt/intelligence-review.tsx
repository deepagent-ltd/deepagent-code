import type { DialogContext } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"

/** Retire this review only: an unrelated replacement dialog keeps its owner. */
export async function reviewIntelligenceDraft(dialog: DialogContext, title: string, value: string) {
  const pending = DialogPrompt.show(dialog, title, { value })
  const owner = dialog.stack.at(-1)
  const edited = await pending
  if (owner && dialog.stack.at(-1) === owner) dialog.clear()
  return edited
}
