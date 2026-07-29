export * as TestContextFacades from "./context-facades"

import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { Effect, Layer } from "effect"

export const layer = Layer.merge(
  Layer.succeed(CodeIntelFacade.Service, CodeIntelFacade.Service.of({ execute: () => Effect.die("unused") })),
  Layer.succeed(ContextQueryFacade.Service, ContextQueryFacade.Service.of({ execute: () => Effect.die("unused") })),
)
