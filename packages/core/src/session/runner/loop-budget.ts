import { Hash } from "../../util/hash"

// V1's per-message doom-loop guard uses three identical calls. Keep the same threshold for a
// single repeated invocation while the V2 activity owns one budget across provider turns.
export const REPEATED_TOOL_LIMIT = 3

export type RepeatedTool = {
  readonly tool: string
  readonly inputHash: string
  readonly count: number
}

// V1's canonical tool-input encoding is retained here: undefined object values are encoded as
// null, unlike the general CanonicalJson utility. Provider wire input is JSON, but plugin tool
// resolvers can supply a normalized object with optional fields.
function canonicalToolInput(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalToolInput).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalToolInput((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

export function toolInputIdentity(tool: string, input: unknown) {
  const inputHash = Hash.sha256(canonicalToolInput(input))
  return { tool, inputHash, fingerprint: JSON.stringify([tool, inputHash]) }
}

/** The single period-1 decision used by both V1 paths and the V2 runner. */
export function repeatedIdenticalTool(calls: ReadonlyArray<{ readonly fingerprint: string; readonly done: boolean }>) {
  const recent = calls.slice(-REPEATED_TOOL_LIMIT)
  if (recent.length !== REPEATED_TOOL_LIMIT) return undefined
  if (recent.slice(0, -1).some((call) => !call.done)) return undefined
  return recent.every((call) => call.fingerprint === recent[0]?.fingerprint) ? recent[0]?.fingerprint : undefined
}

export class LoopBudget {
  readonly limit: number
  private activityID: string | undefined
  private readonly calls: Array<{ readonly callID: string; readonly fingerprint: string; done: boolean }> = []
  private triggered: RepeatedTool | undefined
  private deniedToolAtStep = false

  constructor(limit: number) {
    this.limit = limit
  }

  forActivity(activityID: string): void {
    if (this.activityID === activityID) return
    this.activityID = activityID
    this.calls.length = 0
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

  seedTool(callID: string, tool: string, input: unknown, done: boolean): void {
    this.calls.push({ callID, fingerprint: toolInputIdentity(tool, input).fingerprint, done })
    if (this.calls.length > REPEATED_TOOL_LIMIT) this.calls.shift()
  }

  markToolDone(callID: string): void {
    const call = this.calls.findLast((item) => item.callID === callID)
    if (call) call.done = true
  }

  observeTool(callID: string, tool: string, input: unknown): RepeatedTool | undefined {
    if (this.triggered) return this.triggered
    const identity = toolInputIdentity(tool, input)
    this.calls.push({ callID, fingerprint: identity.fingerprint, done: false })
    if (this.calls.length > REPEATED_TOOL_LIMIT) this.calls.shift()
    if (!repeatedIdenticalTool(this.calls)) return undefined
    this.triggered = { tool, inputHash: identity.inputHash, count: REPEATED_TOOL_LIMIT }
    return this.triggered
  }

  repeatedTool(): RepeatedTool | undefined {
    return this.triggered
  }
}
