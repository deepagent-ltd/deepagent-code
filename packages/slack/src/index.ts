import { App } from "@slack/bolt"
import { createHash } from "node:crypto"
import { createDeepAgentCode, type SessionMessageAssistant } from "@deepagent-code/sdk"

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

console.log("Bot configuration:")
console.log("- Bot token present:", !!process.env.SLACK_BOT_TOKEN)
console.log("- Signing secret present:", !!process.env.SLACK_SIGNING_SECRET)
console.log("- App token present:", !!process.env.SLACK_APP_TOKEN)

console.log("Starting deepagent-code server...")
const shutdownController = new AbortController()
const deepagentCode = await createDeepAgentCode({ port: 0, signal: shutdownController.signal })
console.log("DeepAgent Core V2 server ready")

// One active queue per Slack thread serializes prompt/wait/message projection. Both the
// number of active threads and queued messages per thread are bounded; entries are removed
// by the owning handlers and never own durable Session identity.
const pendingThreads = new Map<string, { tail: Promise<void>; count: number }>()
const MAX_ACTIVE_THREADS = 128
const MAX_PENDING_PER_THREAD = 16

app.message(async ({ message }) => {
  if (message.subtype || !("text" in message) || !message.text) return

  const channel = message.channel
  const thread = "thread_ts" in message && message.thread_ts ? message.thread_ts : message.ts
  const key = JSON.stringify([channel, thread])
  const existing = pendingThreads.get(key)
  if ((!existing && pendingThreads.size >= MAX_ACTIVE_THREADS) || (existing?.count ?? 0) >= MAX_PENDING_PER_THREAD) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: thread,
      text: "DeepAgent is busy. Please retry after the current requests finish.",
    })
    return
  }
  const entry = existing ?? { tail: Promise.resolve(), count: 0 }
  entry.count++
  const current = entry.tail.catch(() => undefined).then(() => processMessage({ channel, thread, text: message.text! }))
  entry.tail = current
  pendingThreads.set(key, entry)
  await current
    .catch((error) =>
      app.client.chat.postMessage({
        channel,
        thread_ts: thread,
        text: `DeepAgent failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
    .finally(() => {
      entry.count--
      if (entry.count === 0 && pendingThreads.get(key) === entry) pendingThreads.delete(key)
    })
})

async function processMessage(input: { readonly channel: string; readonly thread: string; readonly text: string }) {
  const sessionID = `ses_${createHash("sha256")
    .update(JSON.stringify(["slack.thread", JSON.stringify([input.channel, input.thread])]))
    .digest("hex")}`
  const created = await deepagentCode.client.v2.session.create({ id: sessionID })
  if (created.error || !created.data) throw new Error(`Session create failed: ${JSON.stringify(created.error)}`)

  const admitted = await deepagentCode.client.v2.session.prompt({
    sessionID: created.data.data.id,
    prompt: { text: input.text },
    delivery: "queue",
  })
  if (admitted.error) throw new Error(`Prompt admission failed: ${JSON.stringify(admitted.error)}`)

  const waited = await deepagentCode.client.v2.session.wait({ sessionID: created.data.data.id })
  if (waited.error) throw new Error(`Session execution failed: ${JSON.stringify(waited.error)}`)

  const messages = await deepagentCode.client.v2.session.messages({
    sessionID: created.data.data.id,
    order: "desc",
    limit: 20,
  })
  if (messages.error || !messages.data) throw new Error(`Message projection failed: ${JSON.stringify(messages.error)}`)
  const response = messages.data.data.find(
    (message): message is SessionMessageAssistant => message.type === "assistant",
  )
  if (!response) throw new Error("Session settled without an assistant projection")

  await Promise.all(
    response.content.flatMap((part) =>
      part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")
        ? [
            app.client.chat.postMessage({
              channel: input.channel,
              thread_ts: input.thread,
              text: `*${part.name}* — ${part.state.status}`,
            }),
          ]
        : [],
    ),
  )
  const text = response.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
  await app.client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.thread,
    text: text || "DeepAgent completed without a text response.",
  })
}

app.command("/test", async ({ ack, say }) => {
  await ack()
  await say("DeepAgent Core V2 bot is running.")
})

let shutdown: Promise<void> | undefined
const stop = () => {
  if (shutdown) return shutdown
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  const task = app
    .stop()
    .then(() => Promise.allSettled([...pendingThreads.values()].map((entry) => entry.tail)))
    .then(() => undefined)
    .finally(() => {
      shutdownController.abort()
      deepagentCode.server.close()
    })
  shutdown = task
  return task
}
const onSignal = () => {
  void stop().catch((error) => console.error("Slack bot shutdown failed", error))
}
process.once("SIGINT", onSignal)
process.once("SIGTERM", onSignal)

await app.start().catch((error) => {
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  shutdownController.abort()
  deepagentCode.server.close()
  throw error
})
console.log("Slack bot is running")
