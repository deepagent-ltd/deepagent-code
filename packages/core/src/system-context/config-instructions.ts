export * as ConfigInstructions from "./config-instructions"

import path from "path"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { SystemContext } from "./index"
import { SystemContextRegistry } from "./registry"

class File extends Schema.Class<File>("ConfigInstructions.File")({
  path: Schema.String,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)

// Registry keys sort lexically: core/instructions (AGENTS.md), then these configured
// instructions, then deepagent/project-docs. Later sources appear later in the prompt.
export const registryKey = SystemContext.Key.make("deepagent/instructions")

export const render = (files: ReadonlyArray<File>) =>
  files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")

export function source(
  load: Effect.Effect<ReadonlyArray<File> | SystemContext.Unavailable>,
): SystemContext.SystemContext {
  return SystemContext.make({
    key: registryKey,
    codec: Schema.toCodecJson(Files),
    load,
    baseline: render,
    update: (_previous, current) =>
      `These configured instructions replace all previously loaded configured instructions.\n\n${render(current)}`,
    removed: () => "Previously loaded configured instructions no longer apply.",
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const registry = yield* SystemContextRegistry.Service

    const observe = Effect.fn("ConfigInstructions.observe")(function* () {
      // Config documents are ordered from global to local. Preserve that order and suppress
      // duplicates, as the legacy config merger does for its instructions array.
      const configured = [
        ...new Set(
          (yield* config.entries())
            .filter((entry): entry is Config.Document => entry.type === "document")
            .flatMap((entry) => entry.info.instructions ?? []),
        ),
      ]
      if (configured.length === 0) return []
      const relativeDirectory = path.relative(location.project.directory, location.directory)
      const stop =
        relativeDirectory === "" ||
        (relativeDirectory !== ".." &&
          !relativeDirectory.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeDirectory))
          ? location.project.directory
          : location.directory

      const files = yield* Effect.forEach(
        configured,
        (item) => {
          if (/^https?:\/\//.test(item))
            return HttpClientRequest.get(item).pipe(
              http.execute,
              Effect.flatMap((response) => response.text),
              Effect.timeout("5 seconds"),
              Effect.map((content) => [new File({ path: item, content })]),
            )

          const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
          const matches = path.isAbsolute(expanded)
            ? fs.glob(path.basename(expanded), { cwd: path.dirname(expanded), absolute: true, include: "file" })
            : fs.globUp(expanded, location.directory, stop)
          return matches.pipe(
            Effect.flatMap((paths) =>
              Effect.forEach(
                [...new Set(paths)],
                (file) =>
                  fs
                    .readFileStringSafe(file)
                    .pipe(
                      Effect.flatMap((content) =>
                        content === undefined
                          ? Effect.fail(new Error(`Configured instruction disappeared: ${file}`))
                          : Effect.succeed(new File({ path: file, content })),
                      ),
                    ),
                { concurrency: 8 },
              ),
            ),
          )
        },
        { concurrency: 4 },
      )
      return [...new Map(files.flat().map((file) => [file.path, file])).values()]
    })

    yield* registry.register({
      key: registryKey,
      load: observe().pipe(
        Effect.map((files) => (files.length === 0 ? SystemContext.empty : source(Effect.succeed(files)))),
        // A failed URL (including non-2xx and timeout) is unavailable, so a prior
        // snapshot survives reconciliation instead of silently losing instructions.
        Effect.catch(() => Effect.succeed(source(Effect.succeed(SystemContext.unavailable)))),
        Effect.catchDefect(() => Effect.succeed(source(Effect.succeed(SystemContext.unavailable)))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "system-context-config-instructions",
  layer,
  deps: [Config.node, FSUtil.node, Global.node, Location.node, httpClient, SystemContextRegistry.node],
})
