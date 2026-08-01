import { Effect } from "effect"
import { PRQueue } from "@/agent/pr-queue"

type Input =
  | { readonly action: "create"; readonly id: string }
  | { readonly action: "list" }

const input = JSON.parse(Bun.argv[2] ?? "{}") as Input
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const queue = yield* PRQueue.Service
    if (input.action === "list") return yield* queue.list()
    return yield* queue.create({
          id: input.id,
          parentID: "parent-process",
          workerID: `worker-${input.id}`,
          reviewerID: "reviewer-process",
          sha: `sha-${input.id}`,
        })
  }).pipe(Effect.provide(PRQueue.layer)),
)

console.log(JSON.stringify(result))
