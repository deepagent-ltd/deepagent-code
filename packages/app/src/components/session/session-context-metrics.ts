import type { AssistantMessage, Message, Part, Session, UserMessage } from "@deepagent-code/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
    input?: number
  }
}

type Context = {
  message: AssistantMessage
  source: "provider" | "compaction"
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

const compactedContext = (messages: Message[], parts: Record<string, Part[] | undefined>) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant") continue
    if (!message.summary) {
      if (tokenTotal(message) > 0) return
      continue
    }
    if (!message.finish || message.error) continue
    const marker = parts[message.parentID]?.find((part) => part.type === "compaction")
    if (marker?.type !== "compaction" || marker.context_tokens === undefined) continue
    const parent = messages.find((item): item is UserMessage => item.id === message.parentID && item.role === "user")
    return {
      message,
      parent,
      total: marker.context_tokens,
    }
  }
}

const build = (
  messages: Message[] = [],
  providers: Provider[] = [],
  parts: Record<string, Part[] | undefined> = {},
): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const compacted = compactedContext(messages, parts)
  if (compacted) {
    const providerID = compacted.parent?.model.providerID ?? compacted.message.providerID
    const modelID = compacted.parent?.model.modelID ?? compacted.message.modelID
    const provider = providers.find((item) => item.id === providerID)
    const model = provider?.models[modelID]
    const limit = model?.limit.input ?? model?.limit.context
    return {
      totalCost,
      context: {
        message: compacted.message,
        source: "compaction",
        provider,
        model,
        providerLabel: provider?.name ?? providerID,
        modelLabel: model?.name ?? modelID,
        limit,
        input: compacted.total,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: compacted.total,
        usage: limit ? Math.round((compacted.total / limit) * 100) : null,
      },
    }
  }
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.input ?? model?.limit.context
  const total = tokenTotal(message)

  return {
    totalCost,
    context: {
      message,
      source: "provider",
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

export function getSessionContextMetrics(
  messages: Message[] = [],
  providers: Provider[] = [],
  parts: Record<string, Part[] | undefined> = {},
) {
  return build(messages, providers, parts)
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

// Per-category token breakdown. `spend` is the tokens NEWLY consumed this turn (non-cached input +
// output + reasoning); `cacheRead`/`cacheWrite` are the cached context re-read/written for the same
// request (billed at a fraction of full price). `total` is the sum of all five — the raw figure the
// provider reports. Surfacing the split stops a short prompt over a large cached context from looking
// like it "spent" 120K when almost all of that is a cache hit.
export type TokenBreakdown = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  spend: number
  total: number
}

export const emptyTokenBreakdown = (): TokenBreakdown => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  spend: 0,
  total: 0,
})

export function addTokenBreakdown(
  acc: TokenBreakdown,
  t: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
): TokenBreakdown {
  acc.input += t.input
  acc.output += t.output
  acc.reasoning += t.reasoning
  acc.cacheRead += t.cache.read
  acc.cacheWrite += t.cache.write
  acc.spend += t.input + t.output + t.reasoning
  acc.total += t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  return acc
}

// Breakdown of a single subagent (child) session's persisted running total, mirroring
// {@link getSubagentTokens} but split by category so it can roll into a parent turn's tooltip.
export function getSubagentTokenBreakdown(acc: TokenBreakdown, session: Session | undefined): TokenBreakdown {
  if (!session?.tokens) return acc
  return addTokenBreakdown(acc, session.tokens)
}
