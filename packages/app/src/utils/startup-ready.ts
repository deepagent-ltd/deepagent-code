export function startupViewReady(input: {
  pathname: string
  serverReady: boolean
  globalReady: boolean
  globalError: boolean
  restoreSettled: boolean
  directory?: string
  directoryReady: boolean
  sessionId?: string
  hasSession: boolean
  messagesReady: boolean
}) {
  if (input.globalError) return true
  if (!input.serverReady || !input.globalReady || !input.restoreSettled) return false
  if (input.pathname === "/") return true
  if (!input.directory) return true
  if (!input.directoryReady) return false
  if (!input.sessionId) return true
  return input.hasSession && input.messagesReady
}
