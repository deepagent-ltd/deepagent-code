import path from "path"
import fs from "fs/promises"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { resolveDataPath, resolveHomeBase } from "./global-path"
import { makeGlobalNode } from "./effect/app-node"

const homePath = () => resolveHomeBase(process.env)
const dataPath = () => resolveDataPath(process.env)
const configPath = () => dataPath()
const cachePath = () => path.join(dataPath(), "cache")
const statePath = () => path.join(dataPath(), "state")
const tmpPath = () => path.join(dataPath(), "tmp")
const testOverrides: { config?: string; log?: string } = {}

function setTestOverride(name: "config" | "log", value: string) {
  if (!process.env.DEEPAGENT_CODE_TEST_HOME) throw new Error(`Global.Path.${name} is immutable outside tests`)
  testOverrides[name] = value
}

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
    return testOverrides.log ?? path.join(dataPath(), "log")
  },
  set log(value: string) {
    setTestOverride("log", value)
  },
  get repos() {
    return path.join(dataPath(), "repos")
  },
  get cache() {
    return cachePath()
  },
  get config() {
    return testOverrides.config ?? configPath()
  },
  set config(value: string) {
    setTestOverride("config", value)
  },
  get state() {
    return statePath()
  },
  get tmp() {
    return tmpPath()
  },
  get agent() {
    return {
      data: dataPath(),
      cache: path.join(cachePath(), "agent"),
      state: statePath(),
      tmp: path.join(tmpPath(), "agent"),
      runs: path.join(dataPath(), "runs"),
      artifacts: path.join(dataPath(), "artifacts"),
      output: path.join(dataPath(), "output"),
      log: path.join(dataPath(), "log"),
    }
  },
}

export const Path = paths

Flock.setGlobal({ state: Path.state })

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
    config: Path.config,
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

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
