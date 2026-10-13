import { Rpc } from "../../src/util/rpc"

await Bun.sleep(30)
if (process.env.DAC_RPC_READY_FIXTURE === "close") process.exit(0)
if (process.env.DAC_RPC_READY_FIXTURE === "error") throw new Error("Owned RPC startup failure")
if (!process.env.DAC_RPC_READY_FIXTURE) Rpc.listen({ echo: (input: { value: number }) => input })
