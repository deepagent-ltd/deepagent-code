import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { Database } from "@deepagent-code/core/database/database"
import { Api } from "../api"

export const HealthHandler = HttpApiBuilder.group(Api, "server.health", (handlers) =>
  handlers
    .handle("health.get", () => Effect.succeed({ healthy: true as const }))
    .handle("health.composition", () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const files = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list").pipe(Effect.orDie)
        const facets = {
          qualification: "unqualified" as const,
          sessionOwner: "core/default-session-runtime" as const,
          locationHost: {
            host: "core/default-location-host" as const,
            mcpBridge: false as const,
            pluginBridge: false as const,
          },
          database: { path: files.find((row) => row.name === "main")?.file || ":memory:" },
        }
        return {
          version: 1 as const,
          digest: ContractDigest.contentDigest({ schema: "deepagent-code-core-server-composition-v1", ...facets }),
          ...facets,
        }
      }),
    ),
)
