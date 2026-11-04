import { EventEmitter } from "node:events"
import { Deferred, Effect } from "effect"

export const browserOpenState = {
  shouldFail: false,
  calledWith: undefined as string | undefined,
  deferred: undefined as Deferred.Deferred<string> | undefined,
}

export async function openBrowser(url: string) {
  browserOpenState.calledWith = url
  if (browserOpenState.deferred)
    Effect.runSync(Deferred.succeed(browserOpenState.deferred, url).pipe(Effect.ignore))
  const subprocess = new EventEmitter()
  if (browserOpenState.shouldFail) {
    setTimeout(() => {
      subprocess.emit("error", new Error("spawn browser ENOENT"))
    }, 10)
  }
  return subprocess
}

export function resetBrowserOpen() {
  browserOpenState.shouldFail = false
  browserOpenState.calledWith = undefined
  browserOpenState.deferred = undefined
}

export default openBrowser
