export * as V2PluginToolsBridge from "./v2-plugin-tools-bridge"

import { Effect, Exit, Layer, Scope } from "effect"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { ToolRegistry } from "@/tool/registry"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import { adaptCustomTool, customToolName } from "@/tool/custom-tool-adapter"
import { CustomToolRejections } from "@/tool/custom-tool-rejections"

/**
 * Instance-owned registration of npm/filesystem plugin and config-glob tools. The V1 registry
 * remains the definition source; the canonical Core ApplicationTools registry owns execution.
 * Closing the instance scope removes only this batch, revealing any older active overlay.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const applications = yield* ApplicationTools.Service
    const instanceRegistry = yield* InstanceRegistry.Service

    instanceRegistry.registerInitializer((context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const custom = yield* registry.custom().pipe(Effect.provideService(InstanceRef, context))
          const adapted = custom.map((def) => ({
            id: def.id,
            name: customToolName(def.id),
            // V1 Tool.init wrappers still consult instance-scoped Agent/Truncate services at
            // execution time. The Core settle fiber has a Location, but no V1 InstanceRef.
            tool: adaptCustomTool({
              ...def,
              execute: (args, toolContext) =>
                def.execute(args, toolContext).pipe(Effect.provideService(InstanceRef, context)),
            }),
          }))
          const rejected = adapted.filter((item) => !item.name || !item.tool)
          yield* Effect.forEach(
            rejected,
            (item) => Effect.logWarning("V2 plugin tool name rejected", { directory: context.directory, id: item.id }),
            { discard: true },
          )
          const registered = Object.fromEntries(
            adapted.flatMap((item) => (item.name && item.tool ? [[item.name, item.tool] as const] : [])),
          )
          const scope = yield* Scope.make()
          yield* applications.register(registered).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
          )
          const forget = CustomToolRejections.track(applications, context, rejected.length)
          InstanceRegistry.registerInstanceStateDisposer(context, () =>
            Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ensuring(Effect.sync(forget)))),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("V2 plugin-tools bridge registration failed").pipe(
              Effect.annotateLogs({ directory: context.directory, cause }),
            ),
          ),
        ),
      ),
    )
  }),
)
