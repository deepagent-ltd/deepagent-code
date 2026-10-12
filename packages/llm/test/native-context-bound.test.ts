import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LLM } from "../src"
import { deepseek } from "../src/providers/openai-compatible"
import { Auth } from "../src/route/auth"
import { LLMClient } from "../src/route/client"
import { RequestExecutor } from "../src/route/executor"
import { VendorContextBound } from "../src/route/vendor-context-bound"
import { testEffect } from "./lib/effect"

const it = testEffect(LLMClient.nativeManagedLayer.pipe(
  Layer.provide(RequestExecutor.defaultLayer),
  Layer.provide(Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next }))),
))

for (const mode of ["original", "repeat", "copy", "alias", "endpoint", "retry", "redirect", "unknown-input", "expired"] as const) {
  it.live(`native local context bound ${mode} never sends a provider or count request`, () => Effect.gen(function* () {
    const client = yield* LLMClient.Service
    const request = LLM.request({
      model: deepseek.configure({ baseURL: mode === "endpoint" ? "https://api.deepseek.com/v1" : "https://api.deepseek.com",
        auth: Auth.value("unused-private-module-key").bearer() }).responses(mode === "alias" ? "deepseek-v4-pro" : "deepseek-flash"),
      system: "Approved local bound instructions",
      prompt: "中文不按照字符长度猜测token数",
      generation: { maxTokens: 32 },
      providerOptions: { openai: { store: false } },
      ...(mode === "unknown-input" ? { http: { body: { previous_response_id: "unobserved" } } } : {}),
    })
    yield* LLMClient.bindNativeRequest(client, request)
    const observed: { count?: number; hash?: string; repeat?: boolean; sealCalls: number } = { sealCalls: 0 }
    const stop = Object.freeze({ noNetwork: true })
    const outcome = yield* client.generate(request).pipe(
      Effect.provideService(RequestExecutor.CurrentRetryLimit, mode === "retry" ? 1 : 0),
      Effect.provideService(RequestExecutor.CurrentRedirectPolicy, mode === "redirect" ? "follow" : "manual"),
      Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: (wire) => Effect.gen(function* () {
        observed.sealCalls++
        const counted = yield* LLMClient.boundNativeDeepSeekInput(client, request,
          mode === "copy" ? { ...wire } : wire, Date.now() + (mode === "expired" ? -1 : 5_000))
        observed.count = counted.inputTokens
        observed.hash = counted.responseHash
        if (mode === "repeat") observed.repeat = Exit.isFailure(yield* LLMClient.boundNativeDeepSeekInput(
          client, request, wire, Date.now() + 5_000).pipe(Effect.exit))
        // The original native executor is stopped at its final seal, before its HTTP call.
        // No external provider, token-count service, fake transport, or server is installed.
        return yield* Effect.die(stop)
      }).pipe(Effect.orDie) }),
      Effect.exit,
    )
    expect(Exit.isFailure(outcome)).toBe(true)
    expect(observed.sealCalls).toBe(mode === "retry" || mode === "redirect" ? 0 : 1)
    if (mode === "original" || mode === "repeat") {
      expect(observed.count).toBe(VendorContextBound.DEEPSEEK_FLASH.inputUpperBound)
      expect(observed.hash).toMatch(/^[0-9a-f]{64}$/)
      if (mode === "repeat") expect(observed.repeat).toBe(true)
      return
    }
    expect(observed.count).toBeUndefined()
  }))
}
