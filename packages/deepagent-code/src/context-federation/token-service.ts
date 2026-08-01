export * as LiveContextTokenCodec from "./token-service"

import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Global } from "@deepagent-code/core/global"
import { Effect, Layer, Schema } from "effect"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"

const KeyFile = Schema.Struct({
  activeKeyId: Schema.String,
  keys: Schema.Array(Schema.Struct({
    id: Schema.String,
    secret: Schema.String,
    decryptUntil: Schema.Int.pipe(Schema.optional),
  })),
})
const decodeKeyFile = Schema.decodeUnknownSync(Schema.fromJsonString(KeyFile), { onExcessProperty: "error" })

export function layer(config: { readonly filename: string }) {
  return Layer.effect(
    ContextTokenCodec.Service,
    Effect.tryPromise(() => load(config.filename)).pipe(
      Effect.map((document) => ContextTokenCodec.Service.of(ContextTokenCodec.make({
        activeKeyId: document.activeKeyId,
        keys: document.keys.map((key) => ({
          id: key.id,
          secret: decodeSecret(key.secret),
          ...(key.decryptUntil === undefined ? {} : { decryptUntil: key.decryptUntil }),
        })),
      }))),
      Effect.orDie,
    ),
  )
}

export const defaultLayer = layer({ filename: path.join(Global.Path.state, "context-federation", "token-keyring.json") })

async function load(filename: string) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const generated = {
    activeKeyId: `key_${randomBytes(8).toString("hex")}`,
    keys: [{ id: "", secret: randomBytes(32).toString("base64url") }],
  }
  generated.keys[0]!.id = generated.activeKeyId
  const handle = await open(filename, "wx", 0o600).catch((error: unknown) => {
    if (record(error) && error.code === "EEXIST") return undefined
    throw error
  })
  if (handle) {
    await handle.writeFile(`${JSON.stringify(generated)}\n`, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
  }
  await chmod(filename, 0o600)
  return decodeKeyFile(await readFile(filename, "utf8"))
}

function decodeSecret(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid token key encoding")
  const secret = Buffer.from(value, "base64url")
  if (secret.toString("base64url") !== value || secret.byteLength !== 32) throw new Error("invalid token key")
  return secret
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}
