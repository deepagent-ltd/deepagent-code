import path from "path"
import fs from "fs/promises"
import { xdgData, xdgConfig } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { resolveDataPath, resolveHomeBase } from "./global-path"

const app = "deepagent-code"
const legacyData = path.join(xdgData!, app)
const config = path.join(xdgConfig!, app)
const tmp = path.join(os.tmpdir(), app)

// P2-F single storage-root source: delegate to the shared pure resolver (global-path.ts) so the
// control-plane resolver (deepagent/workspace.ts) computes the identical root for every env.
const homePath = () => resolveHomeBase(process.env)
const dataPath = () => resolveDataPath(process.env)
const cachePath = () => path.join(dataPath(), "cache")
const statePath = () => path.join(dataPath(), "state")
const overrides: { log?: string } = {}

const paths = {
  get home() {
    return homePath()
  },
  get data() {
    return dataPath()
  },
  get bin() {
    return path.join(cachePath(), "bin")
  },
  get log() {
    return overrides.log ?? path.join(dataPath(), "log")
  },
  set log(value: string) {
    overrides.log = value
  },
  get repos() {
    return path.join(dataPath(), "repos")
  },
  get cache() {
    return cachePath()
  },
  config,
  get state() {
    return statePath()
  },
  tmp,
  get agent() {
    return {
      data: dataPath(),
      cache: path.join(cachePath(), "agent"),
      state: statePath(),
      tmp: path.join(tmp, "agent"),
      runs: path.join(dataPath(), "runs"),
      artifacts: path.join(dataPath(), "artifacts"),
      output: path.join(dataPath(), "output"),
      log: path.join(dataPath(), "log"),
    }
  },
}

export const Path = paths

Flock.setGlobal({ state: Path.state })

async function migrateLegacyData() {
  if (path.resolve(legacyData) === path.resolve(Path.data)) return
  const entries = await fs.readdir(legacyData, { withFileTypes: true }).catch(() => [])
  if (entries.length === 0) return
  await fs.mkdir(Path.data, { recursive: true })
  await Promise.all(
    entries
      .filter((entry) => entry.name !== "agent")
      .map((entry) =>
        fs.cp(path.join(legacyData, entry.name), path.join(Path.data, entry.name), {
          recursive: true,
          force: false,
          errorOnExist: false,
        }),
      ),
  )
  await Promise.all(
    [
      [path.join(legacyData, "agent", "runs"), Path.agent.runs],
      [path.join(legacyData, "agent", "memory"), path.join(Path.agent.data, "memory")],
      [path.join(legacyData, "agent", "state"), Path.agent.state],
      [path.join(legacyData, "agent", "artifacts"), Path.agent.artifacts],
      [path.join(legacyData, "agent", "output"), Path.agent.output],
      [path.join(legacyData, "agent", "log"), Path.agent.log],
    ].map(([source, target]) =>
      fs.cp(source, target, { recursive: true, force: false, errorOnExist: false }).catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
        throw error
      }),
    ),
  )
}

await migrateLegacyData()

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
  fs.mkdir(Path.agent.data, { recursive: true }),
  fs.mkdir(Path.agent.cache, { recursive: true }),
  fs.mkdir(Path.agent.state, { recursive: true }),
  fs.mkdir(Path.agent.tmp, { recursive: true }),
  fs.mkdir(Path.agent.runs, { recursive: true }),
  fs.mkdir(Path.agent.artifacts, { recursive: true }),
  fs.mkdir(Path.agent.output, { recursive: true }),
  fs.mkdir(Path.agent.log, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
  readonly agent: {
    readonly data: string
    readonly cache: string
    readonly state: string
    readonly tmp: string
    readonly runs: string
    readonly artifacts: string
    readonly output: string
    readonly log: string
  }
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.DEEPAGENT_CODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    agent: Path.agent,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
