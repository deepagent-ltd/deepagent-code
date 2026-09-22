import path from "path"
import fs from "fs/promises"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { platformConfigHome, platformDataHome, resolveHomeBase } from "./global-path"
import { migrateLegacyHomeIfNeeded } from "./global-migrate"
import { makeGlobalNode } from "./effect/app-node"

const homePath = () => resolveHomeBase(process.env)
// D-W1 split: data/cache/worktree/snapshot stay machine-local; config + credentials roam. The two
// homes coincide on every non-win32 platform (both are ~/.deepagent/code), so POSIX is unchanged.
const dataPath = () => path.resolve(platformDataHome(process.env))
const configPath = () => path.resolve(platformConfigHome(process.env))
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

// One-time win32 move of the pre-split unified root (~/.deepagent/code) into the platform homes.
// No-op elsewhere; must run before the mkdir block below so a migrated tree is not recreated.
await migrateLegacyHomeIfNeeded(process.env)

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
  /** Machine-local data home (win32: %LOCALAPPDATA%\deepagent-code; elsewhere ~/.deepagent/code). */
  readonly data: string
  readonly cache: string
  /** Roaming config home (win32: %APPDATA%\deepagent-code; elsewhere identical to `data`). Holds user config files and credential stores. */
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
