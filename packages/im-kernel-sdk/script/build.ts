import { $ } from "bun"
import path from "node:path"
import { normalizeProduct } from "./normalize-product"

const root = path.resolve(import.meta.dirname, "..")
const source = path.join(root, "upstream")
const manifest = await Bun.file(path.join(root, "build-manifest.json")).json()
const rollup = path.join(source, "node_modules/rollup/dist/bin/rollup")
if (!(await Bun.file(rollup).exists())) {
  throw new Error("Install the locked build tools: npm ci --ignore-scripts --prefix upstream")
}

await $`npm run build:pb`.cwd(source)
await $`node --require ${path.join(root, "script/build-year.cjs")} ${rollup} -c ./scripts/rollup.config.js --environment TAG:es_min`
  .cwd(source)
  .env({ ...process.env, PACKAGE_NAME: "JuggleIM" })

const products = await Promise.all(
  [
    { output: "lib/index.js", source: "dist/juggleim-es-min-1.9.17.js" },
    { output: "lib/index.d.ts", source: "src/index.d.ts" },
  ].map(async (entry) => {
    const bytes = normalizeProduct(await Bun.file(path.join(source, entry.source)).arrayBuffer(), entry.output)
    const expected = manifest.files.find((file: { path: string; sha256: string }) => file.path === entry.output)
    if (!expected || Bun.CryptoHasher.hash("sha256", bytes, "hex") !== expected.sha256) {
      throw new Error(`Reviewed SDK build differs: ${entry.output}`)
    }
    return { path: path.join(root, entry.output), bytes }
  }),
)
await Promise.all(products.map((entry) => Bun.write(entry.path, entry.bytes)))
