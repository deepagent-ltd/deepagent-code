export * as ApplicationTools from "./application-tools"

import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Location } from "../location"
import { Tool } from "./tool"

export interface Entry {
  readonly identity: object
  readonly tool: Tool.AnyTool
}

export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
    location?: Location.Ref,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
  readonly entries: (location?: Location.Ref) => ReadonlyMap<string, Entry>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ApplicationTools") {}

export const MAX_APPLICATION_TOOL_NAMES = 256
export const MAX_TOOL_OVERLAYS_PER_NAME = 32

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registered = new Map<string, Array<Entry & { readonly token: object; readonly location?: Location.Ref }>>()

    return Service.of({
      register: Effect.fn("ApplicationTools.register")(function* (tools, location) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => Tool.validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            const registrations = entries.map(
              ([name, tool]) =>
                [
                  name,
                  {
                    identity: {},
                    tool,
                    token,
                    ...(location
                      ? { location: { directory: location.directory, workspaceID: location.workspaceID } }
                      : {}),
                  },
                ] as const,
            )
            const newNames = entries.filter(([name]) => !registered.has(name)).length
            if (registered.size + newNames > MAX_APPLICATION_TOOL_NAMES)
              return yield* new Tool.RegistrationError({
                name: entries.find(([name]) => !registered.has(name))?.[0] ?? "registry",
                message: `Too many application tool names (limit ${MAX_APPLICATION_TOOL_NAMES})`,
              })
            const full = entries.find(([name]) => (registered.get(name)?.length ?? 0) >= MAX_TOOL_OVERLAYS_PER_NAME)
            if (full)
              return yield* new Tool.RegistrationError({
                name: full[0],
                message: `Too many registrations for tool ${full[0]} (limit ${MAX_TOOL_OVERLAYS_PER_NAME})`,
              })
            for (const [name, entry] of registrations) registered.set(name, [...(registered.get(name) ?? []), entry])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of registrations) {
                  const remaining = registered.get(name)?.filter((entry) => entry.token !== token) ?? []
                  if (remaining.length === 0) registered.delete(name)
                  else registered.set(name, remaining)
                }
              }),
            )
          }),
        )
      }),
      entries: (location) =>
        new Map(
          [...registered].flatMap(([name, entries]) => {
            const entry =
              entries.findLast(
                (entry) =>
                  entry.location &&
                  location &&
                  entry.location.directory === location.directory &&
                  entry.location.workspaceID === location.workspaceID,
              ) ?? entries.findLast((entry) => !entry.location)
            return entry ? [[name, entry] as const] : []
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
