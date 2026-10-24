export * as PromptPrepare from "./prompt-prepare"

/** Preparation is one bounded auxiliary call, never a reason to renew its budget
 * on progress or silently dispatch the user's task a second time. */
export const TIMEOUT_MS = 90_000
export const FINALIZE_MS = 2_000
export class Timeout extends Error {
  readonly code = "PROMPT_PREPARE_TIMEOUT"
  constructor() {
    super("Prompt preparation timed out. Your draft was preserved; retry explicitly.")
    this.name = "PromptPrepareTimeout"
  }
}
