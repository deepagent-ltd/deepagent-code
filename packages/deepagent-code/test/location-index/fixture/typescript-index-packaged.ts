import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { TypeScriptIndex } from "../../../src/location-index/typescript-index"

const input = JSON.parse(await readFile(process.argv[2]!, "utf8"))
process.stdout.write(JSON.stringify(await Effect.runPromise(TypeScriptIndex.build(input))))
