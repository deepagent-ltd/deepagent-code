import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"

// V1's per-message doom-loop guard uses three identical calls. Keep the same threshold for a
// single repeated invocation while the V2 activity owns one budget across provider turns.
export const REPEATED_TOOL_LIMIT = 3

export type RepeatedTool = {
  readonly tool: string
  readonly inputHash: string
  readonly count: number
}

export class LoopBudget {
  readonly limit: number
  private activityID: string | undefined
  private previous: { readonly tool: string; readonly inputHash: string } | undefined
  private repeats = 0
  private triggered: RepeatedTool | undefined
  private deniedToolAtStep = false

  constructor(limit: number) {
    this.limit = limit
  }

  forActivity(activityID: string): void {
    if (this.activityID === activityID) return
    this.activityID = activityID
    this.previous = undefined
    this.repeats = 0
    this.triggered = undefined
    this.deniedToolAtStep = false
  }

  stepLimitReached(step: number): boolean {
    return step >= this.limit
  }

  denyToolAtStep(): void {
    this.deniedToolAtStep = true
  }

  toolDeniedAtStep(): boolean {
    return this.deniedToolAtStep
  }

  observeTool(tool: string, input: unknown): RepeatedTool | undefined {
    if (this.triggered) return this.triggered
    const inputHash = Hash.sha256(CanonicalJson.stringify(input ?? null))
    this.repeats = this.previous?.tool === tool && this.previous.inputHash === inputHash ? this.repeats + 1 : 1
    this.previous = { tool, inputHash }
    if (this.repeats < REPEATED_TOOL_LIMIT) return undefined
    this.triggered = { tool, inputHash, count: this.repeats }
    return this.triggered
  }

  repeatedTool(): RepeatedTool | undefined {
    return this.triggered
  }
}
