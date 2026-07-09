import type { AssistantMessage, Message, Session } from "@deepagent-code/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usage: number | null
}

type Metrics = {
  totalCost: number
  context: Context | undefined
}

// Real retained-context occupancy: the tokens the model's window actually holds going into the next
// turn = non-cached input + cache read + cache write. Output and reasoning are GENERATED, not retained
// (reasoning is explicitly never carried forward), so they must not count toward context usage. This
// mirrors the backend overflow/compaction budget in overflow.ts.
const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    totalCost,
    context: {
      message,
      provider,
      model,
      providerLabel: provider?.name ?? message.providerID,
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}

// All tokens a session's persisted running total accounts for (input + output + reasoning + cache).
// This is the CONSUMED total, distinct from retained-context occupancy (tokenTotal above).
const sessionTokensUsed = (session: Session): number => {
  const t = session.tokens
  if (!t) return 0
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

// Cumulative token usage for the whole conversation: the root session's persisted total plus every
// descendant subagent (child) session's total. Walks the parent-child tree (subagents can nest), so a
// multi-agent run reports the true aggregate. Deduped by id via the visited set. This is the number
// the top-right "conversation total tokens" surfaces — NOT the retained-context gauge.
export function getConversationTokens(sessions: Session[] = [], rootSessionID?: string): number {
  if (!rootSessionID) return 0
  const childrenByParent = new Map<string, Session[]>()
  const byId = new Map<string, Session>()
  for (const s of sessions) {
    byId.set(s.id, s)
    if (!s.parentID) continue
    const list = childrenByParent.get(s.parentID)
    if (list) list.push(s)
    else childrenByParent.set(s.parentID, [s])
  }

  let total = 0
  const visited = new Set<string>()
  const stack = [rootSessionID]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const session = byId.get(id)
    if (session) total += sessionTokensUsed(session)
    for (const child of childrenByParent.get(id) ?? []) stack.push(child.id)
  }
  return total
}

// Tokens USED by a single subagent (child) session, from its persisted running total. Used to show a
// per-box figure on the right of the task tool-call and to roll subagent usage into the parent turn.
export function getSubagentTokens(session: Session | undefined): number {
  return session ? sessionTokensUsed(session) : 0
}
