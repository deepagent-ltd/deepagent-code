let exiting = false

process.once("uncaughtException", failLiveScript)
process.once("unhandledRejection", failLiveScript)

export function finishLiveScript(): never {
  exiting = true
  process.exit(0)
}

export function failLiveScript(error: unknown): never {
  if (!exiting) console.error(error)
  exiting = true
  process.exit(1)
}
