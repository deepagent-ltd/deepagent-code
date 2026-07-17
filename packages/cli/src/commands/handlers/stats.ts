import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { SessionClient } from "../../services/session-client"

export default Runtime.handler(Commands.commands.stats, (input) =>
  Effect.gen(function* () {
    const result = yield* SessionClient.list({})
    const sessions = result.data ?? []

    const MS_IN_DAY = 24 * 60 * 60 * 1000
    const cutoff = Option.match(input.days, {
      onNone: () => 0,
      onSome: (days) => (days === 0 ? new Date().setHours(0, 0, 0, 0) : Date.now() - days * MS_IN_DAY),
    })

    const filtered = cutoff > 0 ? sessions.filter((s) => s.time.updated >= cutoff) : sessions

    const stats = {
      totalSessions: filtered.length,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }

    for (const session of filtered) {
      stats.totalCost += session.cost ?? 0
      if (session.tokens) {
        stats.totalTokens.input += session.tokens.input ?? 0
        stats.totalTokens.output += session.tokens.output ?? 0
        stats.totalTokens.reasoning += session.tokens.reasoning ?? 0
        stats.totalTokens.cache.read += session.tokens.cache?.read ?? 0
        stats.totalTokens.cache.write += session.tokens.cache?.write ?? 0
      }
    }

    if (input.format === "json") {
      console.log(JSON.stringify(stats, null, 2))
      return
    }

    const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning
    console.log(`Sessions:  ${stats.totalSessions}`)
    console.log(`Cost:      $${stats.totalCost.toFixed(2)}`)
    console.log(`Tokens:`)
    console.log(`  Input:   ${formatNumber(stats.totalTokens.input)}`)
    console.log(`  Output:  ${formatNumber(stats.totalTokens.output)}`)
    console.log(`  Cache R: ${formatNumber(stats.totalTokens.cache.read)}`)
    console.log(`  Cache W: ${formatNumber(stats.totalTokens.cache.write)}`)
    console.log(`  Total:   ${formatNumber(totalTokens)}`)
  }),
)

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M"
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K"
  return num.toString()
}
