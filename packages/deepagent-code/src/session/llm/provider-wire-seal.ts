import { AsyncLocalStorage } from "node:async_hooks"
import type { RequestExecutor } from "@deepagent-code/llm/route"

const storage = new AsyncLocalStorage<RequestExecutor.RequestSeal["seal"]>()

export function run<A>(seal: RequestExecutor.RequestSeal["seal"], body: () => A) {
  return storage.run(seal, body)
}

export function current() {
  return storage.getStore()
}

export * as ProviderWireSeal from "./provider-wire-seal"
