import { Cause, Effect, Exit, Schema, Scope } from "effect"

export class Error extends Schema.TaggedErrorClass<Error>()("ListenerStop.Error", {
  reason: Schema.Literals(["failed", "interrupted", "timeout"]),
  stage: Schema.Literals(["mdns", "websockets", "force", "http", "scope"]),
}) {
  readonly code = "LISTENER_STOP_FAILED"

  override get message() {
    return `Listener shutdown ${this.stage}: ${this.reason}`
  }
}

export function make(input: {
  scope: Scope.Scope
  http: { close: Effect.Effect<void>; closeAll: Effect.Effect<void> }
  websockets: { closeAll: Effect.Effect<void> }
  unpublish: Effect.Effect<void>
  scopeBudgetMs?: number
  onTimeout?: () => void
}) {
  const run = <A>(effect: Effect.Effect<A>, stage: Error["stage"]) =>
    Effect.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value
      throw new Error({ reason: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed", stage })
    })
  let unpublish: Promise<void> | undefined
  let websockets: Promise<void> | undefined
  let force: Promise<void> | undefined
  let http: Promise<void> | undefined
  let scope: Promise<void> | undefined
  let forceRequested = false

  return (close?: boolean) => {
    if (close) forceRequested = true
    unpublish ??= run(input.unpublish, "mdns")
    websockets ??= unpublish.then(() => run(input.websockets.closeAll, "websockets"))
    if (close) force ??= websockets.then(() => run(input.http.closeAll, "force"))
    http ??= websockets.then(() => {
      if (!forceRequested) return run(input.http.close, "http")
      force ??= run(input.http.closeAll, "force")
      return force.then(() => run(input.http.close, "http"))
    })
    scope ??= http.then(() => {
      // Scope finalizers are uninterruptible. Bound the observer, retain the original close,
      // and never turn a late completion into a successful retry after a timeout.
      const completed = run(Scope.close(input.scope, Exit.void), "scope")
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve()
            .then(() => input.onTimeout?.())
            .catch(() => undefined)
          reject(new Error({ reason: "timeout", stage: "scope" }))
        }, input.scopeBudgetMs ?? 2_000)
      })
      return Promise.race([completed, deadline]).finally(() => clearTimeout(timer))
    })
    return close ? Promise.all([scope, force]).then(() => undefined) : scope
  }
}

export * as ListenerStop from "./listener-stop"
