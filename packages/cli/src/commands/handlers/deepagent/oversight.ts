import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { rawGet, rawPost } from "./util"

type ApprovalItem = {
  id: string
  eventType: string
  correlationID?: string
  summary: string
  status: string
  decision?: string
  resolvedBy?: string
  createdAt: number
}

type Metrics = {
  windowFrom: number
  windowTo: number
  agentPushTotal: number
  agentPushRejectedTotal: number
  agentTaskCompleted: number
  agentTaskFailed: number
  agentTaskBlockedTotal: number
  agentConflictRate: number | null
  agentTaskSuccessRate: number | null
  humanTakeoverTotal?: number
  rollbackTotal?: number
}

type TraceNode = {
  kind?: string
  eventID: string
  type: string
  source: string
  createdAt: number
  sessionID?: string
  title?: string
  messageCount?: number
}

export default Runtime.handler(Commands.commands.oversight, Effect.fn("cli.oversight")(function* (input) {
  if (input.action === "metrics") {
    const result = yield* rawGet<Metrics>("/oversight/metrics")
    const m = result.data
    if (!m) {
      console.log("No metrics available")
      return
    }
    console.log(`Window: ${new Date(m.windowFrom).toISOString()} → ${new Date(m.windowTo).toISOString()}`)
    console.log(`Agent pushes:     ${m.agentPushTotal}`)
    console.log(`  Rejected:       ${m.agentPushRejectedTotal}`)
    console.log(`Tasks completed:  ${m.agentTaskCompleted}`)
    console.log(`Tasks failed:     ${m.agentTaskFailed}`)
    console.log(`Tasks blocked:    ${m.agentTaskBlockedTotal}`)
    if (m.agentTaskSuccessRate !== null) console.log(`Success rate:     ${(m.agentTaskSuccessRate * 100).toFixed(1)}%`)
    if (m.agentConflictRate !== null) console.log(`Conflict rate:    ${(m.agentConflictRate * 100).toFixed(1)}%`)
    if (m.humanTakeoverTotal !== undefined) console.log(`Human takeovers:  ${m.humanTakeoverTotal}`)
    if (m.rollbackTotal !== undefined) console.log(`Rollbacks:        ${m.rollbackTotal}`)
    return
  }

  if (input.action === "queue") {
    const result = yield* rawGet<{ items: ApprovalItem[] }>("/oversight/approvals")
    const items = result.data?.items ?? []
    for (const item of items) {
      const age = Math.round((Date.now() - item.createdAt) / 1000)
      console.log(`${item.id} [${item.status}] ${item.eventType}`)
      console.log(`  ${item.summary} (${age}s ago)`)
      if (item.correlationID) console.log(`  correlation: ${item.correlationID}`)
    }
    if (items.length === 0) console.log("No pending approvals")
    return
  }

  if (input.action === "trace") {
    const correlationID = Option.getOrElse(input.id, () => "")
    if (!correlationID) yield* Effect.fail(new Error("correlationID is required: oversight trace <correlationID>"))
    const result = yield* rawGet<{ nodes: TraceNode[] }>(`/oversight/trace?correlationID=${encodeURIComponent(correlationID)}`)
    const nodes = result.data?.nodes ?? []
    for (const n of nodes) {
      const ts = new Date(n.createdAt).toISOString()
      const tag = n.kind === "session" ? ` → session ${n.sessionID}` : ""
      console.log(`[${ts}] ${n.type} from ${n.source}${tag}`)
      if (n.title) console.log(`  ${n.title}`)
    }
    if (nodes.length === 0) console.log("No trace found")
    return
  }

  // approve / reject / ack
  const id = Option.getOrElse(input.id, () => "")
  if (!id) yield* Effect.fail(new Error(`Approval ID is required: oversight ${input.action} <id>`))
  const decision = input.action === "ack" ? "acknowledged" : input.action
  const result = yield* rawPost<ApprovalItem>("/oversight/approvals/resolve", { id, decision })
  const item = result.data
  if (item) console.log(`Approval ${item.id}: ${item.decision} by ${item.resolvedBy ?? "unknown"}`)
  else console.log(`Resolved: ${id}`)
}))
