import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.DEEPAGENT_CODE_CHANNEL ?? "dev"}`

await $`cd ../deepagent-code && bun script/build-node.ts`
